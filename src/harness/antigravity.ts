import { realpathSync } from 'node:fs'
import { mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runHeadless } from '../agents/headless.ts'
import { CLAUDE_SKIP_PERMISSION_FLAGS, droppedWarning, parseClaudeArgs } from './args.ts'
import { contextFor, errorMessage, homeOf, remainingMs, resolveHarnessBin } from './process.ts'
import { confinedTranscript, conversationFile, isConversationId } from './antigravity-ids.ts'
import { protoString } from './protobuf.ts'
import { harnessEnv } from './profile-env.ts'
import { harnessBinEnvVars } from './registry.ts'
import { parseJsonLoose, retryInstructions, summaryContext, summaryInstructions, validateSessionSummary } from './summary.ts'
import { parseJsonLines, pushTurn } from './transcript.ts'
import { DEFAULT_LAUNCH_OPTIONS, type ExitRef, type ExitSession, type HarnessAdapter, type LaunchOptions, type LaunchPlan, type SummaryInput, type SummaryResult, type TranscriptRef, type Turn } from './types.ts'

const LABEL = 'Antigravity'
const SKIP_FLAG = CLAUDE_SKIP_PERMISSION_FLAGS[1]
const VALUE_FLAGS = ['--model', '--mode', '--agent', '--effort', '--add-dir', '--project', '--log-file']
const BOOLEAN_FLAGS = ['--sandbox', '--new-project', '--remote-control', '--disable-slash-commands']
const HISTORY_SLACK_MS = 1_000
const USER_STEP = 14
const ASSISTANT_STEP = 15
const USER_TEXT_PATH = [19, 2] as const
const ASSISTANT_TEXT_PATH = [20, 1] as const
export const HISTORY_TAIL_BYTES = 2 * 1024 * 1024
export const MAX_STEPS = 20_000

export { ANTIGRAVITY_CONVERSATION_ENV } from './env.ts'

export function antigravityHome(env: NodeJS.ProcessEnv = process.env): string {
  return join(homeOf(env), '.gemini', 'antigravity-cli')
}

export function antigravityConversationPath(conversationId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  return conversationFile(antigravityHome(env), conversationId)
}

export async function readHistoryTail(file: string, maxBytes: number = HISTORY_TAIL_BYTES): Promise<string | null> {
  let handle
  try {
    handle = await open(file, 'r')
  } catch {
    return null
  }
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    const text = buffer.toString('utf8')
    if (length === size) return text
    const firstBreak = text.indexOf('\n')
    return firstBreak < 0 ? '' : text.slice(firstBreak + 1)
  } catch {
    return null
  } finally {
    await handle.close()
  }
}

function isKeptFlag(token: string): boolean {
  if (BOOLEAN_FLAGS.includes(token)) return true
  return VALUE_FLAGS.some((flag) => token.startsWith(`${flag}=`))
}

function joinValueFlags(args: readonly string[]): string[] {
  const joined: string[] = []
  for (let i = 0; i < args.length; i++) {
    const token = args[i] as string
    if (token === '--') {
      joined.push(...args.slice(i))
      break
    }
    const next = args[i + 1]
    if (VALUE_FLAGS.includes(token) && next !== undefined && !next.startsWith('-')) {
      joined.push(`${token}=${next}`)
      i++
    } else joined.push(token)
  }
  return joined
}

function launchArgs(userArgs: readonly string[], options: LaunchOptions = DEFAULT_LAUNCH_OPTIONS): LaunchPlan {
  const parsed = parseClaudeArgs(joinValueFlags(userArgs), isKeptFlag)
  const resume = parsed.resume.kind === 'continue'
    ? ['-c']
    : parsed.resume.kind === 'resume'
      ? parsed.resume.id
        ? ['--conversation', parsed.resume.id]
        : ['-c']
      : []
  const prompt = parsed.prompt !== null ? [`--prompt-interactive=${parsed.prompt}`] : []
  return {
    args: [...(options.skipPermissions ? [SKIP_FLAG] : []), ...options.extraArgs, ...parsed.extra, ...resume, ...prompt],
    warnings: parsed.extraFlags.map((flag) => droppedWarning(LABEL, flag)),
  }
}

async function workspaceKeys(cwd: string, platform: NodeJS.Platform = process.platform): Promise<Set<string>> {
  const keys = new Set([cwd])
  try {
    keys.add(await realpath(cwd))
  } catch {}
  try {
    keys.add(realpathSync.native(cwd))
  } catch {}
  return platform === 'win32' ? new Set([...keys].map((key) => key.replace(/\//g, '\\').toLowerCase())) : keys
}

function workspaceKey(workspace: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? workspace.replace(/\//g, '\\').toLowerCase() : workspace
}

export async function findExitConversation(ref: ExitRef, env: NodeJS.ProcessEnv = process.env): Promise<ExitSession | null> {
  const text = await readHistoryTail(join(antigravityHome(env), 'history.jsonl'))
  if (text === null) return null
  const from = Date.parse(ref.startedAt) - HISTORY_SLACK_MS
  if (Number.isNaN(from)) return null
  const workspaces = await workspaceKeys(ref.cwd)
  let latest: { id: string; at: number } | null = null
  for (const record of parseJsonLines(text)) {
    const id = record['conversationId']
    const at = record['timestamp']
    const workspace = record['workspace']
    if (!isConversationId(id) || typeof at !== 'number' || typeof workspace !== 'string') continue
    if (at < from || !workspaces.has(workspaceKey(workspace))) continue
    if (!latest || at >= latest.at) latest = { id, at }
  }
  if (!latest) return null
  const transcriptPath = antigravityConversationPath(latest.id, env)
  return transcriptPath ? { sessionId: latest.id, transcriptPath } : null
}

function stepText(stepType: number, payload: Uint8Array): { role: Turn['role']; text: string } | null {
  if (stepType === USER_STEP) {
    const text = protoString(payload, USER_TEXT_PATH)
    return text === null ? null : { role: 'user', text }
  }
  if (stepType === ASSISTANT_STEP) {
    const text = protoString(payload, ASSISTANT_TEXT_PATH)
    return text === null ? null : { role: 'assistant', text }
  }
  return null
}

export class ConversationReadError extends Error {}

export async function readAntigravityConversation(file: string): Promise<Turn[]> {
  const { DatabaseSync } = await import('node:sqlite')
  let db: InstanceType<typeof DatabaseSync>
  try {
    db = new DatabaseSync(file, { readOnly: true })
  } catch (error) {
    throw new ConversationReadError(`cannot open the antigravity conversation ${file}: ${errorMessage(error)}`)
  }
  try {
    let rows: { step_type: unknown; step_payload: unknown }[]
    try {
      rows = db.prepare('SELECT step_type, step_payload FROM steps ORDER BY idx LIMIT ?').all(MAX_STEPS) as typeof rows
    } catch (error) {
      throw new ConversationReadError(`cannot read the steps of ${file}: ${errorMessage(error)}`)
    }
    const turns: Turn[] = []
    for (const row of rows) {
      if (typeof row.step_type !== 'number' || !(row.step_payload instanceof Uint8Array)) continue
      const turn = stepText(row.step_type, row.step_payload)
      if (turn) pushTurn(turns, turn.role, turn.text)
    }
    return turns
  } finally {
    db.close()
  }
}

async function summarize(input: SummaryInput): Promise<SummaryResult> {
  let env: NodeJS.ProcessEnv
  try {
    env = await harnessEnv('antigravity', input.profile, input.baseEnv)
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
  const bin = antigravityAdapter.resolveBin(env)
  if (!bin) return { ok: false, error: 'agy not found' }
  const model = input.model ?? antigravityAdapter.defaultSummaryModel
  const ctx = contextFor(env)
  const deadline = Date.now() + input.timeoutMs
  let cwd: string
  try {
    cwd = await mkdtemp(join(tmpdir(), 'bita-summary-antigravity-'))
  } catch (error) {
    return { ok: false, error: `antigravity workspace: ${errorMessage(error)}` }
  }
  try {
    const context = summaryContext(input)
    let instructions = summaryInstructions(input)
    let last: SummaryResult = { ok: false, error: 'agy was not called' }
    for (let attempt = 0; attempt < 2; attempt++) {
      let text: string
      try {
        const result = await runHeadless({
          agent: 'antigravity',
          bin,
          prompt: `${instructions}\n\n${context}`,
          cwd,
          access: 'read',
          model,
          timeoutMs: remainingMs(deadline),
          ctx,
        })
        text = result.text
      } catch (error) {
        return { ok: false, error: `agy failed: ${errorMessage(error).slice(0, 400)}` }
      }
      last = validateSessionSummary(parseJsonLoose(text), input.kinds)
      if (last.ok) return last
      instructions = retryInstructions(input, last.error)
    }
    return last
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {})
  }
}

export const antigravityAdapter: HarnessAdapter = {
  id: 'antigravity',
  label: LABEL,
  bin: 'agy',
  defaultSummaryModel: 'gemini-3.8-flash-low',
  profiles: false,
  resolveBin(env: NodeJS.ProcessEnv = process.env): string | null {
    return resolveHarnessBin(harnessBinEnvVars('antigravity'), 'agy', env, 'antigravity')
  },
  available(env: NodeJS.ProcessEnv = process.env): boolean {
    return antigravityAdapter.resolveBin(env) !== null
  },
  launchArgs,
  async extractTranscript(ref: TranscriptRef, baseEnv?: NodeJS.ProcessEnv): Promise<Turn[]> {
    const env = await harnessEnv('antigravity', ref.profile, baseEnv)
    const fromId = ref.sessionId ? antigravityConversationPath(ref.sessionId, env) : null
    const file = fromId ?? (ref.transcriptPath ? confinedTranscript(antigravityHome(env), ref.transcriptPath) : null)
    if (!file) return []
    return readAntigravityConversation(file)
  },
  summarize,
  afterExit(ref: ExitRef, env: NodeJS.ProcessEnv = process.env): Promise<ExitSession | null> {
    return findExitConversation(ref, env).catch(() => null)
  },
}
