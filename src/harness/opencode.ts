import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { droppedWarning, parseClaudeArgs } from './args.ts'
import { describeFailure, errorMessage, remainingMs, resolveHarnessBin, runProcess, withTempDir } from './process.ts'
import { harnessEnv } from './profile-env.ts'
import { harnessBinEnvVars } from './registry.ts'
import { parseJsonLoose, retryInstructions, summaryContext, summaryInstructions, validateSessionSummary } from './summary.ts'
import { isRecord, parseJsonLines, pushTurn, textOfBlocks } from './transcript.ts'
import { DEFAULT_LAUNCH_OPTIONS, type HarnessAdapter, type LaunchOptions, type LaunchPlan, type SummaryInput, type SummaryResult, type TranscriptRef, type Turn } from './types.ts'

const LABEL = 'OpenCode'
const DEFAULT_FLAG = '--auto'
const EXPORT_TIMEOUT_MS = 60_000
const DELETE_TIMEOUT_MS = 15_000

function launchArgs(userArgs: readonly string[], options: LaunchOptions = DEFAULT_LAUNCH_OPTIONS): LaunchPlan {
  const parsed = parseClaudeArgs(userArgs)
  const warnings: string[] = []
  const resume: string[] = []
  if (parsed.resume.kind === 'continue') resume.push('--continue')
  else if (parsed.resume.kind === 'resume') {
    if (parsed.resume.id) resume.push('--session', parsed.resume.id)
    else warnings.push(droppedWarning(LABEL, '--resume'))
  }
  const prompt = parsed.prompt !== null ? [`--prompt=${parsed.prompt}`] : []
  warnings.push(...parsed.extraFlags.map((flag) => droppedWarning(LABEL, flag)))
  return { args: [...(options.skipPermissions ? [DEFAULT_FLAG] : []), ...options.extraArgs, ...resume, ...prompt], warnings }
}

function legacyMessageTurn(message: Record<string, unknown>): { role: Turn['role']; text: string } | null {
  const info = message['info']
  if (!isRecord(info)) return null
  const role = info['role']
  if (role !== 'user' && role !== 'assistant') return null
  const text = textOfBlocks(message['parts'], (part) => part['type'] === 'text' && part['synthetic'] !== true && part['ignored'] !== true)
  return { role, text }
}

export function parseOpenCodeExport(text: string): Turn[] {
  const start = text.indexOf('{')
  if (start < 0) return []
  let data: unknown
  try {
    data = JSON.parse(text.slice(start)) as unknown
  } catch {
    return []
  }
  if (!isRecord(data) || !Array.isArray(data['messages'])) return []
  const turns: Turn[] = []
  for (const message of data['messages']) {
    if (!isRecord(message)) continue
    const type = message['type']
    if (type === 'user') pushTurn(turns, 'user', typeof message['text'] === 'string' ? message['text'] : '')
    else if (type === 'assistant') pushTurn(turns, 'assistant', textOfBlocks(message['content'], (block) => block['type'] === 'text'))
    else if (type === undefined) {
      const turn = legacyMessageTurn(message)
      if (turn) pushTurn(turns, turn.role, turn.text)
    }
  }
  return turns
}

export function parseOpenCodeEvents(stdout: string): { sessionIds: string[]; text: string | null } {
  const sessionIds: string[] = []
  let text: string | null = null
  for (const event of parseJsonLines(stdout)) {
    const sessionId = event['sessionID']
    if (typeof sessionId === 'string' && !sessionIds.includes(sessionId)) sessionIds.push(sessionId)
    const part = event['part']
    if (!isRecord(part) || typeof part['text'] !== 'string') continue
    if (event['type'] === 'text' || part['type'] === 'text') text = part['text']
  }
  return { sessionIds, text }
}

async function summarize(input: SummaryInput): Promise<SummaryResult> {
  let base: NodeJS.ProcessEnv
  try {
    base = await harnessEnv('opencode', input.profile, input.baseEnv)
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
  const bin = opencodeAdapter.resolveBin(base)
  if (!bin) return { ok: false, error: 'opencode not found' }
  const model = input.model ?? opencodeAdapter.defaultSummaryModel
  const deadline = Date.now() + input.timeoutMs
  return withTempDir('bita-summary-opencode-', async (dir) => {
    const configDir = join(dir, 'config')
    const transcriptFile = join(dir, 'transcript.txt')
    try {
      await mkdir(configDir)
      await writeFile(transcriptFile, summaryContext(input))
    } catch (error) {
      return { ok: false, error: `opencode workspace: ${errorMessage(error)}` }
    }
    const env = { ...base, OPENCODE_CONFIG_DIR: configDir }
    const sessions: string[] = []
    let instructions = summaryInstructions(input)
    let last: SummaryResult = { ok: false, error: 'opencode was not called' }
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const args = ['run', '--standalone', '--format', 'json', '-m', model, '-f', transcriptFile]
        const result = await runProcess(bin, args, { input: instructions, env, cwd: dir, timeoutMs: remainingMs(deadline) })
        const events = parseOpenCodeEvents(result.stdout)
        for (const id of events.sessionIds) if (!sessions.includes(id)) sessions.push(id)
        if (result.timedOut || result.code !== 0) return { ok: false, error: describeFailure('opencode', result) }
        if (events.text === null) return { ok: false, error: 'opencode returned no text' }
        last = validateSessionSummary(parseJsonLoose(events.text), input.kinds)
        if (last.ok) return last
        instructions = retryInstructions(input, last.error)
      }
      return last
    } finally {
      for (const id of sessions) {
        await runProcess(bin, ['session', 'delete', '--standalone', id], { env, cwd: dir, timeoutMs: DELETE_TIMEOUT_MS })
      }
    }
  })
}

export const opencodeAdapter: HarnessAdapter = {
  id: 'opencode',
  label: LABEL,
  bin: 'opencode',
  defaultSummaryModel: 'openai/gpt-5.6-luna',
  profiles: false,
  resolveBin(env: NodeJS.ProcessEnv = process.env): string | null {
    return resolveHarnessBin(harnessBinEnvVars('opencode'), 'opencode', env, 'opencode')
  },
  available(env: NodeJS.ProcessEnv = process.env): boolean {
    return opencodeAdapter.resolveBin(env) !== null
  },
  launchArgs,
  async extractTranscript(ref: TranscriptRef, baseEnv?: NodeJS.ProcessEnv): Promise<Turn[]> {
    if (!ref.sessionId) return []
    const env = await harnessEnv('opencode', ref.profile, baseEnv)
    const bin = opencodeAdapter.resolveBin(env)
    if (!bin) return []
    const sessionId = ref.sessionId
    return withTempDir('bita-opencode-export-', async (dir) => {
      const result = await runProcess(bin, ['session', 'export', '--standalone', sessionId], {
        env,
        cwd: ref.cwd,
        timeoutMs: EXPORT_TIMEOUT_MS,
        stdoutPath: join(dir, 'export.json'),
      })
      if (result.timedOut || result.code !== 0) return []
      return parseOpenCodeExport(result.stdout)
    }).catch(() => [])
  },
  summarize,
}
