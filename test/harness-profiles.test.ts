import './isolate.ts'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { addProfile } from '../src/profiles.ts'
import { claudeProjectDir } from '../src/harness/claude.ts'
import { harnessEnv } from '../src/harness/profile-env.ts'
import { getAdapter, harnessBinEnvVar, harnessBinEnvVars, kitHarnessBinEnvVar, listAdapters } from '../src/harness/registry.ts'
import type { HarnessId, SummaryInput, TranscriptRef } from '../src/harness/types.ts'
import { createFakeBin, POSIX_ONLY, readFakeBinCalls } from './fake-bin.ts'
import { contextFor } from '../src/harness/process.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'kit-harness-profiles-')))
const config = join(root, 'config')
const baseEnv = (): NodeJS.ProcessEnv => ({ ...process.env, HOME: root, KIT_CONFIG_DIR: config })
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

const fixtures = join(import.meta.dirname, 'fixtures', 'harness')
const summary = { title: 'Revisar perfiles', kind: null, note: { context: 'c', done: 'd', decisions: null, findings: null, verification: null, pending: null } }

function ref(harness: HarnessId, overrides: Partial<TranscriptRef> = {}): TranscriptRef {
  return { harness, sessionId: null, transcriptPath: null, cwd: '/work/repo', startedAt: '2026-11-08T10:00:00.000Z', endedAt: '2026-11-08T11:00:00.000Z', profile: null, ...overrides }
}

test('every adapter says whether it supports profiles', () => {
  assert.deepEqual(Object.fromEntries(listAdapters().map((adapter) => [adapter.id, adapter.profiles])), { claude: true, opencode: false, codex: true, gemini: false, antigravity: false })
})

test('harnessEnv uses builtin semantics without a profile and applies envFor with one', async () => {
  const ctx = contextFor(baseEnv())
  const { profile } = await addProfile('work', ctx)
  const plain = await harnessEnv('claude', null, { ...baseEnv(), CLAUDECODE: '1', CLAUDE_CONFIG_DIR: '/inherited' })
  assert.equal(plain['CLAUDECODE'], undefined)
  assert.equal(plain['CLAUDE_CONFIG_DIR'], undefined)
  const env = await harnessEnv('claude', 'work', { ...baseEnv(), ANTHROPIC_API_KEY: 'x', BITA_CHILD: '1' })
  assert.equal(env['CLAUDE_CONFIG_DIR'], profile.claude)
  assert.equal(env['ANTHROPIC_API_KEY'], undefined)
  assert.equal(env['BITA_CHILD'], '1')
  assert.equal(env['DEN_PROFILE'], 'work')
  await assert.rejects(harnessEnv('claude', 'ghost', baseEnv()), /does not exist/)
})

test('claude reads the transcript from the projects dir of the session profile', async () => {
  const ctx = contextFor(baseEnv())
  const { profile } = await addProfile('work', ctx)
  const dir = claudeProjectDir('/work/repo', { CLAUDE_CONFIG_DIR: profile.claude as string })
  mkdirSync(dir, { recursive: true })
  copyFileSync(join(fixtures, 'claude-session.jsonl'), join(dir, 'sess-9.jsonl'))
  const withProfile = await getAdapter('claude').extractTranscript(ref('claude', { sessionId: 'sess-9', profile: 'work' }), baseEnv())
  assert.ok(withProfile.length > 0)
  const withoutProfile = await getAdapter('claude').extractTranscript(ref('claude', { sessionId: 'sess-9' }), baseEnv())
  assert.deepEqual(withoutProfile, [])
})

test('summarize runs with the profile account and reports a missing profile', { skip: POSIX_ONLY }, async () => {
  const ctx = contextFor(baseEnv())
  const { profile } = await addProfile('work', ctx)
  const dir = mkdtempSync(join(root, 'sum-'))
  const log = join(dir, 'calls.log')
  const input = (profileName: string | null): SummaryInput => ({
    turns: [{ role: 'user', text: 'hola' }],
    meta: { harness: 'claude', projectName: null, repo: null, branch: null, cwd: '/work/repo', durationSeconds: 60, touchedFiles: [] },
    kinds: [],
    model: null,
    timeoutMs: 20_000,
    profile: profileName,
    baseEnv: { ...baseEnv(), [kitHarnessBinEnvVar('claude')]: createFakeBin(dir, 'claude'), FAKE_BIN_LOG: log, FAKE_BIN_REPLY: JSON.stringify({ structured_output: summary }), ANTHROPIC_API_KEY: 'shell-key', CLAUDE_CONFIG_DIR: '/inherited' },
  })
  const result = await getAdapter('claude').summarize(input('work'))
  assert.equal(result.ok, true, JSON.stringify(result))
  const [call] = readFakeBinCalls(log)
  assert.equal(call?.env['CLAUDE_CONFIG_DIR'], profile.claude)
  assert.equal(call?.env['ANTHROPIC_API_KEY'], undefined)
  assert.equal(call?.env['DEN_PROFILE'], 'work')
  const missing = await getAdapter('claude').summarize(input('ghost'))
  assert.deepEqual(missing, { ok: false, error: 'profile "ghost" does not exist' })
  assert.equal(readFakeBinCalls(log).length, 1)
})

test('KIT_HARNESS_BIN_<ID> wins over BITA_HARNESS_BIN_<ID>', { skip: POSIX_ONLY }, () => {
  const dir = mkdtempSync(join(root, 'bins-'))
  const kit = createFakeBin(dir, 'kit-claude')
  const bita = createFakeBin(dir, 'bita-claude')
  assert.deepEqual(harnessBinEnvVars('claude'), ['KIT_HARNESS_BIN_CLAUDE', 'BITA_HARNESS_BIN_CLAUDE'])
  assert.equal(getAdapter('claude').resolveBin({ [harnessBinEnvVar('claude')]: bita, [kitHarnessBinEnvVar('claude')]: kit }), kit)
  assert.equal(getAdapter('claude').resolveBin({ [harnessBinEnvVar('claude')]: bita }), bita)
})

test('launch options drop the skip-permissions flag and put extraArgs before the user arguments', () => {
  const off = { skipPermissions: false, extraArgs: [] }
  const extra = { skipPermissions: true, extraArgs: ['--model', 'm'] }
  assert.deepEqual(getAdapter('claude').launchArgs(['hola'], off).args, ['hola'])
  assert.deepEqual(getAdapter('claude').launchArgs(['hola'], extra).args, ['--allow-dangerously-skip-permissions', '--model', 'm', 'hola'])
  assert.deepEqual(getAdapter('claude').launchArgs(['hola'], { skipPermissions: true, extraArgs: ['--dangerously-skip-permissions'] }).args, ['--dangerously-skip-permissions', 'hola'])
  assert.deepEqual(getAdapter('codex').launchArgs(['-c', 'sigue'], off).args, ['resume', '--last', '--', 'sigue'])
  assert.deepEqual(getAdapter('codex').launchArgs(['sigue'], extra).args, ['--dangerously-bypass-approvals-and-sandbox', '--model', 'm', '--', 'sigue'])
  assert.deepEqual(getAdapter('gemini').launchArgs(['x'], off).args, ['--prompt-interactive=x'])
  assert.deepEqual(getAdapter('gemini').launchArgs(['x'], { skipPermissions: true, extraArgs: ['--approval-mode=plan'] }).args, ['--approval-mode=plan', '--prompt-interactive=x'])
  assert.deepEqual(getAdapter('opencode').launchArgs(['x'], off).args, ['--prompt=x'])
  assert.deepEqual(getAdapter('opencode').launchArgs(['x'], extra).args, ['--auto', '--model', 'm', '--prompt=x'])
  assert.deepEqual(getAdapter('antigravity').launchArgs(['x'], off).args, ['--prompt-interactive=x'])
  assert.deepEqual(getAdapter('antigravity').launchArgs(['x'], extra).args, ['--dangerously-skip-permissions', '--model', 'm', '--prompt-interactive=x'])
  for (const adapter of listAdapters()) assert.deepEqual(adapter.launchArgs(['x']), adapter.launchArgs(['x'], { skipPermissions: true, extraArgs: [] }))
})
