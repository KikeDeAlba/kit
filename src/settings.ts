import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseFrontmatter } from './agents/markdown.ts'
import { withFileLock, writeFileAtomic } from './atomic.ts'
import { CATALOG, CATALOG_TOOL_NAMES, catalogTool } from './catalog.ts'
import { HARNESS_IDS, type HarnessId } from './harness/types.ts'
import { ensureKitConfigRoot, kitConfigRoot, platformContext, type PlatformContext } from './platform.ts'

export const SETTINGS_VERSION = 1

export type SettingValue = boolean | number | string | string[]
export type SettingType = 'boolean' | 'integer' | 'string' | 'string[]' | 'enum'

export interface SettingDef {
  pattern: string
  owner: 'nursery' | 'den' | 'bita'
  type: SettingType
  default: SettingValue | ((key: string, ctx: PlatformContext) => Promise<SettingValue | undefined>)
  min?: number
  max?: number
  values?: readonly string[]
  refresh: 'nursery' | 'none'
}

export interface SettingEntry {
  key: string
  value: SettingValue | undefined
  default: SettingValue | undefined
  source: 'user' | 'default'
  owner: SettingDef['owner']
}

export interface SettingChange {
  key: string
  previous: SettingValue | undefined
  value: SettingValue | undefined
  refresh: SettingDef['refresh']
  warnings?: string[]
}

export type SettingsErrorCode = 'SETTINGS_INVALID' | 'UNKNOWN_KEY' | 'INVALID_VALUE'

export class SettingsError extends Error {
  readonly code: SettingsErrorCode
  readonly key?: string

  constructor(code: SettingsErrorCode, message: string, key?: string) {
    super(message)
    this.name = 'SettingsError'
    this.code = code
    if (key !== undefined) this.key = key
  }
}

export const NURSERY_ROLES = [
  'researcher',
  'analyst',
  'architect',
  'developer',
  'qa-automation',
  'devops',
  'sre',
  'security',
  'code-reviewer',
  'documenter',
] as const

export const RULE_FLAGS = ['noAiTrace', 'noComments', 'language', 'worktrees', 'gitflow', 'delegation'] as const
export const AGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export const USER_AGENT_NAME_PATTERN = /^[a-z][a-z0-9-]{1,39}$/

export const MODEL_PATTERN = /^[a-z0-9][a-z0-9.\-[\]/#:]*$/
const RESERVED_ROLE_NAMES = new Set(['enabled'])

function pathApi(ctx: PlatformContext): path.PlatformPath {
  return ctx.platform === 'win32' ? path.win32 : path.posix
}

export function userAgentsDir(ctx: PlatformContext = platformContext()): string {
  return pathApi(ctx).join(kitConfigRoot(ctx), 'agents')
}

export async function listUserAgents(ctx: PlatformContext = platformContext()): Promise<string[]> {
  try {
    const names = await readdir(userAgentsDir(ctx))
    return names
      .filter((name) => name.endsWith('.md'))
      .map((name) => name.slice(0, -3))
      .filter((name) => USER_AGENT_NAME_PATTERN.test(name) && !(NURSERY_ROLES as readonly string[]).includes(name))
      .sort()
  } catch {
    return []
  }
}

async function knownRoles(ctx: PlatformContext): Promise<string[]> {
  return [...NURSERY_ROLES, ...(await listUserAgents(ctx))]
}

function frontmatterDefault(field: 'model' | 'maxTurns' | 'effort'): (key: string, ctx: PlatformContext) => Promise<SettingValue | undefined> {
  return async (key, ctx) => {
    const role = key.split('.')[1] ?? ''
    if ((NURSERY_ROLES as readonly string[]).includes(role)) return undefined
    let text: string
    try {
      text = await readFile(pathApi(ctx).join(userAgentsDir(ctx), `${role}.md`), 'utf8')
    } catch {
      return undefined
    }
    const raw = parseFrontmatter(text).attributes[field]
    if (raw === undefined || raw.length === 0) return undefined
    if (field === 'maxTurns') return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : undefined
    return raw
  }
}

async function summaryModelDefault(key: string): Promise<SettingValue | undefined> {
  const { getAdapter } = await import('./harness/registry.ts')
  return getAdapter(key.split('.')[2] as HarnessId).defaultSummaryModel
}

export const SETTING_DEFS: readonly SettingDef[] = [
  { pattern: 'agents.maxParallel', owner: 'nursery', type: 'integer', default: 10, min: 1, max: 20, refresh: 'nursery' },
  { pattern: 'agents.enabled', owner: 'nursery', type: 'string[]', default: async (_key, ctx) => knownRoles(ctx), refresh: 'nursery' },
  { pattern: 'agents.<role>.model', owner: 'nursery', type: 'string', default: frontmatterDefault('model'), refresh: 'nursery' },
  { pattern: 'agents.<role>.maxTurns', owner: 'nursery', type: 'integer', default: frontmatterDefault('maxTurns'), min: 1, max: 500, refresh: 'nursery' },
  { pattern: 'agents.<role>.effort', owner: 'nursery', type: 'enum', default: frontmatterDefault('effort'), values: AGENT_EFFORTS, refresh: 'nursery' },
  ...RULE_FLAGS.map((flag): SettingDef => ({ pattern: `rules.${flag}`, owner: 'nursery', type: 'boolean', default: true, refresh: 'nursery' })),
  { pattern: 'rules.baseBranch', owner: 'nursery', type: 'string', default: 'develop', refresh: 'nursery' },
  { pattern: 'harness.default', owner: 'den', type: 'enum', default: 'claude', values: HARNESS_IDS, refresh: 'none' },
  { pattern: 'harness.<h>.skipPermissions', owner: 'den', type: 'boolean', default: true, refresh: 'none' },
  { pattern: 'harness.<h>.extraArgs', owner: 'den', type: 'string[]', default: [], refresh: 'none' },
  { pattern: 'session.summary.<h>.model', owner: 'bita', type: 'string', default: summaryModelDefault, refresh: 'none' },
  { pattern: 'session.minDurationSec', owner: 'bita', type: 'integer', default: 60, min: 0, max: 3600, refresh: 'none' },
  { pattern: 'tools.<t>.enabled', owner: 'den', type: 'boolean', default: true, refresh: 'none' },
]

export function settingsPath(ctx: PlatformContext = platformContext()): string {
  return pathApi(ctx).join(kitConfigRoot(ctx), 'settings.json')
}

interface KeyMatch {
  def: SettingDef
  params: Record<string, string>
}

function matchKey(key: string): KeyMatch | null {
  const parts = key.split('.')
  for (const def of SETTING_DEFS) {
    const pattern = def.pattern.split('.')
    if (pattern.length !== parts.length) continue
    const params: Record<string, string> = {}
    const ok = pattern.every((segment, index) => {
      const part = parts[index] ?? ''
      if (segment === '<h>') {
        params['h'] = part
        return (HARNESS_IDS as readonly string[]).includes(part)
      }
      if (segment === '<t>') {
        params['t'] = part
        return (CATALOG_TOOL_NAMES as readonly string[]).includes(part)
      }
      if (segment === '<role>') {
        params['role'] = part
        return USER_AGENT_NAME_PATTERN.test(part) && !RESERVED_ROLE_NAMES.has(part)
      }
      return segment === part
    })
    if (ok) return { def, params }
  }
  return null
}

function unknownKey(key: string): SettingsError {
  return new SettingsError('UNKNOWN_KEY', `unknown setting "${key}"`, key)
}

function invalidValue(key: string, problem: string): SettingsError {
  return new SettingsError('INVALID_VALUE', `invalid value for ${key}: ${problem}`, key)
}

export function settingDef(key: string): SettingDef | null {
  return matchKey(key)?.def ?? null
}

async function resolveKey(key: string, ctx: PlatformContext): Promise<KeyMatch> {
  const match = matchKey(key)
  if (!match) throw unknownKey(key)
  const role = match.params['role']
  if (role !== undefined && !(await knownRoles(ctx)).includes(role)) throw unknownKey(key)
  return match
}

const BRANCH_NAME_CHARS = /^[A-Za-z0-9._/-]+$/
const GIT_REF_FORBIDDEN = /[\s~^:?*[\\\x00-\x1f\x7f]/

export function isValidBranchName(name: string): boolean {
  if (name.length === 0 || name === '@') return false
  if (!BRANCH_NAME_CHARS.test(name)) return false
  if (GIT_REF_FORBIDDEN.test(name)) return false
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return false
  return name.split('/').every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'))
}

function checkValue(key: string, match: KeyMatch, value: unknown): SettingValue {
  const { def } = match
  if (def.type === 'boolean') {
    if (typeof value !== 'boolean') throw invalidValue(key, 'expected a boolean')
  } else if (def.type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) throw invalidValue(key, 'expected an integer')
    if (def.min !== undefined && value < def.min) throw invalidValue(key, `must be at least ${def.min}`)
    if (def.max !== undefined && value > def.max) throw invalidValue(key, `must be at most ${def.max}`)
  } else if (def.type === 'string' || def.type === 'enum') {
    if (typeof value !== 'string') throw invalidValue(key, 'expected a string')
    if (def.values && !def.values.includes(value)) throw invalidValue(key, `must be one of ${def.values.join(', ')}`)
    if (value.trim().length === 0) throw invalidValue(key, 'cannot be empty')
  } else if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw invalidValue(key, 'expected a list of strings')
  }
  if ((def.pattern === 'agents.<role>.model' || def.pattern === 'session.summary.<h>.model') && !MODEL_PATTERN.test(value as string)) throw invalidValue(key, `must match ${MODEL_PATTERN.source}`)
  if (def.pattern === 'rules.baseBranch' && !isValidBranchName(value as string)) throw invalidValue(key, 'is not a valid git branch name')
  if (def.pattern === 'harness.<h>.extraArgs' && (value as string[]).includes('--')) throw invalidValue(key, 'cannot contain --')
  if (def.pattern === 'harness.<h>.extraArgs' && (value as string[]).some((item) => /[\r\n\0]/.test(item))) throw invalidValue(key, 'arguments cannot contain line breaks or NUL')
  if (def.pattern === 'agents.enabled' && (value as string[]).length === 0) throw invalidValue(key, 'cannot be empty')
  if (def.pattern === 'tools.<t>.enabled' && value === false) {
    const tool = catalogTool(match.params['t'] ?? '')
    if (tool && !tool.optional) throw invalidValue(key, `${tool.name} cannot be disabled`)
  }
  return value as SettingValue
}

async function checkValueAsync(key: string, match: KeyMatch, value: unknown, ctx: PlatformContext): Promise<SettingValue> {
  const checked = checkValue(key, match, value)
  if (match.def.pattern === 'agents.enabled') {
    const roles = await knownRoles(ctx)
    const unknown = (checked as string[]).filter((role) => !roles.includes(role))
    if (unknown.length > 0) throw invalidValue(key, `unknown roles: ${unknown.join(', ')}`)
  }
  return checked
}

function parseRaw(key: string, def: SettingDef, raw: string): unknown {
  if (def.type === 'boolean') {
    const lowered = raw.trim().toLowerCase()
    if (lowered === 'true' || lowered === '1') return true
    if (lowered === 'false' || lowered === '0') return false
    throw invalidValue(key, 'expected true, false, 1 or 0')
  }
  if (def.type === 'integer') {
    const trimmed = raw.trim()
    if (!/^-?\d+$/.test(trimmed)) throw invalidValue(key, 'expected a base-10 integer')
    return Number.parseInt(trimmed, 10)
  }
  if (def.type === 'string[]') {
    const trimmed = raw.trim()
    if (trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed) as unknown
      } catch {
        throw invalidValue(key, 'expected a JSON array of strings')
      }
    }
    return trimmed
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
  }
  return raw
}

export function parseSettingValue(key: string, raw: string): SettingValue {
  const match = matchKey(key)
  if (!match) throw unknownKey(key)
  return checkValue(key, match, parseRaw(key, match.def, raw))
}

type SettingsTree = Record<string, unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readTree(ctx: PlatformContext): Promise<SettingsTree> {
  const file = settingsPath(ctx)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: SETTINGS_VERSION }
    throw new SettingsError('SETTINGS_INVALID', `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new SettingsError('SETTINGS_INVALID', `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(parsed)) throw new SettingsError('SETTINGS_INVALID', `${file} is not a JSON object`)
  if (parsed['version'] !== SETTINGS_VERSION) throw new SettingsError('SETTINGS_INVALID', `${file} must have version ${SETTINGS_VERSION}`)
  return parsed
}

async function writeTree(tree: SettingsTree, ctx: PlatformContext): Promise<void> {
  const { version: _version, ...rest } = tree
  await writeFileAtomic(settingsPath(ctx), `${JSON.stringify({ version: SETTINGS_VERSION, ...rest }, null, 2)}\n`, { mode: 0o600 })
}

function getNested(tree: SettingsTree, key: string): unknown {
  let current: unknown = tree
  for (const part of key.split('.')) {
    if (!isRecord(current)) return undefined
    current = current[part]
  }
  return current
}

function setNested(tree: SettingsTree, key: string, value: SettingValue): void {
  const parts = key.split('.')
  let current: Record<string, unknown> = tree
  for (const part of parts.slice(0, -1)) {
    const next = current[part]
    if (!isRecord(next)) current[part] = {}
    current = current[part] as Record<string, unknown>
  }
  current[parts[parts.length - 1] as string] = value
}

function deleteNested(tree: SettingsTree, key: string): void {
  const parts = key.split('.')
  const trail: Record<string, unknown>[] = [tree]
  let current: unknown = tree
  for (const part of parts.slice(0, -1)) {
    if (!isRecord(current)) return
    current = current[part]
    if (!isRecord(current)) return
    trail.push(current)
  }
  delete (trail[trail.length - 1] as Record<string, unknown>)[parts[parts.length - 1] as string]
  for (let index = trail.length - 1; index > 0; index--) {
    if (Object.keys(trail[index] as Record<string, unknown>).length > 0) break
    delete (trail[index - 1] as Record<string, unknown>)[parts[index - 1] as string]
  }
}

function flatten(tree: SettingsTree, prefix = ''): [string, unknown][] {
  const leaves: [string, unknown][] = []
  for (const [key, value] of Object.entries(tree)) {
    if (!prefix && (key === 'version' || key === '$schema')) continue
    const full = prefix ? `${prefix}.${key}` : key
    if (isRecord(value)) leaves.push(...flatten(value, full))
    else leaves.push([full, value])
  }
  return leaves
}

async function defaultOf(def: SettingDef, key: string, ctx: PlatformContext): Promise<SettingValue | undefined> {
  return typeof def.default === 'function' ? def.default(key, ctx) : def.default
}

function sameValue(left: SettingValue | undefined, right: SettingValue | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function storedValue(tree: SettingsTree, key: string, match: KeyMatch): SettingValue | undefined {
  const raw = getNested(tree, key)
  if (raw === undefined || isRecord(raw)) return undefined
  try {
    return checkValue(key, match, raw)
  } catch {
    return undefined
  }
}

async function entryFor(tree: SettingsTree, key: string, match: KeyMatch, ctx: PlatformContext): Promise<SettingEntry> {
  const fallback = await defaultOf(match.def, key, ctx)
  const stored = storedValue(tree, key, match)
  return {
    key,
    value: stored ?? fallback,
    default: fallback,
    source: stored === undefined ? 'default' : 'user',
    owner: match.def.owner,
  }
}

export async function getSetting<T extends SettingValue>(key: string, ctx: PlatformContext = platformContext()): Promise<T | undefined> {
  const match = await resolveKey(key, ctx)
  const tree = await readTree(ctx)
  return (await entryFor(tree, key, match, ctx)).value as T | undefined
}

export async function getSettingEntry(key: string, ctx: PlatformContext = platformContext()): Promise<SettingEntry> {
  const match = await resolveKey(key, ctx)
  return entryFor(await readTree(ctx), key, match, ctx)
}

async function expandKeys(ctx: PlatformContext): Promise<string[]> {
  const roles = await knownRoles(ctx)
  const keys: string[] = []
  for (const def of SETTING_DEFS) {
    let expanded = [def.pattern]
    const substitute = (placeholder: string, values: readonly string[]) => {
      expanded = expanded.flatMap((key) => (key.includes(placeholder) ? values.map((value) => key.replace(placeholder, value)) : [key]))
    }
    substitute('<role>', roles)
    substitute('<h>', HARNESS_IDS)
    substitute('<t>', CATALOG.map((tool) => tool.name))
    keys.push(...expanded)
  }
  return keys
}

export async function listSettings(ctx: PlatformContext = platformContext()): Promise<SettingEntry[]> {
  const tree = await readTree(ctx)
  const entries: SettingEntry[] = []
  for (const key of await expandKeys(ctx)) {
    const match = matchKey(key)
    if (match) entries.push(await entryFor(tree, key, match, ctx))
  }
  return entries
}

export async function checkSettings(ctx: PlatformContext = platformContext()): Promise<{ ok: boolean; errors: string[] }> {
  let tree: SettingsTree
  try {
    tree = await readTree(ctx)
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] }
  }
  const errors: string[] = []
  for (const [key, value] of flatten(tree)) {
    try {
      const match = await resolveKey(key, ctx)
      await checkValueAsync(key, match, value, ctx)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  return { ok: errors.length === 0, errors }
}

type ChangeHandler = (change: SettingChange) => void | Promise<void>

const handlers = new Set<{ prefix: string; handler: ChangeHandler }>()

export function onChange(prefix: string, handler: ChangeHandler): () => void {
  const entry = { prefix, handler }
  handlers.add(entry)
  return () => {
    handlers.delete(entry)
  }
}

async function notify(change: SettingChange): Promise<SettingChange> {
  const matching = [...handlers].filter(({ prefix }) => prefix === '' || change.key === prefix || change.key.startsWith(prefix.endsWith('.') ? prefix : `${prefix}.`))
  const warnings: string[] = []
  for (const { handler } of matching) {
    try {
      await handler({ ...change })
    } catch (error) {
      warnings.push(`onChange handler for ${change.key} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return warnings.length > 0 ? { ...change, warnings } : change
}

export async function setSetting(key: string, value: SettingValue | string, ctx: PlatformContext = platformContext()): Promise<SettingChange> {
  const match = await resolveKey(key, ctx)
  const parsed = typeof value === 'string' && match.def.type !== 'string' && match.def.type !== 'enum' ? parseRaw(key, match.def, value) : value
  const checked = await checkValueAsync(key, match, parsed, ctx)
  await ensureKitConfigRoot(ctx)
  const change = await withFileLock(settingsPath(ctx), async (): Promise<SettingChange> => {
    const tree = await readTree(ctx)
    const before = await entryFor(tree, key, match, ctx)
    if (sameValue(checked, before.default)) deleteNested(tree, key)
    else setNested(tree, key, checked)
    await writeTree(tree, ctx)
    return { key, previous: before.value, value: checked, refresh: match.def.refresh }
  })
  return sameValue(change.previous, change.value) ? change : notify(change)
}

export async function unsetSetting(key: string, ctx: PlatformContext = platformContext()): Promise<SettingChange> {
  const match = await resolveKey(key, ctx)
  await ensureKitConfigRoot(ctx)
  const change = await withFileLock(settingsPath(ctx), async (): Promise<SettingChange> => {
    const tree = await readTree(ctx)
    const before = await entryFor(tree, key, match, ctx)
    if (getNested(tree, key) !== undefined) {
      deleteNested(tree, key)
      await writeTree(tree, ctx)
    }
    return { key, previous: before.value, value: before.default, refresh: match.def.refresh }
  })
  return sameValue(change.previous, change.value) ? change : notify(change)
}
