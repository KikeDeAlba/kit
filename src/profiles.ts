import { existsSync } from 'node:fs'
import { chmod, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { linkPath } from './agents/files.ts'
import { findAgentBinary } from './agents/binaries.ts'
import { writeFileAtomic } from './atomic.ts'
import { withoutHarnessSession } from './harness/env.ts'
import type { HarnessId } from './harness/types.ts'
import { kitConfigRoot, platformContext, run, type PlatformContext } from './platform.ts'

export const PROFILES_VERSION = 1
export const PROFILE_ENV = 'DEN_PROFILE'
export const PROFILE_HARNESSES = ['claude', 'codex'] as const
export type ProfileHarness = (typeof PROFILE_HARNESSES)[number]
export const PROFILE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
export const PROFILES_SCHEMA_URL = 'https://raw.githubusercontent.com/KikeDeAlba/kit/main/schemas/profiles.v1.json'
export const PROFILE_HOME_ENV: Record<ProfileHarness, string> = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' }
export const PROFILE_SECRET_ENV: readonly string[] = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY']

export interface Profile {
  name: string
  builtin: boolean
  claude: string | null
  codex: string | null
  createdAt: string | null
}

export interface DirMapping {
  path: string
  profile: string
}

export interface ProfilesFile {
  version: 1
  default: string
  profiles: Record<string, Omit<Profile, 'name'>>
  dirs: DirMapping[]
}

export type ProfileErrorCode =
  | 'PROFILES_INVALID'
  | 'PROFILE_NOT_FOUND'
  | 'PROFILE_INVALID_NAME'
  | 'PROFILE_BUILTIN'
  | 'PROFILE_IS_DEFAULT'
  | 'PROFILE_UNSUPPORTED_HARNESS'

export class ProfileError extends Error {
  readonly code: ProfileErrorCode

  constructor(code: ProfileErrorCode, message: string) {
    super(message)
    this.name = 'ProfileError'
    this.code = code
  }
}

function pathApi(ctx: PlatformContext): path.PlatformPath {
  return ctx.platform === 'win32' ? path.win32 : path.posix
}

export function profilesPath(ctx: PlatformContext = platformContext()): string {
  return pathApi(ctx).join(kitConfigRoot(ctx), 'profiles.json')
}

export function profileHomes(name: string, ctx: PlatformContext = platformContext()): { root: string; claude: string; codex: string } {
  const p = pathApi(ctx)
  const root = p.join(kitConfigRoot(ctx), 'profiles', name)
  return { root, claude: p.join(root, 'claude'), codex: p.join(root, 'codex') }
}

export function tildePath(value: string, ctx: PlatformContext = platformContext()): string {
  const p = pathApi(ctx)
  const home = p.resolve(ctx.home)
  const resolved = p.resolve(value)
  if (resolved === home) return '~'
  const relative = p.relative(home, resolved)
  if (relative.length === 0 || relative.startsWith('..') || p.isAbsolute(relative)) return value
  return `~/${relative.split(p.sep).join('/')}`
}

export function expandPath(value: string, ctx: PlatformContext = platformContext()): string {
  const p = pathApi(ctx)
  if (value === '~') return ctx.home
  if (value.startsWith('~/') || value.startsWith('~\\')) return p.join(ctx.home, ...value.slice(2).split(/[\\/]/))
  return value
}

function emptyFile(): ProfilesFile {
  return { version: 1, default: 'default', profiles: { default: { builtin: true, claude: null, codex: null, createdAt: null } }, dirs: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(file: string, problem: string): ProfileError {
  return new ProfileError('PROFILES_INVALID', `${file} is invalid: ${problem}`)
}

export function parseProfiles(raw: unknown, ctx: PlatformContext = platformContext(), file: string = profilesPath(ctx)): ProfilesFile {
  if (!isRecord(raw)) throw invalid(file, 'not a JSON object')
  if (raw['version'] !== PROFILES_VERSION) throw invalid(file, `version must be ${PROFILES_VERSION}`)
  if (!isRecord(raw['profiles'])) throw invalid(file, 'profiles must be an object')
  const profiles: Record<string, Omit<Profile, 'name'>> = {}
  let builtins = 0
  for (const [name, entry] of Object.entries(raw['profiles'])) {
    if (!PROFILE_NAME_PATTERN.test(name)) throw invalid(file, `profile name "${name}" does not match ${PROFILE_NAME_PATTERN.source}`)
    if (!isRecord(entry)) throw invalid(file, `profile "${name}" must be an object`)
    const builtin = entry['builtin'] === true
    const createdAt = typeof entry['createdAt'] === 'string' ? entry['createdAt'] : null
    if (builtin) {
      builtins += 1
      if (entry['claude'] !== undefined && entry['claude'] !== null) throw invalid(file, `builtin profile "${name}" cannot set claude`)
      if (entry['codex'] !== undefined && entry['codex'] !== null) throw invalid(file, `builtin profile "${name}" cannot set codex`)
      profiles[name] = { builtin: true, claude: null, codex: null, createdAt }
      continue
    }
    const claude = entry['claude']
    const codex = entry['codex']
    if (typeof claude !== 'string' || claude.length === 0) throw invalid(file, `profile "${name}" needs a claude directory`)
    if (typeof codex !== 'string' || codex.length === 0) throw invalid(file, `profile "${name}" needs a codex directory`)
    profiles[name] = { builtin: false, claude: expandPath(claude, ctx), codex: expandPath(codex, ctx), createdAt }
  }
  if (builtins !== 1) throw invalid(file, `exactly one profile must be builtin, found ${builtins}`)
  const fallback = raw['default']
  if (typeof fallback !== 'string' || !(fallback in profiles)) throw invalid(file, 'default must name an existing profile')
  const dirs: DirMapping[] = []
  const rawDirs = raw['dirs'] ?? []
  if (!Array.isArray(rawDirs)) throw invalid(file, 'dirs must be an array')
  for (const mapping of rawDirs) {
    if (!isRecord(mapping) || typeof mapping['path'] !== 'string' || typeof mapping['profile'] !== 'string') throw invalid(file, 'each dirs entry needs path and profile')
    if (!(mapping['profile'] in profiles)) throw invalid(file, `dirs entry ${mapping['path']} points to unknown profile "${mapping['profile']}"`)
    const expanded = expandPath(mapping['path'], ctx)
    if (!pathApi(ctx).isAbsolute(expanded)) throw invalid(file, `dirs entry ${mapping['path']} is not absolute`)
    dirs.push({ path: expanded, profile: mapping['profile'] })
  }
  return { version: 1, default: fallback, profiles, dirs }
}

export function serializeProfiles(data: ProfilesFile, ctx: PlatformContext = platformContext()): Record<string, unknown> {
  const profiles: Record<string, Record<string, unknown>> = {}
  for (const [name, profile] of Object.entries(data.profiles)) {
    if (profile.builtin) profiles[name] = profile.createdAt ? { builtin: true, createdAt: profile.createdAt } : { builtin: true }
    else {
      profiles[name] = {
        claude: profile.claude === null ? null : tildePath(profile.claude, ctx),
        codex: profile.codex === null ? null : tildePath(profile.codex, ctx),
        ...(profile.createdAt ? { createdAt: profile.createdAt } : {}),
      }
    }
  }
  return {
    $schema: PROFILES_SCHEMA_URL,
    version: PROFILES_VERSION,
    default: data.default,
    profiles,
    dirs: data.dirs.map((mapping) => ({ path: tildePath(mapping.path, ctx), profile: mapping.profile })),
  }
}

export async function readProfiles(ctx: PlatformContext = platformContext()): Promise<ProfilesFile> {
  const file = profilesPath(ctx)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyFile()
    throw invalid(file, error instanceof Error ? error.message : String(error))
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw invalid(file, `not valid JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  return parseProfiles(raw, ctx, file)
}

async function writeProfiles(data: ProfilesFile, ctx: PlatformContext): Promise<void> {
  await writeFileAtomic(profilesPath(ctx), `${JSON.stringify(serializeProfiles(data, ctx), null, 2)}\n`, { mode: 0o600 })
}

function toProfile(name: string, entry: Omit<Profile, 'name'>): Profile {
  return { name, builtin: entry.builtin, claude: entry.claude, codex: entry.codex, createdAt: entry.createdAt }
}

function requireProfile(data: ProfilesFile, name: string): Profile {
  const entry = data.profiles[name]
  if (!entry) throw new ProfileError('PROFILE_NOT_FOUND', `profile "${name}" does not exist`)
  return toProfile(name, entry)
}

function checkName(name: string): void {
  if (!PROFILE_NAME_PATTERN.test(name)) throw new ProfileError('PROFILE_INVALID_NAME', `profile name "${name}" must match ${PROFILE_NAME_PATTERN.source}`)
}

export async function listProfiles(ctx: PlatformContext = platformContext()): Promise<{ default: string; profiles: Profile[]; dirs: DirMapping[] }> {
  const data = await readProfiles(ctx)
  return { default: data.default, profiles: Object.entries(data.profiles).map(([name, entry]) => toProfile(name, entry)), dirs: data.dirs }
}

export async function getProfile(name: string, ctx: PlatformContext = platformContext()): Promise<Profile> {
  return requireProfile(await readProfiles(ctx), name)
}

async function realOrResolved(dir: string): Promise<string> {
  try {
    return await realpath(dir)
  } catch {
    return path.resolve(dir)
  }
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function depth(dir: string): number {
  return path.resolve(dir).split(path.sep).filter((part) => part.length > 0).length
}

export interface ResolveInput {
  cwd?: string
  explicit?: string | null
}

export interface ResolvedProfile {
  profile: Profile
  source: 'explicit' | 'env' | 'dir' | 'default'
}

export async function resolveProfile(input: ResolveInput = {}, ctx: PlatformContext = platformContext()): Promise<ResolvedProfile> {
  const data = await readProfiles(ctx)
  if (input.explicit) return { profile: requireProfile(data, input.explicit), source: 'explicit' }
  const fromEnv = ctx.env[PROFILE_ENV]
  if (fromEnv) return { profile: requireProfile(data, fromEnv), source: 'env' }
  if (data.dirs.length > 0) {
    const cwd = await realOrResolved(input.cwd ?? process.cwd())
    let best: { mapping: DirMapping; depth: number } | null = null
    for (const mapping of data.dirs) {
      const real = await realOrResolved(mapping.path)
      if (!isWithin(cwd, real)) continue
      const level = depth(real)
      if (!best || level > best.depth) best = { mapping, depth: level }
    }
    if (best) return { profile: requireProfile(data, best.mapping.profile), source: 'dir' }
  }
  return { profile: requireProfile(data, data.default), source: 'default' }
}

export function profileSupports(harness: HarnessId): harness is ProfileHarness {
  return (PROFILE_HARNESSES as readonly string[]).includes(harness)
}

function deleteKey(env: NodeJS.ProcessEnv, name: string): void {
  for (const key of Object.keys(env)) if (key.toUpperCase() === name) delete env[key]
}

export function envFor(profile: Profile, harness: HarnessId | 'all', baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = withoutHarnessSession(baseEnv)
  for (const name of Object.values(PROFILE_HOME_ENV)) deleteKey(env, name)
  if (!profile.builtin && (harness === 'all' || profileSupports(harness))) {
    for (const name of PROFILE_SECRET_ENV) deleteKey(env, name)
    if ((harness === 'claude' || harness === 'all') && profile.claude) env[PROFILE_HOME_ENV.claude] = profile.claude
    if ((harness === 'codex' || harness === 'all') && profile.codex) env[PROFILE_HOME_ENV.codex] = profile.codex
  }
  env[PROFILE_ENV] = profile.name
  return env
}

export function profileHome(profile: Profile, harness: HarnessId): string | null {
  if (!profileSupports(harness)) throw new ProfileError('PROFILE_UNSUPPORTED_HARNESS', `${harness} uses a single account; profiles apply only to ${PROFILE_HARNESSES.join(' and ')}`)
  return profile[harness]
}

async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
}

async function ensureProfileDirs(profile: Profile, ctx: PlatformContext): Promise<void> {
  if (profile.builtin) return
  const homes = profileHomes(profile.name, ctx)
  const claude = profile.claude ?? homes.claude
  const codex = profile.codex ?? homes.codex
  const nested = isWithin(claude, homes.root) || isWithin(codex, homes.root)
  for (const dir of nested ? [homes.root, claude, codex] : [claude, codex]) await ensurePrivateDir(dir)
}

export async function addProfile(name: string, ctx: PlatformContext = platformContext()): Promise<{ profile: Profile; created: boolean }> {
  checkName(name)
  const data = await readProfiles(ctx)
  const existing = data.profiles[name]
  if (existing) {
    const profile = toProfile(name, existing)
    await ensureProfileDirs(profile, ctx)
    return { profile, created: false }
  }
  const homes = profileHomes(name, ctx)
  const profile: Profile = { name, builtin: false, claude: homes.claude, codex: homes.codex, createdAt: new Date().toISOString() }
  await ensureProfileDirs(profile, ctx)
  data.profiles[name] = { builtin: false, claude: profile.claude, codex: profile.codex, createdAt: profile.createdAt }
  await writeProfiles(data, ctx)
  return { profile, created: true }
}

export async function renameBuiltinProfile(name: string, ctx: PlatformContext = platformContext()): Promise<Profile> {
  checkName(name)
  const data = await readProfiles(ctx)
  const current = Object.entries(data.profiles).find(([, entry]) => entry.builtin)
  if (!current) throw invalid(profilesPath(ctx), 'no builtin profile')
  const [previous, entry] = current
  if (previous === name) return toProfile(name, entry)
  if (data.profiles[name]) throw new ProfileError('PROFILE_INVALID_NAME', `profile "${name}" already exists`)
  const profiles: Record<string, Omit<Profile, 'name'>> = {}
  for (const [key, value] of Object.entries(data.profiles)) profiles[key === previous ? name : key] = value
  data.profiles = profiles
  if (data.default === previous) data.default = name
  data.dirs = data.dirs.map((mapping) => (mapping.profile === previous ? { ...mapping, profile: name } : mapping))
  await writeProfiles(data, ctx)
  return toProfile(name, entry)
}

export async function removeProfile(
  name: string,
  options: { purge?: boolean } = {},
  ctx: PlatformContext = platformContext(),
): Promise<{ removed: boolean; purged: boolean; unmapped: string[] }> {
  const data = await readProfiles(ctx)
  const profile = requireProfile(data, name)
  if (profile.builtin) throw new ProfileError('PROFILE_BUILTIN', `profile "${name}" is the builtin profile and cannot be removed`)
  if (data.default === name) throw new ProfileError('PROFILE_IS_DEFAULT', `profile "${name}" is the default; choose another default first`)
  const unmapped = data.dirs.filter((mapping) => mapping.profile === name).map((mapping) => mapping.path)
  data.dirs = data.dirs.filter((mapping) => mapping.profile !== name)
  delete data.profiles[name]
  await writeProfiles(data, ctx)
  let purged = false
  if (options.purge) {
    await rm(profileHomes(name, ctx).root, { recursive: true, force: true })
    purged = true
  }
  return { removed: true, purged, unmapped }
}

export async function setDefaultProfile(name: string, ctx: PlatformContext = platformContext()): Promise<void> {
  const data = await readProfiles(ctx)
  requireProfile(data, name)
  if (data.default === name) return
  data.default = name
  await writeProfiles(data, ctx)
}

export async function mapDir(dir: string, name: string, ctx: PlatformContext = platformContext()): Promise<DirMapping> {
  const data = await readProfiles(ctx)
  requireProfile(data, name)
  const resolved = await realOrResolved(dir)
  const mapping: DirMapping = { path: resolved, profile: name }
  const others: DirMapping[] = []
  for (const existing of data.dirs) {
    if ((await realOrResolved(existing.path)) !== resolved) others.push(existing)
  }
  data.dirs = [...others, mapping]
  await writeProfiles(data, ctx)
  return mapping
}

export async function unmapDir(dir: string, ctx: PlatformContext = platformContext()): Promise<boolean> {
  const data = await readProfiles(ctx)
  const resolved = await realOrResolved(dir)
  const kept: DirMapping[] = []
  for (const existing of data.dirs) {
    if ((await realOrResolved(existing.path)) !== resolved) kept.push(existing)
  }
  if (kept.length === data.dirs.length) return false
  data.dirs = kept
  await writeProfiles(data, ctx)
  return true
}

export interface SharedLinkSpec {
  harness: ProfileHarness
  name: string
  kind: 'file' | 'dir'
}

export const SHARED_LINKS: readonly SharedLinkSpec[] = [
  { harness: 'claude', name: 'CLAUDE.md', kind: 'file' },
  { harness: 'claude', name: 'settings.json', kind: 'file' },
  { harness: 'claude', name: 'skills', kind: 'dir' },
  { harness: 'claude', name: 'agents', kind: 'dir' },
  { harness: 'claude', name: 'commands', kind: 'dir' },
  { harness: 'codex', name: 'AGENTS.md', kind: 'file' },
  { harness: 'codex', name: 'config.toml', kind: 'file' },
]

export type SharedLinkState = 'linked' | 'missing' | 'replaced' | 'foreign'

export interface SharedLink extends SharedLinkSpec {
  path: string
  target: string
  state: SharedLinkState
}

export interface SharedLinkRepair extends SharedLink {
  previous: SharedLinkState
  merged: string[]
  backup: string | null
}

export function sharedHomes(ctx: PlatformContext = platformContext()): Record<ProfileHarness, string> {
  const p = pathApi(ctx)
  return { claude: p.join(ctx.home, '.claude'), codex: p.join(ctx.home, '.codex') }
}

async function linkState(linkName: string, target: string): Promise<SharedLinkState> {
  const info = await lstat(linkName).catch(() => null)
  if (!info) return 'missing'
  if (!info.isSymbolicLink()) return 'replaced'
  const pointed = path.resolve(path.dirname(linkName), await readlink(linkName))
  if (pointed === path.resolve(target)) return 'linked'
  const [left, right] = await Promise.all([realOrResolved(pointed), realOrResolved(target)])
  return left === right ? 'linked' : 'foreign'
}

function linkSpecs(profile: Profile, ctx: PlatformContext): { spec: SharedLinkSpec; path: string; target: string }[] {
  if (profile.builtin) return []
  const shared = sharedHomes(ctx)
  return SHARED_LINKS.flatMap((spec) => {
    const home = profile[spec.harness]
    if (!home) return []
    return [{ spec, path: path.join(home, spec.name), target: path.join(shared[spec.harness], spec.name) }]
  })
}

export async function inspectSharedLinks(name: string, ctx: PlatformContext = platformContext()): Promise<SharedLink[]> {
  const profile = await getProfile(name, ctx)
  const links: SharedLink[] = []
  for (const { spec, path: linkName, target } of linkSpecs(profile, ctx)) {
    links.push({ ...spec, path: linkName, target, state: await linkState(linkName, target) })
  }
  return links
}

async function ensureSharedTarget(spec: SharedLinkSpec, target: string): Promise<void> {
  if (existsSync(target)) return
  if (spec.kind === 'dir') {
    await mkdir(target, { recursive: true })
    return
  }
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, spec.name.endsWith('.json') ? '{}\n' : '', { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })
}

export function mergeMissingJson(shared: Record<string, unknown>, local: Record<string, unknown>, prefix = ''): string[] {
  const added: string[] = []
  for (const [key, value] of Object.entries(local)) {
    const where = prefix ? `${prefix}.${key}` : key
    if (!(key in shared)) {
      shared[key] = value
      added.push(where)
      continue
    }
    const current = shared[key]
    if (isRecord(current) && isRecord(value)) added.push(...mergeMissingJson(current, value, where))
  }
  return added
}

interface TomlSection {
  header: string
  lines: string[]
  entries: Map<string, string[]>
}

const TOML_HEADER = /^\s*(\[\[?[^\]]+\]\]?)\s*(?:#.*)?$/
const TOML_KEY = /^\s*("[^"]*"|'[^']*'|[A-Za-z0-9_.-]+)\s*=/

function parseTomlSections(text: string): TomlSection[] {
  const sections: TomlSection[] = [{ header: '', lines: [], entries: new Map() }]
  let entry: string[] | null = null
  for (const line of text.split('\n')) {
    const header = TOML_HEADER.exec(line)
    if (header) {
      sections.push({ header: (header[1] ?? '').replace(/\s+/g, ''), lines: [line], entries: new Map() })
      entry = null
      continue
    }
    const section = sections[sections.length - 1] as TomlSection
    section.lines.push(line)
    const key = TOML_KEY.exec(line)
    if (key) {
      entry = [line]
      if (!section.entries.has(key[1] as string)) section.entries.set(key[1] as string, entry)
    } else if (entry && line.trim().length > 0 && !line.trim().startsWith('#')) entry.push(line)
    else entry = null
  }
  return sections
}

function trimTrailingBlank(lines: string[]): { body: string[]; tail: string[] } {
  let end = lines.length
  while (end > 0 && (lines[end - 1] ?? '').trim().length === 0) end -= 1
  return { body: lines.slice(0, end), tail: lines.slice(end) }
}

export function mergeMissingToml(sharedText: string, localText: string): { text: string; added: string[] } {
  const shared = parseTomlSections(sharedText)
  const local = parseTomlSections(localText)
  const added: string[] = []
  const appended: string[][] = []
  for (const section of local) {
    const match = shared.find((candidate) => candidate.header === section.header)
    if (!match) {
      appended.push(trimTrailingBlank(section.lines).body)
      added.push(section.header)
      continue
    }
    if (section.header.startsWith('[[')) continue
    for (const [key, lines] of section.entries) {
      if (match.entries.has(key)) continue
      const { body, tail } = trimTrailingBlank(match.lines)
      match.lines = [...body, ...lines, ...tail]
      match.entries.set(key, lines)
      added.push(section.header ? `${section.header.slice(1, -1)}.${key}` : key)
    }
  }
  if (added.length === 0) return { text: sharedText, added }
  const blocks = shared.map((section) => section.lines.join('\n'))
  let text = blocks.filter((block, index) => index > 0 || block.length > 0).join('\n')
  for (const block of appended) text = `${text.replace(/\n*$/, '')}${text.trim().length > 0 ? '\n\n' : ''}${block.join('\n')}\n`
  if (!text.endsWith('\n')) text = `${text}\n`
  return { text, added }
}

async function mergeIntoShared(spec: SharedLinkSpec, local: string, target: string): Promise<string[]> {
  const info = await lstat(local)
  if (spec.kind === 'dir') {
    if (!info.isDirectory()) return []
    const moved: string[] = []
    for (const entry of await readdir(local)) {
      const destination = path.join(target, entry)
      if (existsSync(destination)) continue
      await rename(path.join(local, entry), destination)
      moved.push(entry)
    }
    return moved
  }
  if (!info.isFile()) return []
  const localText = await readFile(local, 'utf8')
  const sharedText = await readFile(target, 'utf8')
  if (spec.name.endsWith('.json')) {
    let localValue: unknown
    let sharedValue: unknown
    try {
      localValue = JSON.parse(localText)
      sharedValue = sharedText.trim().length === 0 ? {} : JSON.parse(sharedText)
    } catch {
      return []
    }
    if (!isRecord(localValue) || !isRecord(sharedValue)) return []
    const added = mergeMissingJson(sharedValue, localValue)
    if (added.length > 0) await writeFileAtomic(target, `${JSON.stringify(sharedValue, null, 2)}\n`)
    return added
  }
  if (spec.name.endsWith('.toml')) {
    const merged = mergeMissingToml(sharedText, localText)
    if (merged.added.length > 0) await writeFileAtomic(target, merged.text)
    return merged.added
  }
  if (sharedText.trim().length === 0 && localText.trim().length > 0) {
    await writeFileAtomic(target, localText)
    return ['content']
  }
  return []
}

export async function repairSharedLinks(name: string, ctx: PlatformContext = platformContext()): Promise<SharedLinkRepair[]> {
  const profile = await getProfile(name, ctx)
  await ensureProfileDirs(profile, ctx)
  const repairs: SharedLinkRepair[] = []
  for (const { spec, path: linkName, target } of linkSpecs(profile, ctx)) {
    await ensureSharedTarget(spec, target)
    const previous = await linkState(linkName, target)
    let merged: string[] = []
    let backup: string | null = null
    if (previous === 'replaced') {
      merged = await mergeIntoShared(spec, linkName, target)
      backup = `${linkName}.backup`
    }
    if (previous !== 'linked') await linkPath(target, linkName, ctx.platform)
    repairs.push({ ...spec, path: linkName, target, state: await linkState(linkName, target), previous, merged, backup })
  }
  return repairs
}

export interface ClaudeAuthStatus {
  loggedIn: boolean
  authMethod: string | null
  email: string | null
  orgName: string | null
  subscriptionType: string | null
  configDirectory: string | null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function parseClaudeAuthStatus(text: string): ClaudeAuthStatus | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (!isRecord(parsed) || typeof parsed['loggedIn'] !== 'boolean') return null
  return {
    loggedIn: parsed['loggedIn'],
    authMethod: stringOrNull(parsed['authMethod']),
    email: stringOrNull(parsed['email']),
    orgName: stringOrNull(parsed['orgName']),
    subscriptionType: stringOrNull(parsed['subscriptionType']),
    configDirectory: stringOrNull(parsed['configDirectory']),
  }
}

export async function authStatus(
  profile: Profile,
  options: { ctx?: PlatformContext; bin?: string; timeoutMs?: number } = {},
): Promise<ClaudeAuthStatus | null> {
  const ctx = options.ctx ?? platformContext()
  const env = envFor(profile, 'claude', ctx.env)
  const bin = options.bin ?? (await findAgentBinary('claude', { ctx: { ...ctx, env } }))
  if (!bin) return null
  try {
    const { stdout } = await run(bin, ['auth', 'status', '--json'], { env, timeoutMs: options.timeoutMs ?? 30_000 })
    return parseClaudeAuthStatus(stdout)
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout
    return typeof stdout === 'string' ? parseClaudeAuthStatus(stdout) : null
  }
}
