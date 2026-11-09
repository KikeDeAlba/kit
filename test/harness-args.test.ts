import './isolate.ts'
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { POSIX_ONLY } from './fake-bin.ts'
import { getAdapter, harnessBinEnvVar, listAdapters } from '../src/harness/registry.ts'
import type { HarnessId, LaunchPlan } from '../src/harness/types.ts'
import { createFakeBin } from './fake-bin.ts'

const plan = (id: HarnessId, args: string[]): LaunchPlan => getAdapter(id).launchArgs(args)

test('registry lists the adapters in the fixed order', () => {
  assert.deepEqual(listAdapters().map((adapter) => adapter.id), ['claude', 'opencode', 'codex', 'gemini', 'antigravity'])
  assert.deepEqual(listAdapters().map((adapter) => adapter.bin), ['claude', 'opencode', 'codex', 'gemini', 'agy'])
  assert.equal(getAdapter('codex').label, 'Codex')
})

test('resolveBin prefers an executable override and falls back to PATH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kit-harness-bin-'))
  try {
    const fake = createFakeBin(dir, 'gemini-fake')
    const onPath = createFakeBin(dir, 'opencode')
    const adapter = getAdapter('gemini')
    assert.equal(adapter.resolveBin({ PATH: '', [harnessBinEnvVar('gemini')]: fake }), fake)
    assert.equal(adapter.resolveBin({ PATH: '', [harnessBinEnvVar('gemini')]: join(dir, 'missing') }), null)
    assert.equal(adapter.available({ PATH: '', HOME: dir }), false)
    assert.equal(getAdapter('opencode').resolveBin({ PATH: `/nonexistent${delimiter}${dir}`, HOME: dir }), onPath)
    assert.equal(getAdapter('opencode').available({ PATH: dir, HOME: dir }), true)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('claude passes everything through and adds the permission flag once', () => {
  assert.deepEqual(plan('claude', []), { args: ['--allow-dangerously-skip-permissions'], warnings: [] })
  assert.deepEqual(plan('claude', ['-c', '--model', 'opus', 'hola']).args, ['--allow-dangerously-skip-permissions', '-c', '--model', 'opus', 'hola'])
  assert.deepEqual(plan('claude', ['--allow-dangerously-skip-permissions', '-r', 'x']).args, ['--allow-dangerously-skip-permissions', '-r', 'x'])
  assert.deepEqual(plan('claude', ['--dangerously-skip-permissions']).args, ['--dangerously-skip-permissions'])
  assert.deepEqual(plan('claude', ['--', '--dangerously-skip-permissions']).args, ['--allow-dangerously-skip-permissions', '--', '--dangerously-skip-permissions'])
})

test('codex translates continue, resume and the prompt', () => {
  const flag = '--dangerously-bypass-approvals-and-sandbox'
  assert.deepEqual(plan('codex', []), { args: [flag], warnings: [] })
  assert.deepEqual(plan('codex', ['-c']).args, ['resume', '--last', flag])
  assert.deepEqual(plan('codex', ['--continue', 'sigue']).args, ['resume', '--last', flag, '--', 'sigue'])
  assert.deepEqual(plan('codex', ['-r', 'abc']).args, ['resume', 'abc', flag])
  assert.deepEqual(plan('codex', ['--resume=abc']).args, ['resume', 'abc', flag])
  assert.deepEqual(plan('codex', ['-r']).args, ['resume', flag])
  assert.deepEqual(plan('codex', ['-r', '--verbose']).args, ['resume', flag])
  assert.deepEqual(plan('codex', ['update', 'the', 'docs']).args, [flag, '--', 'update the docs'])
  assert.deepEqual(plan('codex', ['--dangerously-skip-permissions', 'x']), { args: [flag, '--', 'x'], warnings: [] })
})

test('gemini translates and keeps its own approval flags', () => {
  assert.deepEqual(plan('gemini', []), { args: ['--approval-mode=yolo'], warnings: [] })
  assert.deepEqual(plan('gemini', ['-c']).args, ['--approval-mode=yolo', '--resume', 'latest'])
  assert.deepEqual(plan('gemini', ['-r']).args, ['--approval-mode=yolo', '--resume', 'latest'])
  assert.deepEqual(plan('gemini', ['--resume', 'abc']).args, ['--approval-mode=yolo', '--resume', 'abc'])
  assert.deepEqual(plan('gemini', ['arregla', 'el', 'bug']).args, ['--approval-mode=yolo', '--prompt-interactive=arregla el bug'])
  assert.deepEqual(plan('gemini', ['--yolo', 'x']).args, ['--yolo', '--prompt-interactive=x'])
  assert.deepEqual(plan('gemini', ['-y']).args, ['-y'])
  assert.deepEqual(plan('gemini', ['--approval-mode', 'auto_edit', 'x']).args, ['--approval-mode=auto_edit', '--prompt-interactive=x'])
  assert.deepEqual(plan('gemini', ['--approval-mode=plan']).args, ['--approval-mode=plan'])
  assert.deepEqual(plan('gemini', ['--allow-dangerously-skip-permissions']).warnings, [])
})

test('opencode translates continue, resume with id and the prompt', () => {
  assert.deepEqual(plan('opencode', []), { args: ['--auto'], warnings: [] })
  assert.deepEqual(plan('opencode', ['-c']).args, ['--auto', '--continue'])
  assert.deepEqual(plan('opencode', ['-r', 'ses_1']).args, ['--auto', '--session', 'ses_1'])
  assert.deepEqual(plan('opencode', ['hola', 'mundo']).args, ['--auto', '--prompt=hola mundo'])
  assert.deepEqual(plan('opencode', ['-r']), { args: ['--auto'], warnings: ['OpenCode has no equivalent for --resume; dropped.'] })
})

test('unknown flags are dropped with one warning each and consume their values', () => {
  for (const id of ['codex', 'gemini', 'opencode'] as const) {
    const label = getAdapter(id).label
    const result = plan(id, ['--model', 'opus', '--verbose', '--settings={"a":1}', '--add-dir', '/tmp/x', 'prompt'])
    assert.deepEqual(result.warnings, [
      `${label} has no equivalent for --model; dropped.`,
      `${label} has no equivalent for --verbose; dropped.`,
      `${label} has no equivalent for --settings; dropped.`,
      `${label} has no equivalent for --add-dir; dropped.`,
    ])
    assert.ok(!result.args.includes('opus'))
    assert.ok(!result.args.includes('/tmp/x'))
    assert.ok(result.args.some((arg) => arg === 'prompt' || arg.endsWith('=prompt')))
  }
})

test('every claude flag that takes a value consumes it instead of becoming the prompt', () => {
  const valued = [
    ['--effort', 'high'],
    ['--name', 'my session'],
    ['-n', 'other'],
    ['--plugin-dir', '/tmp/plugin'],
    ['--permission-prompts', 'self'],
    ['--setting-sources', 'user'],
    ['--json-schema', '{}'],
    ['--max-budget-usd', '5'],
    ['--tools', 'Bash'],
    ['--disallowed-tools', 'Edit'],
    ['--system-prompt-snapshot', 'off'],
    ['--debug-file', '/tmp/d.log'],
  ]
  for (const id of ['codex', 'gemini', 'opencode'] as const) {
    const result = plan(id, [...valued.flat(), 'real prompt'])
    for (const [flag, value] of valued) {
      assert.ok(!result.args.some((arg) => arg.includes(value as string)), `${id} kept the value of ${flag}`)
    }
    assert.ok(result.args.some((arg) => arg.includes('real prompt')), id)
    assert.equal(result.warnings.length, valued.length, id)
  }
})

test('tokens after a literal -- are positional', () => {
  assert.deepEqual(plan('codex', ['--', '-c', 'texto']).args, ['--dangerously-bypass-approvals-and-sandbox', '--', '-c texto'])
})

test('resolveBin finds an agent installed with nvm when PATH does not have it', { skip: POSIX_ONLY }, () => {
  const home = mkdtempSync(join(tmpdir(), 'kit-harness-nvm-'))
  try {
    const nvmBin = join(home, '.nvm', 'versions', 'node', 'v24.1.0', 'bin')
    mkdirSync(nvmBin, { recursive: true })
    const gemini = createFakeBin(nvmBin, 'gemini')
    const claude = createFakeBin(nvmBin, 'claude')
    const env = { PATH: '/usr/bin:/bin', HOME: home }
    assert.equal(getAdapter('gemini').resolveBin(env), gemini)
    assert.equal(getAdapter('claude').available(env), true)
    const override = createFakeBin(home, 'gemini-pinned')
    assert.equal(getAdapter('gemini').resolveBin({ ...env, [harnessBinEnvVar('gemini')]: override }), override)
    assert.equal(getAdapter('gemini').resolveBin({ ...env, [harnessBinEnvVar('gemini')]: join(home, 'nope') }), null)
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

test('antigravity always skips permissions once and maps resume, continue and the prompt', () => {
  const skip = '--dangerously-skip-permissions'
  assert.deepEqual(plan('antigravity', []), { args: [skip], warnings: [] })
  assert.deepEqual(plan('antigravity', [skip]).args, [skip])
  assert.deepEqual(plan('antigravity', ['--allow-dangerously-skip-permissions', skip, 'x']).args, [skip, '--prompt-interactive=x'])
  assert.deepEqual(plan('antigravity', ['-c']).args, [skip, '-c'])
  assert.deepEqual(plan('antigravity', ['--continue', 'sigue']).args, [skip, '-c', '--prompt-interactive=sigue'])
  assert.deepEqual(plan('antigravity', ['--resume', 'abc']).args, [skip, '--conversation', 'abc'])
  assert.deepEqual(plan('antigravity', ['-r']).args, [skip, '-c'])
  assert.deepEqual(plan('antigravity', ['arregla', 'el', 'bug']).args, [skip, '--prompt-interactive=arregla el bug'])
  assert.deepEqual(plan('antigravity', ['--model', 'gemini-3.8-flash-high', '--mode=plan', 'x']).args, [skip, '--model=gemini-3.8-flash-high', '--mode=plan', '--prompt-interactive=x'])
  assert.deepEqual(plan('antigravity', ['--permission-mode', 'plan']).warnings, ['Antigravity has no equivalent for --permission-mode; dropped.'])
})
