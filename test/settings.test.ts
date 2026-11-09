import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { platformContext, type PlatformContext } from '../src/platform.ts'
import {
  NURSERY_ROLES,
  SETTING_DEFS,
  SettingsError,
  checkSettings,
  getSetting,
  getSettingEntry,
  isValidBranchName,
  listSettings,
  onChange,
  parseSettingValue,
  setSetting,
  settingsPath,
  unsetSetting,
  userAgentsDir,
  type SettingChange,
} from '../src/settings.ts'
import { launchOptionsFor } from '../src/harness/index.ts'
import { tempDir } from './helpers.ts'

async function sandboxed(t: Parameters<typeof tempDir>[0]): Promise<PlatformContext> {
  const dir = await realpath(await tempDir(t))
  return platformContext({ home: dir, env: { KIT_CONFIG_DIR: path.join(dir, 'kikedealba') } })
}

function code(expected: string, key?: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof SettingsError && error.code === expected && (key === undefined || error.key === key)
}

test('defaults come back when nothing is set and the file is not created', async (t) => {
  const ctx = await sandboxed(t)
  assert.equal(await getSetting('agents.maxParallel', ctx), 10)
  assert.deepEqual(await getSetting('agents.enabled', ctx), [...NURSERY_ROLES])
  assert.equal(await getSetting('agents.developer.model', ctx), undefined)
  assert.equal(await getSetting('rules.gitflow', ctx), true)
  assert.equal(await getSetting('rules.baseBranch', ctx), 'develop')
  assert.equal(await getSetting('harness.default', ctx), 'claude')
  assert.equal(await getSetting('harness.codex.skipPermissions', ctx), true)
  assert.deepEqual(await getSetting('harness.claude.extraArgs', ctx), [])
  assert.equal(await getSetting('session.summary.claude.model', ctx), 'haiku')
  assert.equal(await getSetting('session.minDurationSec', ctx), 60)
  assert.equal(await getSetting('tools.gaze.enabled', ctx), true)
  assert.equal(statSync(settingsPath(ctx), { throwIfNoEntry: false }), undefined)
})

test('setSetting stores only values that differ from the default, nested by namespace, with mode 0600', async (t) => {
  const ctx = await sandboxed(t)
  const change = await setSetting('agents.maxParallel', '4', ctx)
  assert.deepEqual(change, { key: 'agents.maxParallel', previous: 10, value: 4, refresh: 'nursery' })
  await setSetting('agents.developer.model', 'sonnet', ctx)
  await setSetting('rules.gitflow', 'false', ctx)
  await setSetting('harness.claude.skipPermissions', false, ctx)
  await setSetting('harness.claude.extraArgs', '--model, opus', ctx)
  await setSetting('rules.baseBranch', 'develop', ctx)
  const stored = JSON.parse(await readFile(settingsPath(ctx), 'utf8')) as unknown
  assert.deepEqual(stored, {
    version: 1,
    agents: { maxParallel: 4, developer: { model: 'sonnet' } },
    rules: { gitflow: false },
    harness: { claude: { skipPermissions: false, extraArgs: ['--model', 'opus'] } },
  })
  if (process.platform !== 'win32') assert.equal(statSync(settingsPath(ctx)).mode & 0o777, 0o600)
  assert.deepEqual(await getSettingEntry('agents.maxParallel', ctx), { key: 'agents.maxParallel', value: 4, default: 10, source: 'user', owner: 'nursery' })

  await setSetting('agents.maxParallel', 10, ctx)
  const after = JSON.parse(await readFile(settingsPath(ctx), 'utf8')) as { agents: Record<string, unknown> }
  assert.equal('maxParallel' in after.agents, false)
})

test('unsetSetting goes back to the default and prunes empty namespaces', async (t) => {
  const ctx = await sandboxed(t)
  await setSetting('agents.developer.model', 'sonnet', ctx)
  const change = await unsetSetting('agents.developer.model', ctx)
  assert.deepEqual(change, { key: 'agents.developer.model', previous: 'sonnet', value: undefined, refresh: 'nursery' })
  assert.deepEqual(JSON.parse(await readFile(settingsPath(ctx), 'utf8')), { version: 1 })
  assert.deepEqual(await unsetSetting('session.minDurationSec', ctx), { key: 'session.minDurationSec', previous: 60, value: 60, refresh: 'none' })
})

test('unknown keys are rejected', async (t) => {
  const ctx = await sandboxed(t)
  for (const key of ['agents.nope', 'agents.ghost.model', 'harness.vim.skipPermissions', 'tools.foo.enabled', 'rules', 'rules.gitflow.extra', 'session.summary.claude']) {
    await assert.rejects(setSetting(key, 'x', ctx), code('UNKNOWN_KEY', key), key)
    await assert.rejects(getSetting(key, ctx), code('UNKNOWN_KEY', key), key)
  }
  assert.throws(() => parseSettingValue('nope.key', '1'), code('UNKNOWN_KEY'))
})

test('values out of range or of the wrong shape are rejected', async (t) => {
  const ctx = await sandboxed(t)
  const bad: [string, string][] = [
    ['agents.maxParallel', '0'],
    ['agents.maxParallel', '21'],
    ['agents.maxParallel', '4.5'],
    ['agents.maxParallel', 'four'],
    ['agents.developer.maxTurns', '501'],
    ['agents.developer.effort', 'huge'],
    ['agents.developer.model', 'Sonnet 4'],
    ['agents.enabled', ''],
    ['agents.enabled', 'developer,ghost'],
    ['rules.gitflow', 'yes'],
    ['rules.baseBranch', 'bad..name'],
    ['rules.baseBranch', 'feature/'],
    ['harness.default', 'vim'],
    ['harness.claude.extraArgs', '--verbose,--'],
    ['harness.claude.extraArgs', '[1, 2]'],
    ['session.minDurationSec', '3601'],
    ['session.summary.codex.model', '  '],
    ['tools.kit.enabled', 'false'],
  ]
  for (const [key, raw] of bad) await assert.rejects(setSetting(key, raw, ctx), code('INVALID_VALUE', key), `${key}=${raw}`)
  await assert.rejects(setSetting('agents.maxParallel', 3.5, ctx), code('INVALID_VALUE'))
  await assert.rejects(setSetting('rules.gitflow', 1, ctx), code('INVALID_VALUE'))
  assert.equal(await getSetting('rules.gitflow', ctx), true)
  await setSetting('tools.gaze.enabled', 'false', ctx)
  await setSetting('tools.kit.enabled', 'true', ctx)
})

test('parseSettingValue understands booleans, integers and lists', () => {
  assert.equal(parseSettingValue('rules.gitflow', '1'), true)
  assert.equal(parseSettingValue('rules.gitflow', 'FALSE'), false)
  assert.equal(parseSettingValue('agents.maxParallel', ' 7 '), 7)
  assert.deepEqual(parseSettingValue('harness.codex.extraArgs', '["-m", "gpt"]'), ['-m', 'gpt'])
  assert.deepEqual(parseSettingValue('harness.codex.extraArgs', '-m,gpt'), ['-m', 'gpt'])
  assert.deepEqual(parseSettingValue('agents.enabled', 'developer, architect'), ['developer', 'architect'])
  assert.equal(parseSettingValue('agents.developer.effort', 'xhigh'), 'xhigh')
  assert.throws(() => parseSettingValue('agents.maxParallel', '0x10'), code('INVALID_VALUE'))
})

test('a corrupt settings file is reported and never overwritten', async (t) => {
  const ctx = await sandboxed(t)
  await mkdir(path.dirname(settingsPath(ctx)), { recursive: true })
  for (const text of ['{ broken', '[]', '{"version":2}']) {
    await writeFile(settingsPath(ctx), text)
    await assert.rejects(getSetting('agents.maxParallel', ctx), code('SETTINGS_INVALID'))
    await assert.rejects(setSetting('agents.maxParallel', 4, ctx), code('SETTINGS_INVALID'))
    await assert.rejects(listSettings(ctx), code('SETTINGS_INVALID'))
    assert.equal(await readFile(settingsPath(ctx), 'utf8'), text)
    assert.equal((await checkSettings(ctx)).ok, false)
  }
})

test('checkSettings lists unknown keys and invalid stored values', async (t) => {
  const ctx = await sandboxed(t)
  await mkdir(path.dirname(settingsPath(ctx)), { recursive: true })
  await writeFile(settingsPath(ctx), JSON.stringify({ version: 1, agents: { maxParallel: 99 }, nope: true }))
  const report = await checkSettings(ctx)
  assert.equal(report.ok, false)
  assert.equal(report.errors.length, 2)
  assert.equal(await getSetting('agents.maxParallel', ctx), 10)
  await writeFile(settingsPath(ctx), JSON.stringify({ version: 1, agents: { maxParallel: 3 } }))
  assert.deepEqual(await checkSettings(ctx), { ok: true, errors: [] })
})

test('user agents become valid roles and take their defaults from their frontmatter', async (t) => {
  const ctx = await sandboxed(t)
  await mkdir(userAgentsDir(ctx), { recursive: true })
  await writeFile(path.join(userAgentsDir(ctx), 'sql-reviewer.md'), '---\nname: sql-reviewer\ndescription: x\nmodel: sonnet\neffort: medium\nmaxTurns: 20\n---\nBody\n')
  assert.deepEqual(await getSetting('agents.enabled', ctx), [...NURSERY_ROLES, 'sql-reviewer'])
  assert.equal(await getSetting('agents.sql-reviewer.model', ctx), 'sonnet')
  assert.equal(await getSetting('agents.sql-reviewer.maxTurns', ctx), 20)
  assert.equal(await getSetting('agents.sql-reviewer.effort', ctx), 'medium')
  await setSetting('agents.sql-reviewer.model', 'opus', ctx)
  assert.equal(await getSetting('agents.sql-reviewer.model', ctx), 'opus')
  await setSetting('agents.enabled', 'developer,sql-reviewer', ctx)
  const keys = (await listSettings(ctx)).map((entry) => entry.key)
  assert.ok(keys.includes('agents.sql-reviewer.effort'))
})

test('listSettings expands every pattern with its source and owner', async (t) => {
  const ctx = await sandboxed(t)
  await setSetting('harness.gemini.skipPermissions', false, ctx)
  const entries = await listSettings(ctx)
  const byKey = new Map(entries.map((entry) => [entry.key, entry]))
  assert.equal(entries.length, new Set(entries.map((entry) => entry.key)).size)
  assert.deepEqual(byKey.get('harness.gemini.skipPermissions'), { key: 'harness.gemini.skipPermissions', value: false, default: true, source: 'user', owner: 'den' })
  assert.equal(byKey.get('session.summary.codex.model')?.owner, 'bita')
  assert.equal(byKey.get('tools.atl.enabled')?.value, true)
  for (const role of NURSERY_ROLES) assert.ok(byKey.has(`agents.${role}.maxTurns`), role)
  assert.ok(SETTING_DEFS.every((def) => def.refresh === (def.owner === 'nursery' ? 'nursery' : 'none')))
})

test('onChange is told about real changes under its prefix only', async (t) => {
  const ctx = await sandboxed(t)
  const seen: SettingChange[] = []
  const stop = onChange('agents', (change) => {
    seen.push(change)
  })
  const all: string[] = []
  const stopAll = onChange('', (change) => {
    all.push(change.key)
  })
  try {
    await setSetting('agents.maxParallel', 5, ctx)
    await setSetting('agents.maxParallel', 5, ctx)
    await setSetting('rules.gitflow', false, ctx)
    await unsetSetting('agents.maxParallel', ctx)
  } finally {
    stop()
    stopAll()
  }
  await setSetting('agents.maxParallel', 6, ctx)
  assert.deepEqual(seen.map((change) => [change.key, change.previous, change.value]), [['agents.maxParallel', 10, 5], ['agents.maxParallel', 5, 10]])
  assert.deepEqual(all, ['agents.maxParallel', 'rules.gitflow', 'agents.maxParallel'])
})

test('launchOptionsFor reads skipPermissions and extraArgs per harness', async (t) => {
  const ctx = await sandboxed(t)
  assert.deepEqual(await launchOptionsFor('claude', ctx), { skipPermissions: true, extraArgs: [] })
  await setSetting('harness.claude.skipPermissions', false, ctx)
  await setSetting('harness.claude.extraArgs', ['--model', 'opus'], ctx)
  assert.deepEqual(await launchOptionsFor('claude', ctx), { skipPermissions: false, extraArgs: ['--model', 'opus'] })
  assert.deepEqual(await launchOptionsFor('codex', ctx), { skipPermissions: true, extraArgs: [] })
})

test('branch names follow the git rules', () => {
  for (const name of ['develop', 'main', 'release/1.2.0', 'feature/x-y']) assert.equal(isValidBranchName(name), true, name)
  for (const name of ['', '-x', 'a..b', 'a b', 'a~1', 'x.lock', '.hidden', 'a//b', 'a@{1}', '@', 'end.']) assert.equal(isValidBranchName(name), false, name)
})
