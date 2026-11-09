import './isolate.ts'
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { ANTIGRAVITY_SESSION_ENV, HARNESS_SESSION_ENV, withoutHarnessSession } from '../src/harness/env.ts'
import { harnessEnv } from '../src/harness/profile-env.ts'
import { contextFor } from '../src/harness/process.ts'
import { getAdapter, harnessBinEnvVar, harnessBinEnvVars, kitHarnessBinEnvVar, listAdapters } from '../src/harness/registry.ts'
import { DEFAULT_LAUNCH_OPTIONS, HARNESS_IDS, type HarnessId, type LaunchOptions } from '../src/harness/types.ts'
import { addProfile, renameBuiltinProfile } from '../src/profiles.ts'
import { createFakeBin, POSIX_ONLY } from './fake-bin.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'kit-harness-launch-')))
const config = join(root, 'config')
const baseEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ PATH: process.env['PATH'] ?? '', HOME: root, KIT_CONFIG_DIR: config, ...extra })
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

function withPrompt(harnessArgs: readonly string[], prompt: string): string[] {
  return harnessArgs.includes('--') ? [...harnessArgs, prompt] : [...harnessArgs, '--', prompt]
}

const tails: Record<HarnessId, (text: string) => string[]> = {
  claude: (text) => ['--', text],
  codex: (text) => ['--', text],
  opencode: (text) => [`--prompt=${text}`],
  gemini: (text) => [`--prompt-interactive=${text}`],
  antigravity: (text) => [`--prompt-interactive=${text}`],
}

const optionSets: Record<string, LaunchOptions> = {
  defaults: DEFAULT_LAUNCH_OPTIONS,
  'no skip': { skipPermissions: false, extraArgs: [] },
  'extra args': { skipPermissions: true, extraArgs: ['--zzz-extra', 'value'] },
  'no skip and extra args': { skipPermissions: false, extraArgs: ['--zzz-extra'] },
}

test('a prompt that looks like a flag or a subcommand always reaches the agent as text, with any launch options', () => {
  const hostile = ['-x', '--x', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-skip-permissions', 'resume', 'exec', '--', '-- --help']
  for (const adapter of listAdapters()) {
    const tail = tails[adapter.id]
    for (const [label, options] of Object.entries(optionSets)) {
      for (const text of hostile) {
        for (const resume of [[], ['-c'], ['-r', 'abc']]) {
          const args = adapter.launchArgs(withPrompt(resume, text), options).args
          const want = tail(text)
          const where = `${adapter.id} [${label}] ${resume.join(' ')} ${text}`
          assert.deepEqual(args.slice(-want.length), want, where)
          assert.deepEqual(args.slice(0, -want.length), adapter.launchArgs(resume, options).args, where)
        }
      }
    }
  }
})

test('skipPermissions=false removes the default flag and nothing else, for every adapter', () => {
  for (const adapter of listAdapters()) {
    const withFlag = adapter.launchArgs(['-c']).args
    const without = adapter.launchArgs(['-c'], { skipPermissions: false, extraArgs: [] }).args
    assert.equal(without.length, withFlag.length - 1, adapter.id)
    const removed = withFlag.filter((arg) => !without.includes(arg))
    assert.equal(removed.length, 1, adapter.id)
    assert.match(removed[0] as string, /skip|bypass|yolo|--auto/, adapter.id)
    assert.deepEqual(adapter.launchArgs([], { skipPermissions: false, extraArgs: [] }).args, [], adapter.id)
    assert.deepEqual(adapter.launchArgs([], DEFAULT_LAUNCH_OPTIONS), adapter.launchArgs([]), adapter.id)
  }
})

test('extraArgs always land before the resume and prompt arguments and keep their order', () => {
  for (const adapter of listAdapters()) {
    const args = adapter.launchArgs(withPrompt(['-c'], 'hello'), { skipPermissions: false, extraArgs: ['--one', 'two', '--three=3'] }).args
    const at = args.indexOf('--one')
    assert.notEqual(at, -1, adapter.id)
    assert.deepEqual(args.slice(at, at + 3), ['--one', 'two', '--three=3'], adapter.id)
    const promptAt = args.findIndex((arg) => arg === 'hello' || arg.endsWith('=hello'))
    assert.ok(promptAt > at + 2, `${adapter.id} ${args.join(' ')}`)
    assert.equal(args.filter((arg) => arg === '--one').length, 1, adapter.id)
  }
})

test('extraArgs equal to the default flag are not repeated when skipPermissions is on', () => {
  for (const adapter of listAdapters()) {
    const flag = adapter.launchArgs([]).args[0] as string
    const args = adapter.launchArgs([], { skipPermissions: true, extraArgs: [flag] }).args
    assert.equal(args.filter((arg) => arg === flag).length, 1, `${adapter.id}: ${args.join(' ')}`)
  }
})

test('launch options never mutate the shared defaults', () => {
  const before = JSON.stringify(DEFAULT_LAUNCH_OPTIONS)
  for (const adapter of listAdapters()) {
    adapter.launchArgs(['-c', 'x'])
    adapter.launchArgs(['-c', 'x'], { skipPermissions: false, extraArgs: ['--a'] })
  }
  assert.equal(JSON.stringify(DEFAULT_LAUNCH_OPTIONS), before)
})

test('harnessEnv gives each adapter only the home it understands and always strips sessions', async () => {
  const ctx = contextFor(baseEnv())
  const { profile } = await addProfile('work', ctx)
  const dirty = baseEnv({ CLAUDE_CONFIG_DIR: '/x/claude', CODEX_HOME: '/x/codex', ANTHROPIC_API_KEY: 'k', DEN_PROFILE: 'other', BITA_CHILD: '1' })
  for (const name of [...HARNESS_SESSION_ENV, ...ANTIGRAVITY_SESSION_ENV]) dirty[name] = 's'
  const expected: Record<HarnessId, [string | undefined, string | undefined]> = {
    claude: [profile.claude as string, undefined],
    codex: [undefined, profile.codex as string],
    opencode: [undefined, undefined],
    gemini: [undefined, undefined],
    antigravity: [undefined, undefined],
  }
  for (const id of HARNESS_IDS) {
    const env = await harnessEnv(id, 'work', dirty)
    assert.equal(env['CLAUDE_CONFIG_DIR'], expected[id][0], id)
    assert.equal(env['CODEX_HOME'], expected[id][1], id)
    assert.equal(env['DEN_PROFILE'], 'work', id)
    assert.equal(env['BITA_CHILD'], '1', id)
    for (const name of [...HARNESS_SESSION_ENV, ...ANTIGRAVITY_SESSION_ENV]) assert.equal(env[name], undefined, `${id} ${name}`)
  }
})

test('harnessEnv for the builtin profile drops an inherited home but keeps tokens', async () => {
  const ctx = contextFor(baseEnv())
  const { profile } = await addProfile('other', ctx)
  assert.ok(profile)
  await renameBuiltinProfile('main', ctx)
  const env = await harnessEnv('claude', 'main', baseEnv({ CLAUDE_CONFIG_DIR: '/inherited', CODEX_HOME: '/inherited', ANTHROPIC_API_KEY: 'keep', DEN_PROFILE: 'other' }))
  assert.equal(env['CLAUDE_CONFIG_DIR'], undefined)
  assert.equal(env['CODEX_HOME'], undefined)
  assert.equal(env['ANTHROPIC_API_KEY'], 'keep')
  assert.equal(env['DEN_PROFILE'], 'main')
})

test('harnessEnv without a profile leaves the environment as it came, minus harness sessions', async () => {
  const base = baseEnv({ CLAUDE_CONFIG_DIR: '/kept', DEN_PROFILE: 'inherited', CLAUDECODE: '1' })
  const env = await harnessEnv('claude', null, base)
  assert.equal(env['CLAUDE_CONFIG_DIR'], '/kept')
  assert.equal(env['DEN_PROFILE'], 'inherited')
  assert.equal(env['CLAUDECODE'], undefined)
  assert.equal(base['CLAUDECODE'], '1')
  assert.notEqual(env, base)
})

test('withoutHarnessSession is case-insensitive, pure and keeps unrelated variables', () => {
  const base: NodeJS.ProcessEnv = { claudecode: '1', Codex_Thread_Id: 't', antigravity_agent: '1', ANTIGRAVITY_USER_SETTING: 'x', CLAUDE_CODE_SSE_PORT: '1', PATH: '/bin' }
  const copy = { ...base }
  assert.deepEqual(withoutHarnessSession(base), { ANTIGRAVITY_USER_SETTING: 'x', CLAUDE_CODE_SSE_PORT: '1', PATH: '/bin' })
  assert.deepEqual(base, copy)
})

test('the binary override variables are KIT_ first, then BITA_, for every harness', () => {
  for (const id of HARNESS_IDS) {
    assert.equal(kitHarnessBinEnvVar(id), `KIT_HARNESS_BIN_${id.toUpperCase()}`)
    assert.equal(harnessBinEnvVar(id), `BITA_HARNESS_BIN_${id.toUpperCase()}`)
    assert.deepEqual(harnessBinEnvVars(id), [kitHarnessBinEnvVar(id), harnessBinEnvVar(id)])
  }
})

test('a broken KIT_ override disables the binary instead of silently using the BITA_ one; an empty one is ignored', { skip: POSIX_ONLY }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kit-harness-override-'))
  try {
    mkdirSync(join(dir, 'bin'))
    const good = createFakeBin(join(dir, 'bin'), 'codex-bita')
    const adapter = getAdapter('codex')
    const env = { PATH: '', HOME: dir }
    assert.equal(adapter.resolveBin({ ...env, [kitHarnessBinEnvVar('codex')]: '', [harnessBinEnvVar('codex')]: good }), good)
    assert.equal(adapter.resolveBin({ ...env, [harnessBinEnvVar('codex')]: good }), good)
    assert.equal(adapter.resolveBin({ ...env, [kitHarnessBinEnvVar('codex')]: join(dir, 'nope'), [harnessBinEnvVar('codex')]: good }), null)
    assert.equal(adapter.resolveBin({ ...env, [kitHarnessBinEnvVar('codex')]: 'relative/codex', [harnessBinEnvVar('codex')]: good }), null)
    assert.equal(adapter.resolveBin({ ...env, [kitHarnessBinEnvVar('codex')]: good, [harnessBinEnvVar('codex')]: join(dir, 'nope') }), good)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('harnessEnv treats undefined like null and rejects an empty profile name', async () => {
  const base = baseEnv({ CLAUDE_CONFIG_DIR: '/kept' })
  assert.equal((await harnessEnv('claude', undefined, base))['CLAUDE_CONFIG_DIR'], '/kept')
  await assert.rejects(harnessEnv('claude', '', base), /empty/)
})
