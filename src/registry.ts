import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ENVELOPE_VERSION, parseEnvelope, type Envelope } from './envelope.ts'
import { configHome, platformContext, run, which, type PlatformContext } from './platform.ts'
import { satisfiesMinimum } from './semver.ts'

export const REGISTRY_ENV_VAR = 'KIT_REGISTRY_DIR'
export const MANIFEST_VERSION = 1
const TOOL_NAME = /^[a-z][a-z0-9-]{0,39}$/

export interface EventFilter {
  [attribute: string]: string[]
}

export interface Subscription {
  tool: string
  events: string[]
  filter?: EventFilter
  command: string[]
}

export interface McpEndpoints {
  stdio?: string[]
  http?: string
}

export interface ToolManifest {
  manifestVersion: number
  name: string
  version: string
  description?: string
  bin: string[]
  envelope: number
  capabilities: string[]
  emits: string[]
  subscribes: Subscription[]
  mcp?: McpEndpoints
  homepage?: string
  install?: string
  installedAt?: string
}

export interface ToolCapabilities {
  name: string
  version: string
  envelope: number
  capabilities: string[]
  emits: string[]
}

export function registryDir(ctx: PlatformContext = platformContext()): string {
  const override = ctx.env[REGISTRY_ENV_VAR]
  if (override) return override
  return (ctx.platform === 'win32' ? path.win32 : path.posix).join(configHome(ctx), 'kikedealba', 'tools.d')
}

export function manifestPath(name: string, ctx: PlatformContext = platformContext()): string {
  return path.join(registryDir(ctx), `${name}.json`)
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

export function validateManifest(value: unknown): string[] {
  const problems: string[] = []
  if (typeof value !== 'object' || value === null) return ['manifest is not an object']
  const m = value as Record<string, unknown>
  if (m['manifestVersion'] !== MANIFEST_VERSION) problems.push(`manifestVersion must be ${MANIFEST_VERSION}`)
  if (typeof m['name'] !== 'string' || !TOOL_NAME.test(m['name'])) problems.push('name must be lowercase letters, digits and dashes')
  if (typeof m['version'] !== 'string' || !/^\d+\.\d+\.\d+/.test(m['version'])) problems.push('version must be semver')
  if (!stringArray(m['bin']) || m['bin'].length === 0) problems.push('bin must be a non-empty string array')
  if (typeof m['envelope'] !== 'number') problems.push('envelope must be a number')
  if (!stringArray(m['capabilities'])) problems.push('capabilities must be a string array')
  if (!stringArray(m['emits'])) problems.push('emits must be a string array')
  if (!Array.isArray(m['subscribes'])) {
    problems.push('subscribes must be an array')
  } else {
    m['subscribes'].forEach((raw, index) => {
      const s = raw as Record<string, unknown>
      if (typeof s !== 'object' || s === null) return problems.push(`subscribes[${index}] is not an object`)
      if (typeof s['tool'] !== 'string') problems.push(`subscribes[${index}].tool must be a string`)
      if (!stringArray(s['events']) || s['events'].length === 0) problems.push(`subscribes[${index}].events must be a non-empty string array`)
      if (!stringArray(s['command']) || s['command'].length === 0) problems.push(`subscribes[${index}].command must be a non-empty string array`)
      if (s['filter'] !== undefined) {
        const filter = s['filter'] as Record<string, unknown>
        if (typeof filter !== 'object' || filter === null || !Object.values(filter).every(stringArray)) {
          problems.push(`subscribes[${index}].filter must map attributes to string arrays`)
        }
      }
      return undefined
    })
  }
  if (m['mcp'] !== undefined) {
    const mcp = m['mcp'] as Record<string, unknown>
    if (typeof mcp !== 'object' || mcp === null) problems.push('mcp must be an object')
    else {
      if (mcp['stdio'] !== undefined && !stringArray(mcp['stdio'])) problems.push('mcp.stdio must be a string array')
      if (mcp['http'] !== undefined && typeof mcp['http'] !== 'string') problems.push('mcp.http must be a string')
    }
  }
  return problems
}

export function defineManifest(input: Omit<ToolManifest, 'manifestVersion' | 'envelope' | 'emits' | 'subscribes'> & Partial<Pick<ToolManifest, 'envelope' | 'emits' | 'subscribes'>>): ToolManifest {
  return {
    manifestVersion: MANIFEST_VERSION,
    envelope: ENVELOPE_VERSION,
    emits: [],
    subscribes: [],
    ...input,
  }
}

export async function registerTool(manifest: ToolManifest, ctx: PlatformContext = platformContext()): Promise<string> {
  const problems = validateManifest(manifest)
  if (problems.length > 0) throw new Error(`Invalid manifest for ${manifest.name}: ${problems.join('; ')}`)
  const dir = registryDir(ctx)
  await mkdir(dir, { recursive: true })
  const target = path.join(dir, `${manifest.name}.json`)
  const temporary = `${target}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify({ ...manifest, installedAt: new Date().toISOString() }, null, 2)}\n`)
  await rename(temporary, target)
  return target
}

export async function unregisterTool(name: string, ctx: PlatformContext = platformContext()): Promise<boolean> {
  const target = manifestPath(name, ctx)
  if (!existsSync(target)) return false
  await rm(target)
  return true
}

export async function readManifest(name: string, ctx: PlatformContext = platformContext()): Promise<ToolManifest | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(manifestPath(name, ctx), 'utf8'))
    return validateManifest(parsed).length === 0 ? (parsed as ToolManifest) : null
  } catch {
    return null
  }
}

export async function listTools(ctx: PlatformContext = platformContext()): Promise<ToolManifest[]> {
  let names: string[]
  try {
    names = await readdir(registryDir(ctx))
  } catch {
    return []
  }
  const tools: ToolManifest[] = []
  for (const file of names.sort()) {
    if (!file.endsWith('.json')) continue
    const manifest = await readManifest(file.slice(0, -'.json'.length), ctx)
    if (manifest) tools.push(manifest)
  }
  return tools
}

export function isInstalled(manifest: ToolManifest): boolean {
  return manifest.bin.every((part) => !path.isAbsolute(part) || existsSync(part))
}

export interface FindOptions {
  capability?: string | string[]
  minVersion?: string
  verify?: boolean
}

export interface FoundTool {
  manifest: ToolManifest
  bin: string[]
}

export async function findTool(name: string, options: FindOptions = {}, ctx: PlatformContext = platformContext()): Promise<FoundTool | null> {
  const manifest = await readManifest(name, ctx)
  if (!manifest || !isInstalled(manifest)) return null
  let current: ToolManifest = manifest
  if (options.verify) {
    const live = await probeCapabilities(manifest.bin, ctx)
    if (!live) return null
    current = { ...manifest, version: live.version, capabilities: live.capabilities, emits: live.emits }
  }
  if (!satisfiesMinimum(current.version, options.minVersion)) return null
  const wanted = options.capability === undefined ? [] : Array.isArray(options.capability) ? options.capability : [options.capability]
  if (!wanted.every((capability) => current.capabilities.includes(capability))) return null
  return { manifest: current, bin: current.bin }
}

export async function findByCapability(capability: string, ctx: PlatformContext = platformContext()): Promise<FoundTool[]> {
  return (await listTools(ctx))
    .filter((manifest) => isInstalled(manifest) && manifest.capabilities.includes(capability))
    .map((manifest) => ({ manifest, bin: manifest.bin }))
}

export async function probeCapabilities(bin: readonly string[], ctx: PlatformContext = platformContext()): Promise<ToolCapabilities | null> {
  const [command, ...prefix] = bin
  if (!command) return null
  try {
    const { stdout } = await run(command, [...prefix, 'capabilities', '--json'], { env: ctx.env, timeoutMs: 15_000 })
    const envelope = parseEnvelope(stdout)
    if (!envelope?.ok) return null
    return readCapabilities(envelope)
  } catch {
    return null
  }
}

export function readCapabilities(envelope: Envelope): ToolCapabilities | null {
  const data = envelope.data as Record<string, unknown> | undefined
  if (typeof data !== 'object' || data === null) return null
  if (typeof data['name'] !== 'string' || typeof data['version'] !== 'string') return null
  if (!stringArray(data['capabilities'])) return null
  return {
    name: data['name'],
    version: data['version'],
    envelope: typeof data['envelope'] === 'number' ? data['envelope'] : ENVELOPE_VERSION,
    capabilities: data['capabilities'],
    emits: stringArray(data['emits']) ? data['emits'] : [],
  }
}

export function capabilitiesOf(manifest: ToolManifest): ToolCapabilities {
  return {
    name: manifest.name,
    version: manifest.version,
    envelope: manifest.envelope,
    capabilities: manifest.capabilities,
    emits: manifest.emits,
  }
}

export interface InvokeResult<T> {
  envelope: Envelope<T>
  stdout: string
  stderr: string
}

export async function invokeTool<T = unknown>(
  tool: FoundTool,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number; cwd?: string } = {},
): Promise<InvokeResult<T>> {
  const [command, ...prefix] = tool.bin
  if (!command) throw new Error(`${tool.manifest.name} has no binary`)
  const withJson = args.includes('--json') ? [...args] : [...args, '--json']
  let stdout = ''
  let stderr = ''
  try {
    const result = await run(command, [...prefix, ...withJson], {
      ...(options.env ? { env: options.env } : {}),
      ...(options.input !== undefined ? { input: options.input } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      timeoutMs: options.timeoutMs ?? 120_000,
    })
    stdout = result.stdout
    stderr = result.stderr
  } catch (error) {
    stdout = String((error as { stdout?: unknown }).stdout ?? '')
    stderr = String((error as { stderr?: unknown }).stderr ?? '')
    if (!parseEnvelope(stdout)) throw error
  }
  const envelope = parseEnvelope(stdout)
  if (!envelope) throw new Error(`${tool.manifest.name} did not answer with a JSON envelope: ${stderr.trim().split('\n')[0] ?? ''}`)
  return { envelope: envelope as Envelope<T>, stdout, stderr }
}

export class ToolMissingError extends Error {
  readonly code: string
  readonly hint: string
  constructor(name: string, hint: string, requirement?: string) {
    super(`${name} is not installed${requirement ? ` (${requirement})` : ''}.`)
    this.name = 'ToolMissingError'
    this.code = `${name.toUpperCase().replace(/-/g, '_')}_MISSING`
    this.hint = hint
  }
}

export async function requireTool(name: string, hint: string, options: FindOptions = {}, ctx: PlatformContext = platformContext()): Promise<FoundTool> {
  const found = await findTool(name, options, ctx)
  if (found) return found
  const parts = [options.minVersion ? `>= ${options.minVersion}` : null, options.capability ? `with ${[options.capability].flat().join(', ')}` : null].filter(Boolean)
  throw new ToolMissingError(name, hint, parts.length > 0 ? parts.join(' ') : undefined)
}

export async function stableBin(name: string, version: string, fallback: readonly string[], ctx: PlatformContext = platformContext()): Promise<string[]> {
  const onPath = await which(name, ctx)
  if (!onPath) return [...fallback]
  const live = await probeCapabilities([onPath], ctx)
  return live !== null && live.name === name && live.version === version ? [onPath] : [...fallback]
}
