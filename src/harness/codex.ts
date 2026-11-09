import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { droppedWarning, parseClaudeArgs } from './args.ts'
import { describeFailure, errorMessage, resolveHarnessBin, runProcess, withTempDir } from './process.ts'
import { harnessEnv } from './profile-env.ts'
import { harnessBinEnvVars } from './registry.ts'
import { SESSION_SUMMARY_SCHEMA, buildSummaryPrompt, parseJsonLoose, validateSessionSummary } from './summary.ts'
import { isRecord, mtimeMs, parseJsonLines, pushTurn, readTextFile, startsWithAny, textOfBlocks, walkFiles } from './transcript.ts'
import { DEFAULT_LAUNCH_OPTIONS, type HarnessAdapter, type LaunchOptions, type LaunchPlan, type SummaryInput, type SummaryResult, type TranscriptRef, type Turn } from './types.ts'

const LABEL = 'Codex'
const DEFAULT_FLAG = '--dangerously-bypass-approvals-and-sandbox'
const NOISE_PREFIXES = ['<environment_context', '<user_instructions', '# AGENTS.md'] as const
const LOCATE_GRACE_MS = 60_000

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env['CODEX_HOME'] || join(env['HOME'] || homedir(), '.codex')
}

export function parseCodexRollout(text: string): Turn[] {
  const turns: Turn[] = []
  for (const record of parseJsonLines(text)) {
    if (record['type'] !== 'response_item') continue
    const payload = record['payload']
    if (!isRecord(payload) || payload['type'] !== 'message') continue
    const role = payload['role']
    if (role !== 'user' && role !== 'assistant') continue
    const body = textOfBlocks(payload['content'], () => true)
    if (!body.trim()) continue
    if (role === 'user' && startsWithAny(body, NOISE_PREFIXES)) continue
    pushTurn(turns, role, body)
  }
  return turns
}

function rolloutCwd(text: string): string | null {
  for (const record of parseJsonLines(text.slice(0, 200_000))) {
    if (record['type'] !== 'session_meta') continue
    const payload = record['payload']
    if (isRecord(payload) && typeof payload['cwd'] === 'string') return payload['cwd']
  }
  return null
}

export async function locateCodexRollout(ref: TranscriptRef, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (ref.transcriptPath) return ref.transcriptPath
  const root = join(codexHome(env), 'sessions')
  if (ref.sessionId) {
    const suffix = `-${ref.sessionId}.jsonl`
    const matches = await walkFiles(root, (name) => name.startsWith('rollout-') && name.endsWith(suffix))
    return matches.sort().at(-1) ?? null
  }
  const from = Date.parse(ref.startedAt)
  const to = Date.parse(ref.endedAt) + LOCATE_GRACE_MS
  if (Number.isNaN(from) || Number.isNaN(to)) return null
  const candidates: { file: string; mtime: number }[] = []
  for (const file of await walkFiles(root, (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'))) {
    const mtime = await mtimeMs(file)
    if (mtime !== null && mtime >= from && mtime <= to) candidates.push({ file, mtime })
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  for (const candidate of candidates) {
    const text = await readTextFile(candidate.file)
    if (text !== null && rolloutCwd(text) === ref.cwd) return candidate.file
  }
  return null
}

function launchArgs(userArgs: readonly string[], options: LaunchOptions = DEFAULT_LAUNCH_OPTIONS): LaunchPlan {
  const parsed = parseClaudeArgs(userArgs)
  const head: string[] = []
  if (parsed.resume.kind === 'continue') head.push('resume', '--last')
  else if (parsed.resume.kind === 'resume') head.push('resume', ...(parsed.resume.id ? [parsed.resume.id] : []))
  const args = [...head, ...(options.skipPermissions && !options.extraArgs.includes(DEFAULT_FLAG) ? [DEFAULT_FLAG] : []), ...options.extraArgs, ...(parsed.prompt !== null ? ['--', parsed.prompt] : [])]
  return { args, warnings: parsed.extraFlags.map((flag) => droppedWarning(LABEL, flag)) }
}

async function summarize(input: SummaryInput): Promise<SummaryResult> {
  let env: NodeJS.ProcessEnv
  try {
    env = await harnessEnv('codex', input.profile, input.baseEnv)
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
  const bin = codexAdapter.resolveBin(env)
  if (!bin) return { ok: false, error: 'codex not found' }
  const model = input.model ?? codexAdapter.defaultSummaryModel
  return withTempDir('bita-summary-codex-', async (dir) => {
    const schemaPath = join(dir, 'schema.json')
    const outputPath = join(dir, 'output.json')
    await writeFile(schemaPath, JSON.stringify(SESSION_SUMMARY_SCHEMA))
    const args = [
      'exec',
      '--ephemeral',
      '-s',
      'read-only',
      '--skip-git-repo-check',
      '--disable',
      'hooks',
      '-m',
      model,
      '-c',
      'model_reasoning_effort=low',
      '--output-schema',
      schemaPath,
      '-o',
      outputPath,
      '-',
    ]
    const result = await runProcess(bin, args, { input: buildSummaryPrompt(input), env, cwd: dir, timeoutMs: input.timeoutMs })
    if (result.timedOut || result.code !== 0) return { ok: false, error: describeFailure('codex', result) }
    let output: string
    try {
      output = await readFile(outputPath, 'utf8')
    } catch (error) {
      return { ok: false, error: `codex wrote no output: ${errorMessage(error)}` }
    }
    return validateSessionSummary(parseJsonLoose(output), input.kinds)
  })
}

export const codexAdapter: HarnessAdapter = {
  id: 'codex',
  label: LABEL,
  bin: 'codex',
  defaultSummaryModel: 'gpt-5.6-luna',
  profiles: true,
  resolveBin(env: NodeJS.ProcessEnv = process.env): string | null {
    return resolveHarnessBin(harnessBinEnvVars('codex'), 'codex', env, 'codex')
  },
  available(env: NodeJS.ProcessEnv = process.env): boolean {
    return codexAdapter.resolveBin(env) !== null
  },
  launchArgs,
  async extractTranscript(ref: TranscriptRef, baseEnv?: NodeJS.ProcessEnv): Promise<Turn[]> {
    const file = await locateCodexRollout(ref, await harnessEnv('codex', ref.profile, baseEnv))
    if (!file) return []
    const text = await readTextFile(file)
    return text === null ? [] : parseCodexRollout(text)
  },
  summarize,
}
