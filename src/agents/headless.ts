import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { pathDelimiter, pathKey, platformContext, spawnSpec, type PlatformContext } from '../platform.ts'
import { findAgentBinary } from './binaries.ts'

export const HEADLESS_AGENTS = ['claude', 'codex', 'gemini', 'antigravity', 'opencode'] as const
export type HeadlessAgent = (typeof HEADLESS_AGENTS)[number]

export interface HeadlessOptions {
  agent: HeadlessAgent
  prompt: string
  cwd: string
  model?: string
  timeoutMs?: number
  access?: 'read' | 'write'
  extraArgs?: readonly string[]
  env?: NodeJS.ProcessEnv
  bin?: string
  ctx?: PlatformContext
  signal?: AbortSignal
  onSpawn?: (pid: number) => void
}

export interface HeadlessResult {
  agent: HeadlessAgent
  text: string
  sessionId?: string
  raw: string
  stderr: string
  durationMs: number
}

export type HeadlessErrorCode = 'UNAVAILABLE' | 'FAILED' | 'TIMEOUT' | 'PARSE' | 'PROMPT_TOO_LONG'

export class HeadlessError extends Error {
  code: HeadlessErrorCode
  agent: HeadlessAgent
  exitCode: number | null
  stdout: string
  stderr: string

  constructor(code: HeadlessErrorCode, agent: HeadlessAgent, message: string, details: { exitCode?: number | null; stdout?: string; stderr?: string } = {}) {
    super(message)
    this.name = 'HeadlessError'
    this.code = code
    this.agent = agent
    this.exitCode = details.exitCode ?? null
    this.stdout = details.stdout ?? ''
    this.stderr = details.stderr ?? ''
  }
}

export interface HeadlessInvocation {
  args: string[]
  stdin?: string
  env: NodeJS.ProcessEnv
}

export const HEADLESS_DEFAULT_TIMEOUT_MS = 600_000
export const WINDOWS_PROMPT_ARGUMENT_LIMIT = 8000

export function headlessInvocation(
  agent: HeadlessAgent,
  options: { prompt: string; cwd: string; model?: string; access?: 'read' | 'write'; extraArgs?: readonly string[] },
): HeadlessInvocation {
  const write = options.access === 'write'
  const extra = [...(options.extraArgs ?? [])]
  const model = (flag: string) => (options.model ? [flag, options.model] : [])
  if (agent === 'claude') return { args: ['-p', '--output-format', 'json', ...model('--model'), ...extra], stdin: options.prompt, env: {} }
  if (agent === 'codex') {
    return {
      args: ['exec', '--json', '-C', options.cwd, '--skip-git-repo-check', '--sandbox', write ? 'workspace-write' : 'read-only', ...model('-m'), ...extra, '-'],
      stdin: options.prompt,
      env: {},
    }
  }
  if (agent === 'gemini') {
    return { args: ['-o', 'json', '--approval-mode', write ? 'yolo' : 'plan', ...model('-m'), ...extra], stdin: options.prompt, env: { GEMINI_CLI_TRUST_WORKSPACE: 'true' } }
  }
  if (agent === 'antigravity') {
    return { args: ['-p', options.prompt, '--output-format', 'json', ...model('--model'), ...(write ? ['--dangerously-skip-permissions'] : []), ...extra], env: {} }
  }
  return { args: ['run', '--format', 'json', ...model('-m'), ...extra, options.prompt], env: {} }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function lastJsonObject(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim()
  const starts: number[] = []
  if (trimmed.startsWith('{')) starts.push(0)
  for (let index = trimmed.indexOf('\n{'); index !== -1; index = trimmed.indexOf('\n{', index + 1)) starts.push(index + 1)
  for (const start of starts.reverse()) {
    try {
      const parsed = asRecord(JSON.parse(trimmed.slice(start)))
      if (parsed) return parsed
    } catch {
      continue
    }
  }
  return null
}

function jsonLines(stdout: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed = asRecord(JSON.parse(trimmed))
      if (parsed) events.push(parsed)
    } catch {
      continue
    }
  }
  return events
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  const record = asRecord(value)
  if (!record) return undefined
  return text(record['message']) ?? errorMessage(record['data']) ?? errorMessage(record['error']) ?? JSON.stringify(record)
}

function parseSingle(agent: HeadlessAgent, stdout: string, textKey: string, idKey: string, failed: (payload: Record<string, unknown>) => string | undefined): { text: string; sessionId?: string } {
  const payload = lastJsonObject(stdout)
  if (!payload) throw new HeadlessError('PARSE', agent, `${agent} did not print a JSON result`, { stdout })
  const sessionId = text(payload[idKey])
  const problem = failed(payload)
  if (problem !== undefined) throw new HeadlessError('FAILED', agent, `${agent} reported an error: ${problem}`, { stdout })
  const answer = text(payload[textKey])
  if (answer === undefined) throw new HeadlessError('PARSE', agent, `${agent} JSON result has no "${textKey}" field`, { stdout })
  return sessionId ? { text: answer, sessionId } : { text: answer }
}

function parseCodex(stdout: string): { text: string; sessionId?: string } {
  let sessionId: string | undefined
  let answer: string | undefined
  let failure: string | undefined
  for (const event of jsonLines(stdout)) {
    const type = event['type']
    if (type === 'thread.started') sessionId = text(event['thread_id']) ?? sessionId
    else if (type === 'item.completed') {
      const item = asRecord(event['item'])
      if (item?.['type'] === 'agent_message' && typeof item['text'] === 'string') answer = item['text']
    } else if (type === 'turn.failed') failure = errorMessage(event['error']) ?? 'turn failed'
    else if (type === 'error') failure = errorMessage(event['message']) ?? errorMessage(event) ?? 'error'
  }
  if (answer === undefined) {
    if (failure !== undefined) throw new HeadlessError('FAILED', 'codex', `codex reported an error: ${failure}`, { stdout })
    throw new HeadlessError('PARSE', 'codex', 'codex printed no agent_message', { stdout })
  }
  return sessionId ? { text: answer, sessionId } : { text: answer }
}

function parseOpenCode(stdout: string): { text: string; sessionId?: string } {
  let sessionId: string | undefined
  let failure: string | undefined
  const parts = new Map<string, { message: string; text: string }>()
  for (const event of jsonLines(stdout)) {
    sessionId = text(event['sessionID']) ?? sessionId
    if (event['type'] === 'error') failure = errorMessage(event['error']) ?? errorMessage(event) ?? 'error'
    if (event['type'] !== 'text') continue
    const part = asRecord(event['part'])
    const value = text(part?.['text'])
    if (!part || value === undefined) continue
    const id = text(part['id']) ?? `part-${parts.size}`
    parts.set(id, { message: text(part['messageID']) ?? '', text: value })
  }
  if (parts.size === 0) {
    if (failure !== undefined) throw new HeadlessError('FAILED', 'opencode', `opencode reported an error: ${failure}`, { stdout })
    throw new HeadlessError('PARSE', 'opencode', 'opencode printed no text events', { stdout })
  }
  let answer = ''
  let previous: string | null = null
  for (const part of parts.values()) {
    if (previous !== null && part.message !== previous && answer.length > 0) answer += '\n\n'
    answer += part.text
    previous = part.message
  }
  return sessionId ? { text: answer, sessionId } : { text: answer }
}

export function parseHeadlessOutput(agent: HeadlessAgent, stdout: string): { text: string; sessionId?: string } {
  if (agent === 'claude') {
    return parseSingle(agent, stdout, 'result', 'session_id', (payload) => (payload['is_error'] === true ? (text(payload['result']) ?? text(payload['subtype']) ?? 'error') : undefined))
  }
  if (agent === 'gemini') return parseSingle(agent, stdout, 'response', 'session_id', (payload) => (payload['error'] !== undefined && payload['response'] === undefined ? errorMessage(payload['error']) : undefined))
  if (agent === 'antigravity') {
    return parseSingle(agent, stdout, 'response', 'conversation_id', (payload) => (payload['error'] !== undefined && payload['response'] === undefined ? errorMessage(payload['error']) : undefined))
  }
  if (agent === 'codex') return parseCodex(stdout)
  return parseOpenCode(stdout)
}

function childEnv(bin: string, base: NodeJS.ProcessEnv, extra: NodeJS.ProcessEnv, ctx: PlatformContext): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...extra, KIT_HEADLESS: '1' }
  const key = pathKey(env)
  const dir = (ctx.platform === 'win32' ? path.win32 : path.posix).dirname(bin)
  const delimiter = pathDelimiter(ctx)
  const current = (env[key] ?? '').split(delimiter).filter((entry) => entry.length > 0 && entry !== dir)
  env[key] = [dir, ...current].join(delimiter)
  return env
}

function killTree(child: ChildProcess, ctx: PlatformContext): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (ctx.platform === 'win32' && child.pid !== undefined) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    killer.once('error', () => child.kill())
    return
  }
  child.kill('SIGTERM')
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, 3000).unref()
}

export async function runHeadless(options: HeadlessOptions): Promise<HeadlessResult> {
  const ctx = options.ctx ?? platformContext()
  const agent = options.agent
  const bin = options.bin ?? (await findAgentBinary(agent, { ctx }))
  if (!bin) throw new HeadlessError('UNAVAILABLE', agent, `${agent} is not installed or not on PATH`)
  const invocation = headlessInvocation(agent, options)
  if (invocation.stdin === undefined && ctx.platform === 'win32' && /\.(cmd|bat)$/i.test(bin) && options.prompt.length > WINDOWS_PROMPT_ARGUMENT_LIMIT) {
    throw new HeadlessError('PROMPT_TOO_LONG', agent, `${agent} takes the prompt as an argument and ${path.win32.basename(bin)} goes through cmd.exe, which cannot pass more than ${WINDOWS_PROMPT_ARGUMENT_LIMIT} characters`)
  }
  const spec = spawnSpec(bin, invocation.args, ctx)
  const env = childEnv(bin, options.env ?? ctx.env, invocation.env, ctx)
  const started = Date.now()
  return new Promise<HeadlessResult>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new HeadlessError('FAILED', agent, `${agent} run was aborted before it started`))
      return
    }
    const child = spawn(spec.command, spec.args, {
      cwd: options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    })
    let stdout = ''
    let stderr = ''
    let reason: 'timeout' | 'aborted' | null = null
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const timer = setTimeout(() => {
      reason = 'timeout'
      killTree(child, ctx)
    }, options.timeoutMs ?? HEADLESS_DEFAULT_TIMEOUT_MS)
    const onAbort = () => {
      reason = 'aborted'
      killTree(child, ctx)
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.once('spawn', () => {
      if (child.pid !== undefined) options.onSpawn?.(child.pid)
    })
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.once('error', (error) => {
      finish(() => reject(new HeadlessError('UNAVAILABLE', agent, `could not start ${bin}: ${error.message}`, { stdout, stderr })))
    })
    child.once('close', (code) => {
      finish(() => {
        const details = { exitCode: code, stdout, stderr }
        if (reason === 'timeout') return reject(new HeadlessError('TIMEOUT', agent, `${agent} did not finish within ${options.timeoutMs ?? HEADLESS_DEFAULT_TIMEOUT_MS} ms`, details))
        if (reason === 'aborted') return reject(new HeadlessError('FAILED', agent, `${agent} run was aborted`, details))
        let parsed: { text: string; sessionId?: string }
        try {
          parsed = parseHeadlessOutput(agent, stdout)
        } catch (error) {
          if (code !== 0) {
            const detail = error instanceof HeadlessError && error.code === 'FAILED' ? error.message : (stderr.trim().split('\n').at(-1) ?? '')
            return reject(new HeadlessError('FAILED', agent, `${agent} exited with ${code}${detail ? `: ${detail}` : ''}`, details))
          }
          if (error instanceof HeadlessError) return reject(new HeadlessError(error.code, agent, error.message, details))
          return reject(error)
        }
        if (code !== 0) return reject(new HeadlessError('FAILED', agent, `${agent} exited with ${code}`, details))
        resolve({ agent, text: parsed.text, ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}), raw: stdout, stderr, durationMs: Date.now() - started })
      })
    })
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(invocation.stdin ?? '')
  })
}

export async function pickHeadlessAgent(
  preferred?: HeadlessAgent | null,
  options: { ctx?: PlatformContext; order?: readonly HeadlessAgent[] } = {},
): Promise<{ agent: HeadlessAgent; bin: string; fallback: boolean } | null> {
  const ctx = options.ctx ?? platformContext()
  if (preferred) {
    const bin = await findAgentBinary(preferred, { ctx })
    if (bin) return { agent: preferred, bin, fallback: false }
  }
  for (const agent of options.order ?? HEADLESS_AGENTS) {
    if (agent === preferred) continue
    const bin = await findAgentBinary(agent, { ctx })
    if (bin) return { agent, bin, fallback: Boolean(preferred) }
  }
  return null
}
