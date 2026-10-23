import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathDelimiter, pathKey, platformContext, spawnSpec, windowsSystemCommand, type PlatformContext } from '../platform.ts'
import { findAgentBinary } from './binaries.ts'

export const HEADLESS_AGENTS = ['claude', 'codex', 'gemini', 'antigravity', 'opencode'] as const
export type HeadlessAgent = (typeof HEADLESS_AGENTS)[number]

export function isHeadlessAgent(value: unknown): value is HeadlessAgent {
  return typeof value === 'string' && (HEADLESS_AGENTS as readonly string[]).includes(value)
}

export interface HeadlessOptions {
  agent: HeadlessAgent
  prompt: string
  cwd: string
  model?: string
  timeoutMs?: number
  access?: 'read' | 'write'
  tools?: readonly string[]
  extraArgs?: readonly string[]
  maxOutputBytes?: number
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
  unset?: readonly string[]
}

export const HEADLESS_DEFAULT_TIMEOUT_MS = 600_000
export const HEADLESS_DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
export const CLAUDE_READ_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob']
export const WINDOWS_COMMAND_LINE_LIMIT = 8191

export const HEADLESS_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'TERM',
  'USERPROFILE',
  'USERNAME',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'COMMONPROGRAMFILES',
  'ALLUSERSPROFILE',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'KIT_HEADLESS',
]

export const HEADLESS_ENV_PREFIXES: readonly string[] = ['LC_', 'XDG_', 'NVM_']

export const HEADLESS_AGENT_ENV_PREFIXES: Record<HeadlessAgent, readonly string[]> = {
  claude: ['ANTHROPIC_', 'CLAUDE_'],
  codex: ['OPENAI_', 'CODEX_'],
  gemini: ['GEMINI_', 'GOOGLE_'],
  antigravity: ['ANTIGRAVITY_', 'GEMINI_'],
  opencode: ['OPENCODE_'],
}

function enabled(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false'
}

function agentEnvRules(agent: HeadlessAgent, env: NodeJS.ProcessEnv): { prefixes: string[]; names: string[]; excluded: string[] } {
  const prefixes = [...HEADLESS_AGENT_ENV_PREFIXES[agent]]
  const names: string[] = []
  const excluded: string[] = []
  if (agent === 'claude') {
    if (enabled(env['CLAUDE_CODE_USE_BEDROCK'])) prefixes.push('AWS_')
    if (enabled(env['CLAUDE_CODE_USE_VERTEX'])) {
      prefixes.push('GOOGLE_')
      names.push('CLOUD_ML_REGION')
    }
  }
  if (agent === 'gemini' && !enabled(env['GOOGLE_GENAI_USE_VERTEXAI'])) excluded.push('GOOGLE_APPLICATION_CREDENTIALS')
  return { prefixes, names, excluded }
}

export function headlessEnv(agent: HeadlessAgent, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const rules = agentEnvRules(agent, env)
  const prefixes = [...HEADLESS_ENV_PREFIXES, ...rules.prefixes]
  const kept: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase()
    if (rules.excluded.includes(upper)) continue
    if (HEADLESS_ENV_ALLOWLIST.includes(upper) || rules.names.includes(upper) || prefixes.some((prefix) => upper.startsWith(prefix))) kept[key] = value
  }
  return kept
}

export function headlessEnvironment(agent: HeadlessAgent, base: NodeJS.ProcessEnv, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...headlessEnv(agent, { ...base, ...extra }), ...extra }
}

function claudeTools(tools: readonly string[] | undefined, write: boolean): string[] {
  if (tools === undefined) return write ? [] : ['--tools', CLAUDE_READ_TOOLS.join(',')]
  const names = tools.map((tool) => tool.trim()).filter((tool) => tool.length > 0)
  if (names.length === 0) return ['--strict-mcp-config', '--tools', CLAUDE_READ_TOOLS.join(','), '--disallowedTools', CLAUDE_READ_TOOLS.join(',')]
  return ['--strict-mcp-config', '--tools', names.join(',')]
}

export function headlessInvocation(
  agent: HeadlessAgent,
  options: { prompt: string; cwd: string; model?: string; access?: 'read' | 'write'; tools?: readonly string[]; extraArgs?: readonly string[] },
): HeadlessInvocation {
  const write = options.access === 'write'
  const extra = [...(options.extraArgs ?? [])]
  const model = (flag: string) => (options.model ? [flag, options.model] : [])
  const stdin = options.prompt
  if (agent === 'claude') {
    const access = write ? ['--permission-mode', 'acceptEdits'] : ['--permission-mode', 'plan', '--setting-sources', 'user']
    return { args: ['-p', '--output-format', 'json', ...claudeTools(options.tools, write), ...access, ...model('--model'), ...extra], stdin, env: {} }
  }
  if (agent === 'codex') {
    return {
      args: ['exec', '--json', '-C', options.cwd, '--skip-git-repo-check', '--sandbox', write ? 'workspace-write' : 'read-only', ...model('-m'), ...extra, '-'],
      stdin,
      env: {},
    }
  }
  if (agent === 'gemini') {
    return {
      args: ['-o', 'json', '--approval-mode', write ? 'auto_edit' : 'plan', ...model('-m'), ...extra],
      stdin,
      env: write ? { GEMINI_CLI_TRUST_WORKSPACE: 'true' } : {},
      ...(write ? {} : { unset: ['GEMINI_CLI_TRUST_WORKSPACE'] }),
    }
  }
  if (agent === 'antigravity') {
    return {
      args: ['--input-format', 'stream-json', '--output-format', 'stream-json', ...model('--model'), ...(write ? ['--dangerously-skip-permissions'] : ['--mode', 'plan']), ...extra, '-p='],
      stdin: `${JSON.stringify({ event: 'user', message: { content: options.prompt } })}\n`,
      env: {},
    }
  }
  return { args: ['run', '--format', 'json', ...(write ? [] : ['--agent', 'plan']), ...model('-m'), ...extra], stdin, env: {} }
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

function antigravityFailure(payload: Record<string, unknown>): string | undefined {
  const response = text(payload['response']) ?? ''
  if (response.trim().length > 0 && payload['status'] !== 'ERROR') return undefined
  const error = payload['error']
  if ((typeof error === 'string' && error.length > 0) || asRecord(error)) return errorMessage(error)
  if (payload['status'] === 'ERROR') return 'status ERROR'
  const denied = Array.isArray(payload['denied_actions']) ? payload['denied_actions'] : []
  if (denied.length > 0) {
    const names = denied.map((entry) => text(asRecord(entry)?.['action']) ?? JSON.stringify(entry)).join(', ')
    return `permission denied for ${names}`
  }
  return undefined
}

function parseAntigravity(stdout: string): { text: string; sessionId?: string } {
  let sessionId: string | undefined
  let payload: Record<string, unknown> | null = null
  for (const event of jsonLines(stdout)) {
    sessionId = text(event['conversation_id']) || sessionId
    if (event['event'] === 'result') payload = asRecord(event['result']) ?? payload
  }
  if (!payload) throw new HeadlessError('PARSE', 'antigravity', 'antigravity printed no result event', { stdout })
  sessionId = text(payload['conversation_id']) || sessionId
  const problem = antigravityFailure(payload)
  if (problem !== undefined) throw new HeadlessError('FAILED', 'antigravity', `antigravity reported an error: ${problem}`, { stdout })
  const answer = text(payload['response'])
  if (answer === undefined) throw new HeadlessError('PARSE', 'antigravity', 'antigravity result has no "response" field', { stdout })
  return sessionId ? { text: answer, sessionId } : { text: answer }
}

export function parseHeadlessOutput(agent: HeadlessAgent, stdout: string): { text: string; sessionId?: string } {
  if (!isHeadlessAgent(agent)) throw new HeadlessError('UNAVAILABLE', agent, `${String(agent)} is not a headless agent`, { stdout })
  if (agent === 'claude') {
    return parseSingle(agent, stdout, 'result', 'session_id', (payload) => (payload['is_error'] === true ? (text(payload['result']) ?? text(payload['subtype']) ?? 'error') : undefined))
  }
  if (agent === 'gemini') return parseSingle(agent, stdout, 'response', 'session_id', (payload) => (payload['error'] !== undefined && payload['response'] === undefined ? errorMessage(payload['error']) : undefined))
  if (agent === 'antigravity') return parseAntigravity(stdout)
  if (agent === 'codex') return parseCodex(stdout)
  return parseOpenCode(stdout)
}

function childEnv(agent: HeadlessAgent, bin: string, invocation: HeadlessInvocation, options: HeadlessOptions, ctx: PlatformContext): NodeJS.ProcessEnv {
  const inherited = headlessEnv(agent, { ...ctx.env, ...(options.env ?? {}) })
  const unset = new Set((invocation.unset ?? []).map((key) => key.toUpperCase()))
  for (const key of Object.keys(inherited)) {
    if (unset.has(ctx.platform === 'win32' ? key.toUpperCase() : key)) delete inherited[key]
  }
  const env: NodeJS.ProcessEnv = { ...inherited, ...invocation.env, ...(options.env ?? {}), KIT_HEADLESS: '1' }
  const key = pathKey(env)
  for (const other of Object.keys(env)) if (other !== key && other.toUpperCase() === 'PATH') delete env[other]
  const dir = (ctx.platform === 'win32' ? path.win32 : path.posix).dirname(bin)
  const delimiter = pathDelimiter(ctx)
  const current = (env[key] ?? '').split(delimiter).filter((entry) => entry.length > 0 && entry !== dir)
  env[key] = [dir, ...current].join(delimiter)
  return env
}

const liveGroups = new Set<number>()

function killLiveGroups(): void {
  for (const pid of liveGroups) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      continue
    }
  }
}

const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']

const signalHandlers = new Map<NodeJS.Signals, () => void>(
  FORWARDED_SIGNALS.map((signal) => [
    signal,
    () => {
      killLiveGroups()
      liveGroups.clear()
      releaseHandlers()
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal)
    },
  ]),
)

function releaseHandlers(): void {
  process.off('exit', killLiveGroups)
  for (const [signal, handler] of signalHandlers) process.off(signal, handler)
}

function trackGroup(pid: number): void {
  if (liveGroups.size === 0) {
    process.on('exit', killLiveGroups)
    for (const [signal, handler] of signalHandlers) process.on(signal, handler)
  }
  liveGroups.add(pid)
}

function untrackGroup(pid: number): void {
  if (!liveGroups.delete(pid)) return
  if (liveGroups.size === 0) releaseHandlers()
}

export function liveHeadlessGroups(): number[] {
  return [...liveGroups]
}

function killTree(child: ChildProcess, ctx: PlatformContext): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return
  const pid = child.pid
  if (ctx.platform === 'win32') {
    const taskkill = windowsSystemCommand('taskkill.exe', ctx)
    const killer = spawn(taskkill, ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, cwd: path.win32.dirname(taskkill) })
    killer.once('error', () => child.kill())
    return
  }
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-pid, name)
    } catch {
      child.kill(name)
    }
  }
  signal('SIGTERM')
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signal('SIGKILL')
  }, 3000).unref()
}

function stderrSummary(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
  return lines.find((line) => line.includes('Error')) ?? lines.at(-1) ?? ''
}

function checkArgumentPrompt(agent: HeadlessAgent, bin: string, invocation: HeadlessInvocation, prompt: string, ctx: PlatformContext): void {
  if (invocation.stdin !== undefined || ctx.platform !== 'win32' || !/\.(cmd|bat)$/i.test(bin)) return
  if (/[\r\n]/.test(prompt)) {
    throw new HeadlessError('FAILED', agent, `${agent} takes the prompt as an argument and ${path.win32.basename(bin)} goes through cmd.exe, which cuts the command line at the first line break`)
  }
  const line = spawnSpec(bin, invocation.args, ctx).args.at(-1) ?? ''
  if (line.length > WINDOWS_COMMAND_LINE_LIMIT) {
    throw new HeadlessError('PROMPT_TOO_LONG', agent, `${agent} takes the prompt as an argument and the escaped cmd.exe command line has ${line.length} characters; the limit is ${WINDOWS_COMMAND_LINE_LIMIT}`)
  }
}

export async function runHeadless(options: HeadlessOptions): Promise<HeadlessResult> {
  const ctx = options.ctx ?? platformContext()
  const agent = options.agent
  if (!isHeadlessAgent(agent)) throw new HeadlessError('UNAVAILABLE', agent, `${String(agent)} is not a headless agent; use one of ${HEADLESS_AGENTS.join(', ')}`)
  const bin = options.bin ?? (await findAgentBinary(agent, { ctx }))
  if (!bin) throw new HeadlessError('UNAVAILABLE', agent, `${agent} is not installed or not on PATH`)
  const invocation = headlessInvocation(agent, options)
  checkArgumentPrompt(agent, bin, invocation, options.prompt, ctx)
  if (!existsSync(options.cwd)) throw new HeadlessError('FAILED', agent, `working directory ${options.cwd} does not exist`)
  const spec = spawnSpec(bin, invocation.args, ctx)
  const env = childEnv(agent, bin, invocation, options, ctx)
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
      detached: ctx.platform !== 'win32',
    })
    let stdout = ''
    let stderr = ''
    let reason: 'timeout' | 'aborted' | 'overflow' | null = null
    let stdoutBytes = 0
    const maxOutputBytes = options.maxOutputBytes ?? HEADLESS_DEFAULT_MAX_OUTPUT_BYTES
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
    const group = ctx.platform !== 'win32' ? child.pid : undefined
    child.once('spawn', () => {
      if (group !== undefined) trackGroup(group)
      if (child.pid !== undefined) options.onSpawn?.(child.pid)
    })
    child.once('exit', () => {
      if (group !== undefined) untrackGroup(group)
    })
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      if (reason === 'overflow') return
      stdoutBytes += Buffer.byteLength(chunk)
      if (stdoutBytes > maxOutputBytes) {
        reason = 'overflow'
        killTree(child, ctx)
        return
      }
      stdout += chunk
    })
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.once('error', (error: NodeJS.ErrnoException) => {
      const code = error.code === 'E2BIG' ? 'PROMPT_TOO_LONG' : 'UNAVAILABLE'
      finish(() => reject(new HeadlessError(code, agent, `could not start ${bin}: ${error.message}`, { stdout, stderr })))
    })
    child.once('close', (code) => {
      finish(() => {
        const details = { exitCode: code, stdout, stderr }
        if (reason === 'timeout') return reject(new HeadlessError('TIMEOUT', agent, `${agent} did not finish within ${options.timeoutMs ?? HEADLESS_DEFAULT_TIMEOUT_MS} ms`, details))
        if (reason === 'aborted') return reject(new HeadlessError('FAILED', agent, `${agent} run was aborted`, details))
        if (reason === 'overflow') return reject(new HeadlessError('FAILED', agent, `${agent} printed more than ${maxOutputBytes} bytes on stdout and was stopped; raise maxOutputBytes if that much output is expected`, details))
        let parsed: { text: string; sessionId?: string }
        try {
          parsed = parseHeadlessOutput(agent, stdout)
        } catch (error) {
          if (code !== 0) {
            const detail = error instanceof HeadlessError && error.code === 'FAILED' ? error.message : stderrSummary(stderr)
            return reject(new HeadlessError('FAILED', agent, `${agent} exited with ${code}${detail ? `: ${detail}` : ''}`, details))
          }
          if (error instanceof HeadlessError) return reject(new HeadlessError(error.code, agent, error.message, details))
          return reject(error)
        }
        if (code !== 0) {
          const detail = stderrSummary(stderr)
          return reject(new HeadlessError('FAILED', agent, `${agent} exited with ${code}${detail ? `: ${detail}` : ''}`, details))
        }
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
  const requested = preferred !== undefined && preferred !== null
  if (requested && isHeadlessAgent(preferred)) {
    const bin = await findAgentBinary(preferred, { ctx })
    if (bin) return { agent: preferred, bin, fallback: false }
  }
  for (const agent of options.order ?? HEADLESS_AGENTS) {
    if (agent === preferred || !isHeadlessAgent(agent)) continue
    const bin = await findAgentBinary(agent, { ctx })
    if (bin) return { agent, bin, fallback: requested }
  }
  return null
}
