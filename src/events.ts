import { spawn } from 'node:child_process'
import { appendFile, mkdir, open } from 'node:fs/promises'
import path from 'node:path'
import { platformContext, withRuntimePath, type PlatformContext } from './platform.ts'
import { isInstalled, listTools, type EventFilter } from './registry.ts'

export const NO_EVENTS_ENV_VAR = 'KIT_NO_EVENTS'
const HANDOFF_TIMEOUT_MS = 2_000

export interface Listener {
  source: 'registry' | 'config'
  owner: string
  events: string[]
  filter?: EventFilter
  command: string[]
}

export interface EventOccurrence {
  tool: string
  event: string
  attributes: Record<string, ReadonlyArray<string | null | undefined>>
  document: Record<string, unknown>
  env?: NodeJS.ProcessEnv
}

export interface FireOptions {
  logPath: string
  extraListeners?: readonly Listener[]
  suppressEnvVars?: readonly string[]
  ctx?: PlatformContext
}

export interface FireResult {
  launched: number
  listeners: Listener[]
}

export function eventsSuppressed(env: NodeJS.ProcessEnv, extra: readonly string[] = []): boolean {
  return [NO_EVENTS_ENV_VAR, ...extra].some((name) => {
    const value = env[name]
    return value !== undefined && value !== '' && value !== '0'
  })
}

export function filterMatches(filter: EventFilter | undefined, attributes: EventOccurrence['attributes']): boolean {
  if (!filter) return true
  return Object.entries(filter).every(([key, wanted]) => {
    const values = attributes[key] ?? []
    return values.some((value) => value != null && wanted.includes(value))
  })
}

export async function registryListeners(tool: string, ctx: PlatformContext = platformContext()): Promise<Listener[]> {
  const listeners: Listener[] = []
  for (const manifest of await listTools(ctx)) {
    if (!isInstalled(manifest)) continue
    for (const subscription of manifest.subscribes) {
      if (subscription.tool !== tool) continue
      listeners.push({
        source: 'registry',
        owner: manifest.name,
        events: subscription.events,
        ...(subscription.filter ? { filter: subscription.filter } : {}),
        command: subscription.command,
      })
    }
  }
  return listeners
}

export function matchingListeners(listeners: readonly Listener[], occurrence: EventOccurrence): Listener[] {
  return listeners.filter((listener) => listener.events.includes(occurrence.event) && filterMatches(listener.filter, occurrence.attributes))
}

export function dedupeListeners(listeners: readonly Listener[]): Listener[] {
  const seen = new Set<string>()
  return listeners.filter((listener) => {
    const key = `${listener.events.join(',')}|${listener.command.join('\u0000')}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export async function fireEvents(occurrences: readonly EventOccurrence[], options: FireOptions): Promise<FireResult> {
  const ctx = options.ctx ?? platformContext()
  if (occurrences.length === 0 || eventsSuppressed(ctx.env, options.suppressEnvVars)) return { launched: 0, listeners: [] }
  const byTool = new Map<string, Listener[]>()
  let launched = 0
  const fired: Listener[] = []
  for (const occurrence of occurrences) {
    let fromRegistry = byTool.get(occurrence.tool)
    if (!fromRegistry) {
      fromRegistry = await registryListeners(occurrence.tool, ctx)
      byTool.set(occurrence.tool, fromRegistry)
    }
    const listeners = dedupeListeners([...(options.extraListeners ?? []), ...fromRegistry])
    for (const listener of matchingListeners(listeners, occurrence)) {
      if (await launch(listener, occurrence, options.logPath, ctx)) {
        launched += 1
        fired.push(listener)
      }
    }
  }
  return { launched, listeners: fired }
}

export function eventDocument(occurrence: EventOccurrence): string {
  return `${JSON.stringify({ ...occurrence.document, event: occurrence.event, source: occurrence.tool, firedAt: new Date().toISOString() })}\n`
}

function neutralCwd(ctx: PlatformContext): string {
  return ctx.platform === 'win32' ? path.win32.parse(ctx.home).root || 'C:\\' : '/'
}

async function launch(listener: Listener, occurrence: EventOccurrence, logPath: string, ctx: PlatformContext): Promise<boolean> {
  const [command, ...args] = listener.command
  if (!command) return false
  const label = `${occurrence.tool}:${occurrence.event}`
  await mkdir(path.dirname(logPath), { recursive: true })
  await appendFile(logPath, `${new Date().toISOString()} ${label} -> ${listener.command.join(' ')}\n`)
  const log = await open(logPath, 'a')
  try {
    return await new Promise<boolean>((resolve) => {
      let settled = false
      let spawned = false
      let flushed = false
      const finish = (ok: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(ok)
      }
      const timer = setTimeout(() => finish(spawned), HANDOFF_TIMEOUT_MS)
      const child = spawn(command, args, {
        detached: true,
        stdio: ['pipe', log.fd, log.fd],
        env: withRuntimePath({ ...ctx.env, ...occurrence.env, KIT_EVENT: occurrence.event, KIT_EVENT_SOURCE: occurrence.tool }),
        cwd: neutralCwd(ctx),
        windowsHide: true,
        shell: ctx.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
      })
      child.once('spawn', () => {
        spawned = true
        if (flushed) finish(true)
      })
      child.once('error', (error) => {
        void appendFile(logPath, `${new Date().toISOString()} ${label}: ${command} did not start: ${error.message}\n`).finally(() => finish(false))
      })
      const stdin = child.stdin
      if (!stdin) {
        flushed = true
      } else {
        stdin.on('error', () => undefined)
        stdin.end(eventDocument(occurrence), () => {
          flushed = true
          if (spawned) finish(true)
        })
      }
      child.unref()
    })
  } finally {
    await log.close()
  }
}
