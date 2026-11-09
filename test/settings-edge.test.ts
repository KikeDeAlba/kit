import assert from 'node:assert/strict'
import { chmodSync, lstatSync, statSync } from 'node:fs'
import { mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { CATALOG } from '../src/catalog.ts'
import { HARNESS_IDS } from '../src/harness/types.ts'
import { launchOptionsFor } from '../src/harness/index.ts'
import { platformContext, type PlatformContext } from '../src/platform.ts'
import {
  SETTING_DEFS,
  SettingsError,
  checkSettings,
  getSetting,
  getSettingEntry,
  listSettings,
  onChange,
  parseSettingValue,
  setSetting,
  settingsPath,
  unsetSetting,
  userAgentsDir,
  type SettingChange,
} from '../src/settings.ts'
import { tempDir } from './helpers.ts'

const posixOnly = process.platform === 'win32' ? 'symlinks and modes need POSIX' : false

async function sandboxed(t: Parameters<typeof tempDir>[0]): Promise<PlatformContext> {
  const dir = await realpath(await tempDir(t))
  return platformContext({ home: dir, env: { KIT_CONFIG_DIR: path.join(dir, 'kikedealba') } })
}

function code(expected: string, key?: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof SettingsError && error.code === expected && (key === undefined || error.key === key)
}

async function writeRaw(ctx: PlatformContext, content: string): Promise<void> {
  await mkdir(path.dirname(settingsPath(ctx)), { recursive: true })
  await writeFile(settingsPath(ctx), content)
}

test('integer settings accept exactly their documented range', async (t) => {
  const ctx = await sandboxed(t)
  const ranges: [string, number, number][] = [
    ['agents.maxParallel', 1, 20],
    ['session.minDurationSec', 0, 3600],
    ['agents.developer.maxTurns', 1, 500],
  ]
  for (const [key, min, max] of ranges) {
    for (const ok of [min, max]) {
      assert.equal((await setSetting(key, ok, ctx)).value, ok, `${key} ${ok}`)
      assert.equal(await getSetting(key, ctx), ok, `${key} ${ok}`)
    }
    for (const bad of [min - 1, max + 1, Number.NaN, Number.POSITIVE_INFINITY, min + 0.5, 2 ** 53]) {
      await assert.rejects(setSetting(key, bad, ctx), code('INVALID_VALUE', key), `${key} ${bad}`)
    }
    for (const bad of [String(min - 1), String(max + 1), `${min}.5`, '', ' ', '1e2', '0x10', '+3', 'ten']) {
      await assert.rejects(setSetting(key, bad, ctx), code('INVALID_VALUE', key), `${key} "${bad}"`)
    }
    await assert.rejects(setSetting(key, true as unknown as number, ctx), code('INVALID_VALUE', key))
    await assert.rejects(setSetting(key, null as unknown as number, ctx), code('INVALID_VALUE', key))
    assert.equal((await setSetting(key, ` ${max} `, ctx)).value, max)
  }
})

test('parseSettingValue covers every type with its edge inputs', () => {
  for (const [raw, expected] of [['true', true], ['TRUE', true], [' False ', false], ['1', true], ['0', false]] as const) assert.equal(parseSettingValue('rules.gitflow', raw), expected, raw)
  for (const raw of ['', 'yes', 'no', 'on', '2', 'tru', 'true false']) assert.throws(() => parseSettingValue('rules.gitflow', raw), code('INVALID_VALUE', 'rules.gitflow'), raw)
  assert.equal(parseSettingValue('agents.maxParallel', '007'), 7)
  assert.throws(() => parseSettingValue('agents.maxParallel', '99999999999999999999'), code('INVALID_VALUE'))
  assert.deepEqual(parseSettingValue('harness.claude.extraArgs', ''), [])
  assert.deepEqual(parseSettingValue('harness.claude.extraArgs', ' , ,a,, b ,'), ['a', 'b'])
  assert.deepEqual(parseSettingValue('harness.claude.extraArgs', '[]'), [])
  assert.deepEqual(parseSettingValue('harness.claude.extraArgs', '["--model","opus 4"]'), ['--model', 'opus 4'])
  assert.deepEqual(parseSettingValue('harness.claude.extraArgs', '--model,opus'), ['--model', 'opus'])
  for (const raw of ['["--"]', '--,x', '[1]', '[null]', '["a"', '[["a"]]', '[{"a":1}]']) assert.throws(() => parseSettingValue('harness.claude.extraArgs', raw), code('INVALID_VALUE', 'harness.claude.extraArgs'), raw)
  assert.throws(() => parseSettingValue('agents.enabled', ''), code('INVALID_VALUE', 'agents.enabled'))
  assert.throws(() => parseSettingValue('agents.enabled', '[]'), code('INVALID_VALUE', 'agents.enabled'))
  assert.equal(parseSettingValue('rules.baseBranch', 'release/1.0'), 'release/1.0')
  assert.throws(() => parseSettingValue('rules.baseBranch', ' develop'), code('INVALID_VALUE'))
  assert.throws(() => parseSettingValue('rules.baseBranch', ''), code('INVALID_VALUE'))
  assert.throws(() => parseSettingValue('harness.default', 'Claude'), code('INVALID_VALUE'))
  assert.throws(() => parseSettingValue('harness.default', 'claude '), code('INVALID_VALUE'))
  assert.equal(parseSettingValue('harness.default', 'gemini'), 'gemini')
  assert.throws(() => parseSettingValue('nope.nothing', '1'), code('UNKNOWN_KEY', 'nope.nothing'))
})

test('keys must match a pattern exactly: no case changes, no extra or missing segments', async (t) => {
  const ctx = await sandboxed(t)
  const unknown = [
    '',
    '.',
    'agents',
    'agents.',
    '.agents.maxParallel',
    'agents.maxParallel.',
    'agents.maxParallel.x',
    'Agents.maxParallel',
    'agents.maxparallel',
    'rules',
    'rules.noAItrace',
    'harness.cursor.skipPermissions',
    'harness.claude',
    'harness.claude.skipPermissions.x',
    'session.summary.cursor.model',
    'session.summary.claude',
    'tools.den.enabled',
    'tools.kit',
    'agents.ghost.model',
    'agents.__proto__.model',
    'agents.constructor.model',
    'version',
    '$schema',
  ]
  for (const key of unknown) {
    await assert.rejects(getSetting(key, ctx), code('UNKNOWN_KEY'), `get ${JSON.stringify(key)}`)
    await assert.rejects(setSetting(key, 'x', ctx), code('UNKNOWN_KEY'), `set ${JSON.stringify(key)}`)
    await assert.rejects(unsetSetting(key, ctx), code('UNKNOWN_KEY'), `unset ${JSON.stringify(key)}`)
  }
})

test('every harness and every catalog tool gets its own keys', async (t) => {
  const ctx = await sandboxed(t)
  for (const id of HARNESS_IDS) {
    await setSetting(`harness.${id}.skipPermissions`, false, ctx)
    await setSetting(`harness.${id}.extraArgs`, [`--${id}-flag`], ctx)
    assert.deepEqual(await launchOptionsFor(id, ctx), { skipPermissions: false, extraArgs: [`--${id}-flag`] }, id)
    assert.ok(((await getSetting<string>(`session.summary.${id}.model`, ctx)) ?? '').length > 0, `summary model default for ${id}`)
  }
  const refused = CATALOG.filter((tool) => !tool.optional).map((tool) => tool.name)
  assert.deepEqual(refused, ['kit'])
  for (const tool of CATALOG) {
    const key = `tools.${tool.name}.enabled`
    if (tool.optional) {
      assert.equal((await setSetting(key, false, ctx)).value, false, key)
      assert.equal(await getSetting(key, ctx), false, key)
      assert.equal((await unsetSetting(key, ctx)).value, true, key)
    } else {
      await assert.rejects(setSetting(key, false, ctx), code('INVALID_VALUE', key))
      assert.equal((await setSetting(key, true, ctx)).value, true)
    }
  }
})

test('enum, string and model settings validate their shape', async (t) => {
  const ctx = await sandboxed(t)
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) assert.equal((await setSetting('agents.developer.effort', effort, ctx)).value, effort)
  for (const bad of ['HIGH', 'ultra', '', ' high', 'high ']) await assert.rejects(setSetting('agents.developer.effort', bad, ctx), code('INVALID_VALUE'), bad)
  await assert.rejects(setSetting('agents.developer.effort', 3 as unknown as string, ctx), code('INVALID_VALUE'))
  for (const good of ['sonnet', 'claude-opus-4-7', 'claude-opus-4-7[1m]', 'gpt-5.1', 'a']) assert.equal((await setSetting('agents.developer.model', good, ctx)).value, good)
  for (const bad of ['Opus', 'my model', 'm/n', 'm_n', '', '   ', 'ñ']) await assert.rejects(setSetting('agents.developer.model', bad, ctx), code('INVALID_VALUE'), JSON.stringify(bad))
  await assert.rejects(setSetting('session.summary.claude.model', '   ', ctx), code('INVALID_VALUE'))
  await assert.rejects(setSetting('session.summary.claude.model', ['a'] as unknown as string, ctx), code('INVALID_VALUE'))
  await assert.rejects(setSetting('rules.gitflow', 'maybe', ctx), code('INVALID_VALUE'))
  await assert.rejects(setSetting('rules.gitflow', 2 as unknown as boolean, ctx), code('INVALID_VALUE'))
  assert.deepEqual((await setSetting('harness.claude.extraArgs', 'a,b', ctx)).value, ['a', 'b'])
  await assert.rejects(setSetting('harness.claude.extraArgs', ['ok', 3] as unknown as string[], ctx), code('INVALID_VALUE'))
  await assert.rejects(setSetting('harness.claude.extraArgs', ['ok', '--'], ctx), code('INVALID_VALUE'))
  assert.deepEqual((await setSetting('harness.claude.extraArgs', ['--model=x', '-p'], ctx)).value, ['--model=x', '-p'])
})

test('agents.enabled needs known roles, is not empty and returns to the default when set to it', async (t) => {
  const ctx = await sandboxed(t)
  await mkdir(userAgentsDir(ctx), { recursive: true })
  await writeFile(path.join(userAgentsDir(ctx), 'my-bot.md'), '---\nname: my-bot\nmodel: haiku\nmaxTurns: 12\neffort: low\n---\nBody\n')
  assert.equal(((await getSetting<string[]>('agents.enabled', ctx)) ?? []).includes('my-bot'), true)
  assert.equal((await getSetting<string[]>('agents.enabled', ctx))?.length, 11)
  await assert.rejects(setSetting('agents.enabled', ['developer', 'ghost'], ctx), code('INVALID_VALUE', 'agents.enabled'))
  await assert.rejects(setSetting('agents.enabled', [], ctx), code('INVALID_VALUE'))
  assert.deepEqual((await setSetting('agents.enabled', ['developer', 'my-bot'], ctx)).value, ['developer', 'my-bot'])
  assert.deepEqual(await getSetting('agents.enabled', ctx), ['developer', 'my-bot'])
  const all = (await unsetSetting('agents.enabled', ctx)).value as string[]
  await setSetting('agents.enabled', ['developer'], ctx)
  await setSetting('agents.enabled', all, ctx)
  assert.equal(JSON.parse(await readFile(settingsPath(ctx), 'utf8')).agents, undefined)
})

test('user agents expose frontmatter defaults and a stored value equal to that default is not kept', async (t) => {
  const ctx = await sandboxed(t)
  await mkdir(userAgentsDir(ctx), { recursive: true })
  await writeFile(path.join(userAgentsDir(ctx), 'my-bot.md'), '---\nname: my-bot\nmodel: haiku\nmaxTurns: 12\neffort: low\n---\nBody\n')
  await writeFile(path.join(userAgentsDir(ctx), 'bad-turns.md'), '---\nname: bad-turns\nmaxTurns: lots\n---\nBody\n')
  await writeFile(path.join(userAgentsDir(ctx), 'Not_Valid.md'), '---\nname: x\n---\n')
  await writeFile(path.join(userAgentsDir(ctx), 'developer.md'), '---\nname: developer\nmodel: haiku\n---\n')
  assert.equal(await getSetting('agents.my-bot.model', ctx), 'haiku')
  assert.equal(await getSetting('agents.my-bot.maxTurns', ctx), 12)
  assert.equal(await getSetting('agents.my-bot.effort', ctx), 'low')
  assert.equal(await getSetting('agents.bad-turns.maxTurns', ctx), undefined)
  assert.equal(await getSetting('agents.developer.model', ctx), undefined)
  await assert.rejects(getSetting('agents.Not_Valid.model', ctx), code('UNKNOWN_KEY'))
  await setSetting('agents.my-bot.model', 'haiku', ctx)
  await setSetting('agents.my-bot.maxTurns', 12, ctx)
  await setSetting('agents.developer.model', 'sonnet', ctx)
  await setSetting('agents.developer.model', 'sonnet', ctx)
  assert.deepEqual(JSON.parse(await readFile(settingsPath(ctx), 'utf8')), { version: 1, agents: { developer: { model: 'sonnet' } } })
  const entry = await getSettingEntry('agents.my-bot.model', ctx)
  assert.deepEqual([entry.source, entry.value, entry.default, entry.owner], ['default', 'haiku', 'haiku', 'nursery'])
})

test('a user agent called "enabled" cannot shadow agents.enabled', async (t) => {
  const ctx = await sandboxed(t)
  await mkdir(userAgentsDir(ctx), { recursive: true })
  await writeFile(path.join(userAgentsDir(ctx), 'enabled.md'), '---\nname: enabled\n---\n')
  await assert.rejects(setSetting('agents.enabled.model', 'sonnet', ctx), code('UNKNOWN_KEY'))
  await setSetting('agents.enabled', ['developer'], ctx)
  assert.deepEqual(await getSetting('agents.enabled', ctx), ['developer'])
  assert.deepEqual((await checkSettings(ctx)).errors, [])
})

test('setSetting and unsetSetting report the change with its previous value and refresh target', async (t) => {
  const ctx = await sandboxed(t)
  assert.deepEqual(await setSetting('agents.maxParallel', 4, ctx), { key: 'agents.maxParallel', previous: 10, value: 4, refresh: 'nursery' })
  assert.deepEqual(await setSetting('agents.maxParallel', 4, ctx), { key: 'agents.maxParallel', previous: 4, value: 4, refresh: 'nursery' })
  assert.deepEqual(await setSetting('harness.codex.skipPermissions', false, ctx), { key: 'harness.codex.skipPermissions', previous: true, value: false, refresh: 'none' })
  assert.deepEqual(await setSetting('agents.maxParallel', 10, ctx), { key: 'agents.maxParallel', previous: 4, value: 10, refresh: 'nursery' })
  assert.deepEqual(await unsetSetting('agents.maxParallel', ctx), { key: 'agents.maxParallel', previous: 10, value: 10, refresh: 'nursery' })
  assert.deepEqual(await unsetSetting('harness.codex.skipPermissions', ctx), { key: 'harness.codex.skipPermissions', previous: false, value: true, refresh: 'none' })
  assert.deepEqual(JSON.parse(await readFile(settingsPath(ctx), 'utf8')), { version: 1 })
  for (const def of SETTING_DEFS) assert.equal(def.refresh, def.owner === 'nursery' ? 'nursery' : 'none', def.pattern)
})

test('hand-written extras survive writes and a value of the wrong type falls back to the default', async (t) => {
  const ctx = await sandboxed(t)
  await writeRaw(ctx, JSON.stringify({ $schema: 'https://example.test/s.json', version: 1, custom: { keep: [1, 2] }, agents: { maxParallel: '4', developer: { model: 'sonnet' } } }))
  assert.equal(await getSetting('agents.maxParallel', ctx), 10)
  assert.deepEqual((await getSettingEntry('agents.maxParallel', ctx)).source, 'default')
  assert.equal((await checkSettings(ctx)).ok, false)
  await setSetting('rules.gitflow', false, ctx)
  const stored = JSON.parse(await readFile(settingsPath(ctx), 'utf8'))
  assert.deepEqual(stored, { version: 1, $schema: 'https://example.test/s.json', custom: { keep: [1, 2] }, agents: { maxParallel: '4', developer: { model: 'sonnet' } }, rules: { gitflow: false } })
  await unsetSetting('agents.maxParallel', ctx)
  assert.deepEqual(JSON.parse(await readFile(settingsPath(ctx), 'utf8')).agents, { developer: { model: 'sonnet' } })
})

test('settings files that are empty, versionless, of another version or not an object are SETTINGS_INVALID and untouched', async (t) => {
  const ctx = await sandboxed(t)
  for (const content of ['', '   ', '{}', '{"version":2}', '{"version":"1"}', '[]', 'null', '"x"', '{"version":1,', '\uFEFF{"version":1}']) {
    await writeRaw(ctx, content)
    await assert.rejects(getSetting('agents.maxParallel', ctx), code('SETTINGS_INVALID'), JSON.stringify(content))
    await assert.rejects(listSettings(ctx), code('SETTINGS_INVALID'), JSON.stringify(content))
    await assert.rejects(setSetting('agents.maxParallel', 3, ctx), code('SETTINGS_INVALID'), JSON.stringify(content))
    await assert.rejects(unsetSetting('agents.maxParallel', ctx), code('SETTINGS_INVALID'), JSON.stringify(content))
    await assert.rejects(launchOptionsFor('claude', ctx), code('SETTINGS_INVALID'), JSON.stringify(content))
    assert.equal(await readFile(settingsPath(ctx), 'utf8'), content)
    const checked = await checkSettings(ctx)
    assert.equal(checked.ok, false)
    assert.equal(checked.errors.length, 1)
  }
})

test('a directory where settings.json should be reports SETTINGS_INVALID instead of crashing', async (t) => {
  const ctx = await sandboxed(t)
  await mkdir(settingsPath(ctx), { recursive: true })
  await assert.rejects(getSetting('agents.maxParallel', ctx), code('SETTINGS_INVALID'))
  await assert.rejects(setSetting('agents.maxParallel', 3, ctx), code('SETTINGS_INVALID'))
})

test('settings.json is written 0600 even when an earlier copy was looser, and through a symlink', { skip: posixOnly }, async (t) => {
  const ctx = await sandboxed(t)
  await writeRaw(ctx, '{"version":1}')
  chmodSync(settingsPath(ctx), 0o644)
  await setSetting('rules.gitflow', false, ctx)
  assert.equal(statSync(settingsPath(ctx)).mode & 0o777, 0o600)

  const real = path.join(ctx.home, 'dotfiles', 'kit-settings.json')
  await mkdir(path.dirname(real), { recursive: true })
  await writeFile(real, '{"version":1}')
  await rm(settingsPath(ctx))
  await symlink(real, settingsPath(ctx))
  await setSetting('rules.noComments', false, ctx)
  assert.ok(lstatSync(settingsPath(ctx)).isSymbolicLink())
  assert.deepEqual(JSON.parse(await readFile(real, 'utf8')), { version: 1, rules: { noComments: false } })
})

test('onChange handlers see one change per real change, in order, and can be removed', async (t) => {
  const ctx = await sandboxed(t)
  const order: string[] = []
  const stopA = onChange('rules', async (change) => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    order.push(`a:${change.key}`)
  })
  const stopB = onChange('rules.', (change) => {
    order.push(`b:${change.key}`)
  })
  const stopC = onChange('rule', (change) => {
    order.push(`c:${change.key}`)
  })
  try {
    await setSetting('rules.gitflow', false, ctx)
    await setSetting('rules.gitflow', false, ctx)
    await unsetSetting('rules.gitflow', ctx)
    await unsetSetting('rules.gitflow', ctx)
    await setSetting('agents.maxParallel', 3, ctx)
  } finally {
    stopA()
    stopB()
    stopC()
  }
  stopA()
  await setSetting('rules.gitflow', false, ctx)
  assert.deepEqual(order, ['a:rules.gitflow', 'b:rules.gitflow', 'a:rules.gitflow', 'b:rules.gitflow'])
})

test('a failing onChange handler does not turn a persisted change into a failure nor starve later handlers', { todo: 'notify awaits handlers in sequence without isolation: a throwing handler rejects setSetting after the file was written and skips the rest' }, async (t) => {
  const ctx = await sandboxed(t)
  const seen: SettingChange[] = []
  const stopBad = onChange('rules', () => {
    throw new Error('handler exploded')
  })
  const stopGood = onChange('rules', (change) => {
    seen.push(change)
  })
  try {
    await setSetting('rules.gitflow', false, ctx)
  } finally {
    stopBad()
    stopGood()
  }
  assert.equal(seen.length, 1)
})

test('a failing onChange handler still leaves the new value on disk', async (t) => {
  const ctx = await sandboxed(t)
  const stop = onChange('rules', () => {
    throw new Error('handler exploded')
  })
  try {
    await assert.rejects(setSetting('rules.gitflow', false, ctx), /handler exploded/)
  } finally {
    stop()
  }
  assert.equal(await getSetting('rules.gitflow', ctx), false)
})

test('parallel setSetting calls on different keys keep every value', { todo: 'read-modify-write without a lock plus a shared temporary name: concurrent writers lose updates or fail with ENOENT' }, async (t) => {
  const ctx = await sandboxed(t)
  const writes: [string, number | boolean][] = [
    ['agents.maxParallel', 3],
    ['session.minDurationSec', 5],
    ['rules.gitflow', false],
    ['rules.noComments', false],
    ['harness.claude.skipPermissions', false],
    ['harness.codex.skipPermissions', false],
  ]
  await Promise.all(writes.map(([key, value]) => setSetting(key, value, ctx)))
  for (const [key, value] of writes) assert.equal(await getSetting(key, ctx), value, key)
})

test('settingsPath and the user agents dir follow the platform path style', { todo: 'settingsPath and userAgentsDir use the host path module instead of the one for ctx.platform, unlike profilesPath' }, () => {
  const win = platformContext({ platform: 'win32', home: 'C:\\Users\\me', env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } })
  assert.equal(settingsPath(win), 'C:\\Users\\me\\AppData\\Roaming\\kikedealba\\settings.json')
  assert.equal(userAgentsDir(win), 'C:\\Users\\me\\AppData\\Roaming\\kikedealba\\agents')
})

test('settingsPath honours KIT_CONFIG_DIR, XDG_CONFIG_HOME and the home fallback', () => {
  assert.equal(settingsPath(platformContext({ platform: 'linux', home: '/h', env: { KIT_CONFIG_DIR: '/cfg' } })), '/cfg/settings.json')
  assert.equal(settingsPath(platformContext({ platform: 'linux', home: '/h', env: { XDG_CONFIG_HOME: '/x' } })), '/x/kikedealba/settings.json')
  assert.equal(settingsPath(platformContext({ platform: 'linux', home: '/h', env: {} })), '/h/.config/kikedealba/settings.json')
})

test('listSettings gives unique keys for every pattern and marks only stored values as user', async (t) => {
  const ctx = await sandboxed(t)
  await setSetting('rules.baseBranch', 'main', ctx)
  const entries = await listSettings(ctx)
  const keys = entries.map((entry) => entry.key)
  assert.equal(new Set(keys).size, keys.length)
  assert.ok(keys.every((key) => !key.includes('<') && !key.includes('>')))
  assert.deepEqual(entries.filter((entry) => entry.source === 'user').map((entry) => entry.key), ['rules.baseBranch'])
  const patterns = new Set(SETTING_DEFS.map((def) => def.pattern))
  assert.equal(patterns.size, SETTING_DEFS.length)
  assert.equal(keys.length, 1 + 1 + 3 * 10 + 6 + 1 + 1 + 2 * HARNESS_IDS.length + HARNESS_IDS.length + 1 + CATALOG.length)
})
