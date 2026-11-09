import { homedir } from 'node:os'
import { join } from 'node:path'
import { CLAUDE_SKIP_PERMISSION_FLAGS, withDefaultFlag } from './args.ts'
import { describeFailure, errorMessage, resolveHarnessBin, runProcess, withTempDir } from './process.ts'
import { harnessEnv } from './profile-env.ts'
import { harnessBinEnvVars } from './registry.ts'
import { SESSION_SUMMARY_SCHEMA, buildSummaryPrompt, validateSessionSummary } from './summary.ts'
import { confinedFile, isRecord, isSessionId, parseJsonLines, pushTurn, readTextFile, startsWithAny, textOfBlocks } from './transcript.ts'
import { DEFAULT_LAUNCH_OPTIONS, type HarnessAdapter, type LaunchOptions, type LaunchPlan, type SummaryInput, type SummaryResult, type TranscriptRef, type Turn } from './types.ts'

const NOISE_PREFIXES = ['<command-name>', '<local-command-', '<system-reminder>'] as const

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env['CLAUDE_CONFIG_DIR'] || join(env['HOME'] || homedir(), '.claude')
}

export function claudeProjectDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(claudeConfigDir(env), 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
}

export function claudeTranscriptPath(ref: TranscriptRef, env: NodeJS.ProcessEnv = process.env): string | null {
  if (ref.transcriptPath) return ref.transcriptPath
  if (!isSessionId(ref.sessionId)) return null
  return join(claudeProjectDir(ref.cwd, env), `${ref.sessionId}.jsonl`)
}

export function parseClaudeTranscript(text: string): Turn[] {
  const turns: Turn[] = []
  for (const record of parseJsonLines(text)) {
    const type = record['type']
    if (type !== 'user' && type !== 'assistant') continue
    if (record['isMeta'] === true || record['isSidechain'] === true) continue
    const message = record['message']
    if (!isRecord(message)) continue
    const body = textOfBlocks(message['content'], (block) => block['type'] === 'text')
    if (!body.trim() || startsWithAny(body, NOISE_PREFIXES)) continue
    pushTurn(turns, type, body)
  }
  return turns
}

async function summarize(input: SummaryInput): Promise<SummaryResult> {
  let env: NodeJS.ProcessEnv
  try {
    env = await harnessEnv('claude', input.profile, input.baseEnv)
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
  const bin = claudeAdapter.resolveBin(env)
  if (!bin) return { ok: false, error: 'claude not found' }
  const model = input.model ?? claudeAdapter.defaultSummaryModel
  const args = [
    '-p',
    '--model',
    model,
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(SESSION_SUMMARY_SCHEMA),
    '--tools',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--max-turns',
    '2',
    '--settings',
    '{"disableAllHooks":true}',
  ]
  return withTempDir('bita-summary-claude-', async (dir) => {
    const result = await runProcess(bin, args, { input: buildSummaryPrompt(input), env, cwd: dir, timeoutMs: input.timeoutMs })
    if (result.timedOut) return { ok: false, error: describeFailure('claude', result) }
    let parsed: unknown
    try {
      parsed = JSON.parse(result.stdout)
    } catch (error) {
      return { ok: false, error: result.code === 0 ? `claude returned invalid JSON: ${errorMessage(error)}` : describeFailure('claude', result) }
    }
    if (!isRecord(parsed)) return { ok: false, error: 'claude returned an unexpected payload' }
    if (parsed['is_error'] === true || result.code !== 0) {
      const detail = typeof parsed['result'] === 'string' ? parsed['result'] : String(parsed['subtype'] ?? 'error')
      return { ok: false, error: `claude failed: ${detail.slice(0, 400)}` }
    }
    if (!('structured_output' in parsed) || parsed['structured_output'] === null) return { ok: false, error: 'claude returned no structured_output' }
    return validateSessionSummary(parsed['structured_output'], input.kinds)
  })
}

export const claudeAdapter: HarnessAdapter = {
  id: 'claude',
  label: 'Claude',
  bin: 'claude',
  defaultSummaryModel: 'haiku',
  profiles: true,
  resolveBin(env: NodeJS.ProcessEnv = process.env): string | null {
    return resolveHarnessBin(harnessBinEnvVars('claude'), 'claude', env, 'claude')
  },
  available(env: NodeJS.ProcessEnv = process.env): boolean {
    return claudeAdapter.resolveBin(env) !== null
  },
  launchArgs(userArgs: readonly string[], options: LaunchOptions = DEFAULT_LAUNCH_OPTIONS): LaunchPlan {
    const args = [...options.extraArgs, ...userArgs]
    if (!options.skipPermissions) return { args, warnings: [] }
    return withDefaultFlag(CLAUDE_SKIP_PERMISSION_FLAGS[0], args, (token) => (CLAUDE_SKIP_PERMISSION_FLAGS as readonly string[]).includes(token))
  },
  async extractTranscript(ref: TranscriptRef, baseEnv?: NodeJS.ProcessEnv): Promise<Turn[]> {
    const env = await harnessEnv('claude', ref.profile, baseEnv)
    const candidate = claudeTranscriptPath(ref, env)
    const file = candidate === null ? null : await confinedFile(candidate, join(claudeConfigDir(env), 'projects'))
    if (!file) return []
    const text = await readTextFile(file)
    return text === null ? [] : parseClaudeTranscript(text)
  },
  summarize,
}
