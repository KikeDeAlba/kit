import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { droppedWarning, parseClaudeArgs } from './args.ts'
import { describeFailure, errorMessage, remainingMs, resolveHarnessBin, runProcess } from './process.ts'
import { harnessEnv } from './profile-env.ts'
import { harnessBinEnvVars } from './registry.ts'
import { parseJsonLoose, retryInstructions, summaryContext, summaryInstructions, validateSessionSummary } from './summary.ts'
import { confinedFile, isRecord, parseJsonLines, pushTurn, readTextFile, textOfBlocks } from './transcript.ts'
import { DEFAULT_LAUNCH_OPTIONS, type HarnessAdapter, type LaunchOptions, type LaunchPlan, type SummaryInput, type SummaryResult, type TranscriptRef, type Turn } from './types.ts'

const LABEL = 'Gemini'
const DEFAULT_FLAG = '--approval-mode=yolo'
export const GEMINI_SUMMARY_DIR = 'bita-gemini-summary'
export const GEMINI_SUMMARY_SETTINGS = { hooksConfig: { enabled: false }, tools: { core: [] } } as const

function isApprovalFlag(token: string): boolean {
  return token === '-y' || token === '--yolo' || token === '--approval-mode' || token.startsWith('--approval-mode=')
}

function joinApprovalValue(args: readonly string[]): string[] {
  const joined: string[] = []
  for (let i = 0; i < args.length; i++) {
    const token = args[i] as string
    if (token === '--') {
      joined.push(...args.slice(i))
      break
    }
    const next = args[i + 1]
    if (token === '--approval-mode' && next !== undefined && !next.startsWith('-')) {
      joined.push(`--approval-mode=${next}`)
      i++
    } else joined.push(token)
  }
  return joined
}

function launchArgs(userArgs: readonly string[], options: LaunchOptions = DEFAULT_LAUNCH_OPTIONS): LaunchPlan {
  const parsed = parseClaudeArgs(joinApprovalValue(userArgs), isApprovalFlag)
  const approval = parsed.extra.length > 0 || !options.skipPermissions || options.extraArgs.some(isApprovalFlag) ? parsed.extra : [DEFAULT_FLAG]
  const resume = parsed.resume.kind === 'continue'
    ? ['--resume', 'latest']
    : parsed.resume.kind === 'resume'
      ? ['--resume', parsed.resume.id ?? 'latest']
      : []
  const prompt = parsed.prompt !== null ? [`--prompt-interactive=${parsed.prompt}`] : []
  return { args: [...approval, ...options.extraArgs, ...resume, ...prompt], warnings: parsed.extraFlags.map((flag) => droppedWarning(LABEL, flag)) }
}

function messageTurn(record: Record<string, unknown>): { role: Turn['role']; text: string } | null {
  const type = record['type']
  if (type !== 'user' && type !== 'gemini') return null
  const text = textOfBlocks(record['content'], (block) => block['thought'] !== true)
  return { role: type === 'user' ? 'user' : 'assistant', text }
}

function isMessageRecord(record: Record<string, unknown>): boolean {
  return typeof record['id'] === 'string' && typeof record['type'] === 'string' && !('$patch' in record)
}

export function parseGeminiChat(text: string): Turn[] {
  const messages = new Map<string, Record<string, unknown>>()
  const trimmed = text.trim()
  let legacy: unknown = undefined
  if (trimmed.startsWith('{') && !trimmed.includes('\n{')) {
    try {
      legacy = JSON.parse(trimmed) as unknown
    } catch {}
  }
  const records = isRecord(legacy) ? [legacy] : parseJsonLines(text)
  const applyPatch = (patch: unknown) => {
    if (!isRecord(patch) || typeof patch['id'] !== 'string') return
    const existing = messages.get(patch['id'])
    if (existing && 'content' in patch && patch['content'] !== undefined) existing['content'] = patch['content']
  }
  for (const record of records) {
    if (typeof record['$rewindTo'] === 'string') {
      const ids = [...messages.keys()]
      const index = ids.indexOf(record['$rewindTo'])
      if (index < 0) messages.clear()
      else for (const id of ids.slice(index)) messages.delete(id)
    } else if (isRecord(record['$patch'])) {
      const patch = record['$patch']
      applyPatch(patch)
      if (Array.isArray(patch['updates'])) for (const update of patch['updates']) applyPatch(update)
    } else if (Array.isArray(record['messages'])) {
      for (const message of record['messages']) {
        if (isRecord(message) && isMessageRecord(message)) messages.set(message['id'] as string, { ...message })
      }
    } else if (isMessageRecord(record)) messages.set(record['id'] as string, { ...record })
  }
  const turns: Turn[] = []
  for (const message of messages.values()) {
    const turn = messageTurn(message)
    if (turn) pushTurn(turns, turn.role, turn.text)
  }
  return turns
}

export const WINDOWS_PROMPT_POINTER = 'Follow the instructions at the start of the input and answer with the JSON they ask for.'

const REGISTRY_LOCK_ATTEMPTS = 20
const REGISTRY_LOCK_DELAY_MS = 50

async function prepareWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `${GEMINI_SUMMARY_DIR}-`))
  await mkdir(join(dir, '.gemini'))
  await writeFile(join(dir, '.gemini', 'settings.json'), JSON.stringify(GEMINI_SUMMARY_SETTINGS))
  return dir
}

export function geminiHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env['GEMINI_CLI_HOME'] || homedir(), '.gemini')
}

async function removeOwnedSlugs(home: string, owners: ReadonlySet<string>): Promise<void> {
  for (const base of [join(home, 'tmp'), join(home, 'history')]) {
    let names: string[]
    try {
      names = await readdir(base)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.startsWith(GEMINI_SUMMARY_DIR)) continue
      let owner: string
      try {
        owner = (await readFile(join(base, name, '.project_root'), 'utf8')).trim()
      } catch {
        continue
      }
      if (owners.has(owner)) await rm(join(base, name), { recursive: true, force: true })
    }
  }
}

async function acquireLock(lock: string): Promise<boolean> {
  for (let attempt = 0; attempt < REGISTRY_LOCK_ATTEMPTS; attempt++) {
    try {
      await mkdir(lock)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false
      await new Promise((resolve) => setTimeout(resolve, REGISTRY_LOCK_DELAY_MS))
    }
  }
  return false
}

async function dropRegistryEntries(file: string, owners: ReadonlySet<string>): Promise<void> {
  const lock = `${file}.lock`
  if (!(await acquireLock(lock))) return
  try {
    let data: unknown
    try {
      data = JSON.parse(await readFile(file, 'utf8')) as unknown
    } catch {
      return
    }
    if (!isRecord(data) || !isRecord(data['projects'])) return
    const projects = data['projects']
    const stale = Object.keys(projects).filter((key) => owners.has(key))
    if (stale.length === 0) return
    for (const key of stale) delete projects[key]
    const temp = `${file}.bita-${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(data, null, 2))
    await rename(temp, file)
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}

async function disposeWorkspace(dir: string, env: NodeJS.ProcessEnv): Promise<void> {
  const owners = new Set([dir])
  try {
    owners.add(await realpath(dir))
  } catch {}
  const home = geminiHomeDir(env)
  await removeOwnedSlugs(home, owners).catch(() => {})
  await dropRegistryEntries(join(home, 'projects.json'), owners).catch(() => {})
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

function extractResponse(stdout: string): { text: string } | { error: string } {
  const payload = parseJsonLoose(stdout)
  if (!isRecord(payload)) return { error: 'gemini returned invalid JSON' }
  const error = payload['error']
  if (isRecord(error)) return { error: `gemini failed: ${String(error['message'] ?? 'unknown error').slice(0, 400)}` }
  if (typeof payload['response'] !== 'string') return { error: 'gemini returned no response' }
  return { text: payload['response'] }
}

async function summarize(input: SummaryInput): Promise<SummaryResult> {
  let base: NodeJS.ProcessEnv
  try {
    base = await harnessEnv('gemini', input.profile, input.baseEnv)
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
  const bin = geminiAdapter.resolveBin(base)
  if (!bin) return { ok: false, error: 'gemini not found' }
  const model = input.model ?? geminiAdapter.defaultSummaryModel
  const deadline = Date.now() + input.timeoutMs
  let cwd: string
  try {
    cwd = await prepareWorkspace()
  } catch (error) {
    return { ok: false, error: `gemini workspace: ${errorMessage(error)}` }
  }
  const env = { ...base, GEMINI_CLI_TRUST_WORKSPACE: 'true' }
  try {
    const context = summaryContext(input)
    let instructions = summaryInstructions(input)
    let last: SummaryResult = { ok: false, error: 'gemini was not called' }
    for (let attempt = 0; attempt < 2; attempt++) {
      const viaCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)
      const prompt = viaCmd ? WINDOWS_PROMPT_POINTER : instructions
      const args = ['-m', model, '--approval-mode', 'plan', '-e', 'none', '-o', 'json', '-p', prompt]
      const stdin = viaCmd ? `${instructions}\n\n${context}` : context
      const result = await runProcess(bin, args, { input: stdin, env, cwd, timeoutMs: remainingMs(deadline) })
      if (result.timedOut) return { ok: false, error: describeFailure('gemini', result) }
      const response = extractResponse(result.stdout)
      if ('error' in response) return { ok: false, error: response.error.startsWith('gemini failed') || result.code === 0 ? response.error : describeFailure('gemini', result) }
      last = validateSessionSummary(parseJsonLoose(response.text), input.kinds)
      if (last.ok) return last
      instructions = retryInstructions(input, last.error)
    }
    return last
  } finally {
    await disposeWorkspace(cwd, env)
  }
}

export const geminiAdapter: HarnessAdapter = {
  id: 'gemini',
  label: LABEL,
  bin: 'gemini',
  defaultSummaryModel: 'flash-lite',
  profiles: false,
  resolveBin(env: NodeJS.ProcessEnv = process.env): string | null {
    return resolveHarnessBin(harnessBinEnvVars('gemini'), 'gemini', env, 'gemini')
  },
  available(env: NodeJS.ProcessEnv = process.env): boolean {
    return geminiAdapter.resolveBin(env) !== null
  },
  launchArgs,
  async extractTranscript(ref: TranscriptRef, baseEnv?: NodeJS.ProcessEnv): Promise<Turn[]> {
    if (!ref.transcriptPath) return []
    const file = await confinedFile(ref.transcriptPath, join(geminiHomeDir(baseEnv ?? process.env), 'tmp'))
    if (!file) return []
    const text = await readTextFile(file)
    return text === null ? [] : parseGeminiChat(text)
  },
  summarize,
}
