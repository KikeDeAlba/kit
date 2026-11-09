import assert from 'node:assert/strict'
import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs'
import { mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { ANTIGRAVITY_SESSION_ENV, HARNESS_SESSION_ENV } from '../src/harness/env.ts'
import { platformContext, type PlatformContext } from '../src/platform.ts'
import {
  PROFILE_ENV,
  ProfileError,
  addProfile,
  envFor,
  expandPath,
  getProfile,
  inspectSharedLinks,
  listProfiles,
  mapDir,
  parseProfiles,
  profileHomes,
  profilesPath,
  repairSharedLinks,
  resolveProfile,
  serializeProfiles,
  tildePath,
  type Profile,
} from '../src/profiles.ts'
import { tempDir } from './helpers.ts'

const posixOnly = process.platform === 'win32' ? 'posix modes and symlinks' : false

async function sandboxed(t: Parameters<typeof tempDir>[0], env: NodeJS.ProcessEnv = {}): Promise<PlatformContext> {
  const dir = await realpath(await tempDir(t))
  return platformContext({ home: dir, env: { PATH: process.env['PATH'] ?? '', XDG_CONFIG_HOME: path.join(dir, '.config'), ...env } })
}

const builtin: Profile = { name: 'personal', builtin: true, claude: null, codex: null, createdAt: null }
const work: Profile = { name: 'work', builtin: false, claude: '/p/work/claude', codex: '/p/work/codex', createdAt: '2026-11-08T00:00:00.000Z' }

const SECRETS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY']

function dirtyEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    HOME: '/home/me',
    CLAUDE_CONFIG_DIR: '/other/claude',
    CODEX_HOME: '/other/codex',
    DEN_PROFILE: 'other',
    BITA_CHILD: '1',
    CLAUDE_CODE_SSE_PORT: '1234',
  }
  for (const name of SECRETS) env[name] = `secret-${name}`
  for (const name of [...HARNESS_SESSION_ENV, ...ANTIGRAVITY_SESSION_ENV]) env[name] = 'session'
  return env
}

function sourceOf(ctx: PlatformContext, cwd: string, extra: NodeJS.ProcessEnv = {}): Promise<[string, string]> {
  const scoped = platformContext({ ...ctx, env: { ...ctx.env, ...extra } })
  return resolveProfile({ cwd }, scoped).then((resolved) => [resolved.profile.name, resolved.source])
}

test('envFor on the builtin never defines a harness home, for any harness', () => {
  for (const harness of ['claude', 'codex', 'all', 'gemini', 'opencode', 'antigravity'] as const) {
    const env = envFor(builtin, harness, dirtyEnv())
    assert.equal(env['CLAUDE_CONFIG_DIR'], undefined, harness)
    assert.equal(env['CODEX_HOME'], undefined, harness)
    assert.equal(env[PROFILE_ENV], 'personal', harness)
    for (const name of SECRETS) assert.equal(env[name], `secret-${name}`, `${harness} ${name}`)
    assert.equal(env['BITA_CHILD'], '1')
    assert.equal(env['CLAUDE_CODE_SSE_PORT'], '1234')
    assert.equal(env['HOME'], '/home/me')
  }
})

test('envFor strips every harness session variable for builtin and non-builtin profiles', () => {
  for (const profile of [builtin, work]) {
    for (const harness of ['claude', 'codex', 'all', 'gemini', 'opencode', 'antigravity'] as const) {
      const env = envFor(profile, harness, dirtyEnv())
      for (const name of [...HARNESS_SESSION_ENV, ...ANTIGRAVITY_SESSION_ENV]) assert.equal(env[name], undefined, `${profile.name} ${harness} ${name}`)
    }
  }
})

test('envFor is pure: it returns a copy and leaves baseEnv untouched', () => {
  const base = dirtyEnv()
  const snapshot = { ...base }
  for (const profile of [builtin, work]) {
    const env = envFor(profile, 'all', base)
    assert.notEqual(env, base)
    env['EXTRA'] = 'x'
    assert.deepEqual(base, snapshot)
  }
  assert.deepEqual(envFor(work, 'all', {}), { CLAUDE_CONFIG_DIR: '/p/work/claude', CODEX_HOME: '/p/work/codex', DEN_PROFILE: 'work' })
  assert.deepEqual(envFor(builtin, 'all', {}), { DEN_PROFILE: 'personal' })
})

test('envFor on a non-builtin profile defines only the home of the requested harness and drops the inherited ones', () => {
  const claude = envFor(work, 'claude', dirtyEnv())
  assert.equal(claude['CLAUDE_CONFIG_DIR'], '/p/work/claude')
  assert.equal(claude['CODEX_HOME'], undefined)
  const codex = envFor(work, 'codex', dirtyEnv())
  assert.equal(codex['CODEX_HOME'], '/p/work/codex')
  assert.equal(codex['CLAUDE_CONFIG_DIR'], undefined)
  const all = envFor(work, 'all', dirtyEnv())
  assert.equal(all['CLAUDE_CONFIG_DIR'], '/p/work/claude')
  assert.equal(all['CODEX_HOME'], '/p/work/codex')
  for (const env of [claude, codex, all]) {
    for (const name of SECRETS) assert.equal(env[name], undefined, name)
    assert.equal(env[PROFILE_ENV], 'work')
    assert.equal(env['BITA_CHILD'], '1')
  }
  for (const harness of ['gemini', 'opencode', 'antigravity'] as const) {
    const env = envFor(work, harness, dirtyEnv())
    assert.equal(env['CLAUDE_CONFIG_DIR'], undefined, harness)
    assert.equal(env['CODEX_HOME'], undefined, harness)
    assert.equal(env[PROFILE_ENV], 'work', harness)
  }
})

test('envFor drops inherited homes and tokens whatever the case of their names', () => {
  const env = envFor(work, 'claude', { claude_config_dir: '/x', Codex_Home: '/y', anthropic_api_key: 'k', PATH: '/bin' })
  assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_CONFIG_DIR', 'DEN_PROFILE', 'PATH'])
  assert.deepEqual(Object.keys(envFor(builtin, 'claude', { claude_config_dir: '/x', Codex_Home: '/y', PATH: '/bin' })).sort(), ['DEN_PROFILE', 'PATH'])
})

test('envFor leaves a single DEN_PROFILE even if the base used another case', () => {
  const env = envFor(work, 'claude', { den_profile: 'other', PATH: '/bin' })
  assert.deepEqual(Object.keys(env).filter((key) => key.toUpperCase() === 'DEN_PROFILE'), ['DEN_PROFILE'])
  assert.equal(env[PROFILE_ENV], 'work')
})

test('resolveProfile compares directories by segments, so a shared prefix is not a match', { skip: posixOnly }, async (t) => {
  const ctx = await sandboxed(t)
  await addProfile('work', ctx)
  const root = path.join(ctx.home, 'dev', 'acme')
  for (const dir of [path.join(root, 'deep', 'er'), `${root}-2`, `${root}x`]) await mkdir(dir, { recursive: true })
  await mapDir(root, 'work', ctx)
  assert.deepEqual(await sourceOf(ctx, root), ['work', 'dir'])
  assert.deepEqual(await sourceOf(ctx, `${root}/`), ['work', 'dir'])
  assert.deepEqual(await sourceOf(ctx, path.join(root, 'deep', 'er')), ['work', 'dir'])
  assert.deepEqual(await sourceOf(ctx, path.join(root, 'deep', '..', 'deep', 'er')), ['work', 'dir'])
  assert.deepEqual(await sourceOf(ctx, `${root}-2`), ['default', 'default'])
  assert.deepEqual(await sourceOf(ctx, `${root}x`), ['default', 'default'])
  assert.deepEqual(await sourceOf(ctx, path.dirname(root)), ['default', 'default'])
})

test('resolveProfile picks the longest prefix whatever the order of dirs in the file', { skip: posixOnly }, async (t) => {
  const ctx = await sandboxed(t)
  await addProfile('work', ctx)
  await addProfile('client', ctx)
  const outer = path.join(ctx.home, 'a')
  const inner = path.join(outer, 'b', 'c')
  await mkdir(inner, { recursive: true })
  await mapDir(outer, 'work', ctx)
  await mapDir(inner, 'client', ctx)
  const file = JSON.parse(await readFile(profilesPath(ctx), 'utf8')) as { dirs: unknown[] }
  for (const dirs of [file.dirs, [...file.dirs].reverse()]) {
    await writeFile(profilesPath(ctx), JSON.stringify({ ...file, dirs }))
    assert.deepEqual(await sourceOf(ctx, inner), ['client', 'dir'])
    assert.deepEqual(await sourceOf(ctx, path.join(outer, 'b')), ['work', 'dir'])
  }
})

test('resolveProfile follows symlinks on both sides and expands ~ in stored dirs', { skip: posixOnly }, async (t) => {
  const ctx = await sandboxed(t)
  await addProfile('work', ctx)
  const real = path.join(ctx.home, 'real', 'repo')
  await mkdir(path.join(real, 'src'), { recursive: true })
  const outside = path.join(ctx.home, 'outside')
  await mkdir(outside)
  await symlink(real, path.join(ctx.home, 'alias'))
  await symlink(outside, path.join(real, 'escape'))
  await mapDir(real, 'work', ctx)
  assert.deepEqual(await sourceOf(ctx, path.join(ctx.home, 'alias', 'src')), ['work', 'dir'])
  assert.deepEqual(await sourceOf(ctx, path.join(real, 'escape')), ['default', 'default'])

  const stored = JSON.parse(await readFile(profilesPath(ctx), 'utf8')) as { dirs: { path: string }[] }
  assert.equal(stored.dirs[0]?.path, '~/real/repo')
  await writeFile(profilesPath(ctx), JSON.stringify({ ...stored, dirs: [{ path: '~/alias', profile: 'work' }] }))
  assert.deepEqual(await sourceOf(ctx, path.join(real, 'src')), ['work', 'dir'])
})

test('resolveProfile tolerates a mapped dir that no longer exists and a cwd that does not exist yet', { skip: posixOnly }, async (t) => {
  const ctx = await sandboxed(t)
  await addProfile('work', ctx)
  const gone = path.join(ctx.home, 'gone')
  await mkdir(gone)
  await mapDir(gone, 'work', ctx)
  assert.deepEqual(await sourceOf(ctx, path.join(gone, 'not', 'created')), ['work', 'dir'])
  await rm(gone, { recursive: true })
  assert.deepEqual(await sourceOf(ctx, gone), ['work', 'dir'])
  assert.deepEqual(await sourceOf(ctx, path.join(ctx.home, 'elsewhere')), ['default', 'default'])
})

test('resolveProfile finds a mapping when the cwd does not exist under a symlinked mapped dir', { skip: posixOnly }, async (t) => {
  const ctx = await sandboxed(t)
  await addProfile('work', ctx)
  const real = path.join(ctx.home, 'real')
  await mkdir(real)
  await symlink(real, path.join(ctx.home, 'alias'))
  await mapDir(real, 'work', ctx)
  assert.deepEqual(await sourceOf(ctx, path.join(ctx.home, 'alias', 'missing')), ['work', 'dir'])
})

test('resolveProfile matches a child whose name starts with two dots', { skip: posixOnly }, async (t) => {
  const ctx = await sandboxed(t)
  await addProfile('work', ctx)
  const root = path.join(ctx.home, 'root')
  const child = path.join(root, '..hidden')
  await mkdir(child, { recursive: true })
  await mapDir(root, 'work', ctx)
  assert.deepEqual(await sourceOf(ctx, child), ['work', 'dir'])
})

test('tildePath stores a home child whose name starts with two dots as ~/', () => {
  const ctx = platformContext({ platform: 'linux', home: '/home/me', env: {} })
  assert.equal(tildePath('/home/me/..hidden/x', ctx), '~/..hidden/x')
})

test('the explicit profile beats DEN_PROFILE and a mapped dir; empty values fall through', { skip: posixOnly }, async (t) => {
  const ctx = await sandboxed(t)
  await addProfile('work', ctx)
  await addProfile('client', ctx)
  const dir = path.join(ctx.home, 'repo')
  await mkdir(dir)
  await mapDir(dir, 'client', ctx)
  const withEnv = platformContext({ ...ctx, env: { ...ctx.env, DEN_PROFILE: 'work' } })
  assert.deepEqual(await resolveProfile({ cwd: dir, explicit: 'client' }, withEnv).then((r) => [r.profile.name, r.source]), ['client', 'explicit'])
  assert.deepEqual(await resolveProfile({ cwd: dir }, withEnv).then((r) => [r.profile.name, r.source]), ['work', 'env'])
  assert.deepEqual(await resolveProfile({ cwd: dir, explicit: '' }, ctx).then((r) => [r.profile.name, r.source]), ['client', 'dir'])
  assert.deepEqual(await resolveProfile({ cwd: dir, explicit: null }, ctx).then((r) => [r.profile.name, r.source]), ['client', 'dir'])
  const emptyEnv = platformContext({ ...ctx, env: { ...ctx.env, DEN_PROFILE: '' } })
  assert.deepEqual(await resolveProfile({ cwd: dir }, emptyEnv).then((r) => [r.profile.name, r.source]), ['client', 'dir'])
  const notFound = (error: unknown): boolean => error instanceof ProfileError && error.code === 'PROFILE_NOT_FOUND'
  await assert.rejects(resolveProfile({ cwd: dir, explicit: 'ghost' }, withEnv), notFound)
})

test('names that exist on Object.prototype are not profiles', async (t) => {
  const ctx = await sandboxed(t)
  const notFound = (error: unknown): boolean => error instanceof ProfileError && error.code === 'PROFILE_NOT_FOUND'
  for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) await assert.rejects(resolveProfile({ explicit: name }, ctx), notFound, name)
  const added = await addProfile('constructor', ctx)
  assert.equal(added.created, true)
  assert.equal((await getProfile('constructor', ctx)).builtin, false)
  for (const name of ['toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    await assert.rejects(addProfile(name, ctx), (error: unknown) => error instanceof ProfileError && error.code === 'PROFILE_INVALID_NAME', name)
  }
})

test('a file whose default or dirs name an inherited member is rejected', () => {
  const ctx = platformContext({ platform: 'linux', home: '/h', env: {} })
  const base = { version: 1, profiles: { personal: { builtin: true } } }
  assert.throws(() => parseProfiles({ ...base, default: 'constructor' }, ctx), (error: unknown) => error instanceof ProfileError && error.code === 'PROFILES_INVALID')
  assert.throws(
    () => parseProfiles({ ...base, default: 'personal', dirs: [{ path: '/x', profile: 'toString' }] }, ctx),
    (error: unknown) => error instanceof ProfileError && error.code === 'PROFILES_INVALID',
  )
})

test('parseProfiles enforces names, a single builtin, an existing default and absolute dirs', () => {
  const ctx = platformContext({ platform: 'linux', home: '/h', env: {} })
  const ok = { version: 1, default: 'a', profiles: { a: { builtin: true } } }
  assert.equal(parseProfiles(ok, ctx).default, 'a')
  const rejects: [string, unknown][] = [
    ['uppercase name', { ...ok, profiles: { A: { builtin: true } }, default: 'A' }],
    ['digit first', { ...ok, profiles: { '1a': { builtin: true } }, default: '1a' }],
    ['33 chars', { ...ok, profiles: { a: { builtin: true }, ['b'.repeat(33)]: { claude: '/c', codex: '/x' } } }],
    ['two builtins', { ...ok, profiles: { a: { builtin: true }, b: { builtin: true } } }],
    ['no builtin', { ...ok, profiles: { a: { claude: '/c', codex: '/x' } } }],
    ['builtin with claude', { ...ok, profiles: { a: { builtin: true, claude: '/c' } } }],
    ['missing codex', { ...ok, profiles: { a: { builtin: true }, b: { claude: '/c' } } }],
    ['empty claude', { ...ok, profiles: { a: { builtin: true }, b: { claude: '', codex: '/x' } } }],
    ['default missing', { ...ok, default: 'zz' }],
    ['default not a string', { ...ok, default: 3 }],
    ['relative dir', { ...ok, dirs: [{ path: 'rel/dir', profile: 'a' }] }],
    ['dir to unknown profile', { ...ok, dirs: [{ path: '/x', profile: 'zz' }] }],
    ['dirs not an array', { ...ok, dirs: {} }],
    ['version 2', { ...ok, version: 2 }],
    ['array root', []],
    ['null root', null],
  ]
  for (const [label, value] of rejects) {
    assert.throws(() => parseProfiles(value, ctx), (error: unknown) => error instanceof ProfileError && error.code === 'PROFILES_INVALID', label)
  }
  assert.ok(parseProfiles({ ...ok, profiles: { a: { builtin: true }, ['b'.repeat(32)]: { claude: '/c', codex: '/x' } } }, ctx).profiles['b'.repeat(32)])
})

test('serializeProfiles and parseProfiles round-trip with ~ for home paths and no extra keys', () => {
  const ctx = platformContext({ platform: 'linux', home: '/home/me', env: {} })
  const parsed = parseProfiles(
    {
      version: 1,
      default: 'personal',
      profiles: { personal: { builtin: true }, trabajo: { claude: '~/.config/kikedealba/profiles/trabajo/claude', codex: '/opt/codex', createdAt: '2026-11-08T17:00:00.000Z' } },
      dirs: [{ path: '~/dev/empresa', profile: 'trabajo' }],
    },
    ctx,
  )
  assert.equal(parsed.profiles['trabajo']?.claude, '/home/me/.config/kikedealba/profiles/trabajo/claude')
  const out = serializeProfiles(parsed, ctx)
  assert.deepEqual(out['profiles'], {
    personal: { builtin: true },
    trabajo: { claude: '~/.config/kikedealba/profiles/trabajo/claude', codex: '/opt/codex', createdAt: '2026-11-08T17:00:00.000Z' },
  })
  assert.deepEqual(out['dirs'], [{ path: '~/dev/empresa', profile: 'trabajo' }])
  assert.deepEqual(parseProfiles(JSON.parse(JSON.stringify(out)), ctx), parsed)
})

test('tildePath and expandPath handle the home itself, siblings of home and Windows separators', () => {
  const linux = platformContext({ platform: 'linux', home: '/home/me', env: {} })
  assert.equal(tildePath('/home/me', linux), '~')
  assert.equal(tildePath('/home/me/x/y', linux), '~/x/y')
  assert.equal(tildePath('/home/me2/x', linux), '/home/me2/x')
  assert.equal(tildePath('/home', linux), '/home')
  assert.equal(expandPath('~', linux), '/home/me')
  assert.equal(expandPath('~/x/y', linux), '/home/me/x/y')
  assert.equal(expandPath('~other/x', linux), '~other/x')
  assert.equal(expandPath('/abs', linux), '/abs')

  const win = platformContext({ platform: 'win32', home: 'C:\\Users\\me', env: {} })
  assert.equal(tildePath('C:\\Users\\me\\dev\\x', win), '~/dev/x')
  assert.equal(tildePath('c:\\users\\ME\\dev', win), '~/dev')
  assert.equal(tildePath('D:\\data\\x', win), 'D:\\data\\x')
  assert.equal(tildePath('C:\\Users\\me2\\x', win), 'C:\\Users\\me2\\x')
  assert.equal(expandPath('~/dev/x', win), 'C:\\Users\\me\\dev\\x')
  assert.equal(expandPath('~\\dev\\x', win), 'C:\\Users\\me\\dev\\x')
  assert.equal(expandPath('~', win), 'C:\\Users\\me')
})

test('Windows contexts build profile paths with backslashes under %APPDATA%', () => {
  const win = platformContext({ platform: 'win32', home: 'C:\\Users\\me', env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } })
  assert.equal(profilesPath(win), 'C:\\Users\\me\\AppData\\Roaming\\kikedealba\\profiles.json')
  assert.deepEqual(profileHomes('work', win), {
    root: 'C:\\Users\\me\\AppData\\Roaming\\kikedealba\\profiles\\work',
    claude: 'C:\\Users\\me\\AppData\\Roaming\\kikedealba\\profiles\\work\\claude',
    codex: 'C:\\Users\\me\\AppData\\Roaming\\kikedealba\\profiles\\work\\codex',
  })
  const fallback = platformContext({ platform: 'win32', home: 'C:\\Users\\me', env: {} })
  assert.equal(profilesPath(fallback), 'C:\\Users\\me\\AppData\\Roaming\\kikedealba\\profiles.json')
  const override = platformContext({ platform: 'win32', home: 'C:\\Users\\me', env: { KIT_CONFIG_DIR: 'D:\\cfg' } })
  assert.equal(profilesPath(override), 'D:\\cfg\\profiles.json')
  assert.equal(profilesPath(platformContext({ platform: 'linux', home: '/h', env: { KIT_CONFIG_DIR: '' } })), '/h/.config/kikedealba/profiles.json')
})

test('profile directories are 0700 whatever the umask and a repair tightens loosened modes', { skip: posixOnly }, async (t) => {
  const ctx = await sandboxed(t)
  const previous = process.umask(0)
  try {
    const { profile } = await addProfile('work', ctx)
    const homes = profileHomes('work', ctx)
    for (const dir of [homes.root, profile.claude as string, profile.codex as string]) assert.equal(statSync(dir).mode & 0o777, 0o700, dir)
    assert.equal(statSync(profilesPath(ctx)).mode & 0o777, 0o600)
    for (const dir of [homes.root, homes.claude, homes.codex]) chmodSync(dir, 0o755)
    chmodSync(profilesPath(ctx), 0o644)
    const again = await addProfile('work', ctx)
    assert.equal(again.created, false)
    for (const dir of [homes.root, homes.claude, homes.codex]) assert.equal(statSync(dir).mode & 0o777, 0o700, dir)
    await mapDir(ctx.home, 'work', ctx)
    assert.equal(statSync(profilesPath(ctx)).mode & 0o777, 0o600)
  } finally {
    process.umask(previous)
  }
})

test('addProfile rejects invalid names before touching the disk', async (t) => {
  const ctx = await sandboxed(t)
  for (const name of ['', 'Work', 'a_b', '1a', '-a', 'a b', 'a/b', '../x', 'a'.repeat(33), 'trabajó']) {
    await assert.rejects(addProfile(name, ctx), (error: unknown) => error instanceof ProfileError && error.code === 'PROFILE_INVALID_NAME', name)
  }
  assert.equal(existsSync(profilesPath(ctx)), false)
  assert.equal(existsSync(path.join(path.dirname(profilesPath(ctx)), 'profiles')), false)
  assert.equal((await addProfile('a'.repeat(32), ctx)).created, true)
})

test('a missing profiles.json is never created by reading', async (t) => {
  const ctx = await sandboxed(t)
  const listed = await listProfiles(ctx)
  assert.equal(listed.default, 'default')
  assert.deepEqual(listed.dirs, [])
  assert.equal((await resolveProfile({ cwd: ctx.home }, ctx)).source, 'default')
  assert.equal(existsSync(profilesPath(ctx)), false)
})

function backupsOf(file: string): string[] {
  const prefix = `${path.basename(file)}.backup-`
  return readdirSync(path.dirname(file)).filter((name) => name.startsWith(prefix)).map((name) => path.join(path.dirname(file), name))
}

test('repairSharedLinks keeps a shared settings.json that is itself a symlink and never merges the local copy', { skip: posixOnly }, async (t) => {
  const ctx = await sandboxed(t)
  await addProfile('work', ctx)
  const dotfiles = path.join(ctx.home, 'dotfiles', 'claude-settings.json')
  await mkdir(path.dirname(dotfiles), { recursive: true })
  await writeFile(dotfiles, JSON.stringify({ model: 'opus' }))
  await mkdir(path.join(ctx.home, '.claude'), { recursive: true })
  const shared = path.join(ctx.home, '.claude', 'settings.json')
  await symlink(dotfiles, shared)
  const claudeHome = (await getProfile('work', ctx)).claude as string
  const local = path.join(claudeHome, 'settings.json')
  await writeFile(local, JSON.stringify({ model: 'sonnet', theme: 'dark' }))

  const repaired = (await repairSharedLinks('work', ctx)).find((link) => link.name === 'settings.json')
  assert.equal(repaired?.previous, 'replaced')
  assert.equal(repaired?.state, 'linked')
  assert.ok(lstatSync(shared).isSymbolicLink())
  assert.equal(readlinkSync(shared), dotfiles)
  assert.ok(lstatSync(local).isSymbolicLink())
  assert.deepEqual(JSON.parse(readFileSync(dotfiles, 'utf8')), { model: 'opus' })
  assert.deepEqual(backupsOf(local), [repaired?.backup])
  assert.deepEqual(JSON.parse(readFileSync(repaired?.backup as string, 'utf8')), { model: 'sonnet', theme: 'dark' })
})

test('repairSharedLinks never rewrites the shared file, so its mode stays', { skip: posixOnly }, async (t) => {
  const ctx = await sandboxed(t)
  await addProfile('work', ctx)
  const shared = path.join(ctx.home, '.claude', 'settings.json')
  await mkdir(path.dirname(shared), { recursive: true })
  await writeFile(shared, JSON.stringify({ model: 'opus' }), { mode: 0o600 })
  chmodSync(shared, 0o600)
  const claudeHome = (await getProfile('work', ctx)).claude as string
  await writeFile(path.join(claudeHome, 'settings.json'), JSON.stringify({ theme: 'dark' }))
  const previous = process.umask(0o022)
  try {
    await repairSharedLinks('work', ctx)
  } finally {
    process.umask(previous)
  }
  assert.equal(statSync(shared).mode & 0o777, 0o600)
  assert.equal(await readFile(shared, 'utf8'), JSON.stringify({ model: 'opus' }))
})

test('repairSharedLinks moves any replaced file aside with a timestamped backup, whatever its content', { skip: posixOnly }, async (t) => {
  const ctx = await sandboxed(t)
  await addProfile('work', ctx)
  const shared = path.join(ctx.home, '.claude', 'settings.json')
  await mkdir(path.dirname(shared), { recursive: true })
  const claudeHome = (await getProfile('work', ctx)).claude as string
  const local = path.join(claudeHome, 'settings.json')
  for (const content of ['{"a":', '[1,2]', 'null', '{"a":1}']) {
    await rm(local, { force: true })
    for (const old of backupsOf(local)) await rm(old, { force: true })
    await writeFile(shared, '{"x":1}')
    await writeFile(local, content)
    const repaired = (await repairSharedLinks('work', ctx)).find((link) => link.name === 'settings.json')
    assert.equal(repaired?.state, 'linked', content)
    assert.match(path.basename(repaired?.backup as string), /^settings\.json\.backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(-\d+)?$/)
    assert.equal(await readFile(shared, 'utf8'), '{"x":1}', content)
    assert.equal(await readFile(repaired?.backup as string, 'utf8'), content, content)
  }
})

test('two repairs in a row keep both backups instead of overwriting the first', { skip: posixOnly }, async (t) => {
  const ctx = await sandboxed(t)
  await addProfile('work', ctx)
  const claudeHome = (await getProfile('work', ctx)).claude as string
  const local = path.join(claudeHome, 'CLAUDE.md')
  await writeFile(local, 'first\n')
  const first = (await repairSharedLinks('work', ctx)).find((link) => link.name === 'CLAUDE.md')?.backup
  await rm(local)
  await writeFile(local, 'second\n')
  const second = (await repairSharedLinks('work', ctx)).find((link) => link.name === 'CLAUDE.md')?.backup
  assert.notEqual(first, second)
  assert.equal(await readFile(first as string, 'utf8'), 'first\n')
  assert.equal(await readFile(second as string, 'utf8'), 'second\n')
  assert.equal(await readFile(path.join(ctx.home, '.claude', 'CLAUDE.md'), 'utf8'), '')
})

test('repairSharedLinks moves a replaced directory aside without touching the shared one', { skip: posixOnly }, async (t) => {
  const ctx = await sandboxed(t)
  await addProfile('work', ctx)
  const shared = path.join(ctx.home, '.claude', 'skills')
  await mkdir(path.join(shared, 'both'), { recursive: true })
  await writeFile(path.join(shared, 'both', 'SKILL.md'), 'shared version')
  const claudeHome = (await getProfile('work', ctx)).claude as string
  const local = path.join(claudeHome, 'skills')
  await mkdir(path.join(local, 'only-local'), { recursive: true })
  await writeFile(path.join(local, 'only-local', 'SKILL.md'), 'new')
  const repaired = (await repairSharedLinks('work', ctx)).find((link) => link.name === 'skills')
  assert.equal(existsSync(path.join(shared, 'only-local')), false)
  assert.equal(await readFile(path.join(shared, 'both', 'SKILL.md'), 'utf8'), 'shared version')
  assert.equal(await readFile(path.join(repaired?.backup as string, 'only-local', 'SKILL.md'), 'utf8'), 'new')
  assert.ok(lstatSync(local).isSymbolicLink())
})

test('repairSharedLinks handles a dir where a file is expected and a file where a dir is expected', { skip: posixOnly }, async (t) => {
  const ctx = await sandboxed(t)
  await addProfile('work', ctx)
  const claudeHome = (await getProfile('work', ctx)).claude as string
  await mkdir(path.join(claudeHome, 'settings.json'))
  await writeFile(path.join(claudeHome, 'settings.json', 'inner'), 'x')
  await writeFile(path.join(claudeHome, 'skills'), 'not a dir')
  const repaired = Object.fromEntries((await repairSharedLinks('work', ctx)).map((link) => [link.name, link]))
  assert.equal(repaired['settings.json']?.state, 'linked')
  assert.equal(repaired['skills']?.state, 'linked')
  assert.equal(await readFile(path.join(repaired['settings.json']?.backup as string, 'inner'), 'utf8'), 'x')
  assert.equal(await readFile(repaired['skills']?.backup as string, 'utf8'), 'not a dir')
})

test('on Windows a copied file counts as healthy and repair leaves it alone', { skip: process.platform !== 'win32' && 'needs real Windows paths' }, async (t) => {
  const dir = await realpath(await tempDir(t))
  const ctx = platformContext({ home: dir, env: { KIT_CONFIG_DIR: path.join(dir, 'cfg') } })
  await addProfile('work', ctx)
  const profile = await getProfile('work', ctx)
  await mkdir(path.join(dir, '.claude'), { recursive: true })
  await writeFile(path.join(dir, '.claude', 'CLAUDE.md'), 'shared\n')
  await writeFile(path.join(profile.claude as string, 'CLAUDE.md'), 'copy\n')
  const inspected = (await inspectSharedLinks('work', ctx)).find((link) => link.name === 'CLAUDE.md')
  assert.equal(inspected?.state, 'copied')
  const repaired = (await repairSharedLinks('work', ctx)).find((link) => link.name === 'CLAUDE.md')
  assert.deepEqual([repaired?.previous, repaired?.state, repaired?.backup], ['copied', 'copied', null])
  assert.equal(await readFile(path.join(profile.claude as string, 'CLAUDE.md'), 'utf8'), 'copy\n')
})

test('repairSharedLinks replaces foreign and dangling links, keeps equivalent relative links and leaves their targets alone', { skip: posixOnly }, async (t) => {
  const ctx = await sandboxed(t)
  await addProfile('work', ctx)
  const shared = path.join(ctx.home, '.claude')
  await mkdir(shared, { recursive: true })
  await writeFile(path.join(shared, 'CLAUDE.md'), 'shared\n')
  const claudeHome = (await getProfile('work', ctx)).claude as string
  const foreign = path.join(ctx.home, 'foreign.md')
  await writeFile(foreign, 'foreign\n')
  await symlink(foreign, path.join(claudeHome, 'CLAUDE.md'))
  await symlink(path.join(ctx.home, 'missing-dir'), path.join(claudeHome, 'skills'))
  await symlink(path.relative(claudeHome, path.join(shared, 'settings.json')), path.join(claudeHome, 'settings.json'))
  await writeFile(path.join(shared, 'settings.json'), '{}')
  const before = Object.fromEntries((await inspectSharedLinks('work', ctx)).map((link) => [link.name, link.state]))
  assert.deepEqual([before['CLAUDE.md'], before['skills'], before['settings.json']], ['foreign', 'foreign', 'linked'])
  await repairSharedLinks('work', ctx)
  assert.equal(readlinkSync(path.join(claudeHome, 'CLAUDE.md')), path.join(shared, 'CLAUDE.md'))
  assert.equal(readlinkSync(path.join(claudeHome, 'settings.json')), path.relative(claudeHome, path.join(shared, 'settings.json')))
  assert.equal(await readFile(foreign, 'utf8'), 'foreign\n')
  assert.equal(await readFile(path.join(shared, 'CLAUDE.md'), 'utf8'), 'shared\n')
  assert.ok((await inspectSharedLinks('work', ctx)).every((link) => link.state === 'linked'))
})

test('repairSharedLinks never links credentials, sessions, plugins or history', { skip: posixOnly }, async (t) => {
  const ctx = await sandboxed(t)
  await addProfile('work', ctx)
  const links = await repairSharedLinks('work', ctx)
  assert.deepEqual(links.map((link) => `${link.harness}/${link.name}`).sort(), [
    'claude/CLAUDE.md',
    'claude/agents',
    'claude/commands',
    'claude/settings.json',
    'claude/skills',
    'codex/AGENTS.md',
    'codex/config.toml',
  ])
  const profile = await getProfile('work', ctx)
  for (const name of ['.credentials.json', '.claude.json', 'plugins', 'projects', 'todos']) assert.equal(existsSync(path.join(profile.claude as string, name)), false, name)
  for (const name of ['auth.json', 'sessions', 'history.jsonl']) assert.equal(existsSync(path.join(profile.codex as string, name)), false, name)
  assert.equal(existsSync(path.join(ctx.home, '.claude', '.credentials.json')), false)
})

test('repairSharedLinks refuses a missing profile and the first run creates empty shared targets', { skip: posixOnly }, async (t) => {
  const ctx = await sandboxed(t)
  await assert.rejects(repairSharedLinks('ghost', ctx), (error: unknown) => error instanceof ProfileError && error.code === 'PROFILE_NOT_FOUND')
  await addProfile('work', ctx)
  await repairSharedLinks('work', ctx)
  assert.equal(readFileSync(path.join(ctx.home, '.claude', 'settings.json'), 'utf8'), '{}\n')
  assert.equal(readFileSync(path.join(ctx.home, '.claude', 'CLAUDE.md'), 'utf8'), '')
  assert.equal(readFileSync(path.join(ctx.home, '.codex', 'config.toml'), 'utf8'), '')
  assert.ok(statSync(path.join(ctx.home, '.claude', 'skills')).isDirectory())
  const second = await repairSharedLinks('work', ctx)
  assert.ok(second.every((link) => link.previous === 'linked' && link.backup === null))
  assert.deepEqual(backupsOf(path.join((await getProfile('work', ctx)).claude as string, 'settings.json')), [])
})

test('concurrent profile changes are serialised by the lock and none is lost', async (t) => {
  const ctx = await sandboxed(t)
  const names = Array.from({ length: 8 }, (_, index) => `p${index}`)
  await Promise.all(names.map((name) => addProfile(name, ctx)))
  const dirs = names.map((name) => path.join(ctx.home, 'repos', name))
  for (const dir of dirs) await mkdir(dir, { recursive: true })
  await Promise.all(dirs.map((dir, index) => mapDir(dir, names[index] as string, ctx)))
  const listed = await listProfiles(ctx)
  assert.deepEqual(listed.profiles.map((profile) => profile.name).sort(), ['default', ...names].sort())
  assert.equal(listed.dirs.length, names.length)
  assert.equal(existsSync(`${profilesPath(ctx)}.lock`), false)
})

test('relative profile directories and a relative KIT_CONFIG_DIR are not accepted', () => {
  const ctx = platformContext({ platform: 'linux', home: '/h', env: {} })
  const base = { version: 1, default: 'a', profiles: { a: { builtin: true }, b: { claude: 'rel/claude', codex: '/abs/codex' } } }
  assert.throws(() => parseProfiles(base, ctx), (error: unknown) => error instanceof ProfileError && error.code === 'PROFILES_INVALID')
  assert.equal(profilesPath(platformContext({ platform: 'linux', home: '/h', env: { KIT_CONFIG_DIR: 'relative/cfg' } })), '/h/.config/kikedealba/profiles.json')
})

test('a profile home that resolves to the shared home counts as linked and nothing is moved', { skip: posixOnly }, async (t) => {
  const ctx = await sandboxed(t)
  const { profile } = await addProfile('work', ctx)
  const shared = path.join(ctx.home, '.claude')
  await mkdir(shared, { recursive: true })
  await writeFile(path.join(shared, 'CLAUDE.md'), 'shared rules\n')
  await writeFile(path.join(shared, 'settings.json'), '{"model":"opus"}')
  await rm(profile.claude as string, { recursive: true })
  await symlink(shared, profile.claude as string)
  const claude = (await inspectSharedLinks('work', ctx)).filter((link) => link.harness === 'claude')
  assert.ok(claude.every((link) => link.state === 'linked'), JSON.stringify(claude))
  const repaired = (await repairSharedLinks('work', ctx)).filter((link) => link.harness === 'claude')
  assert.ok(repaired.every((link) => link.previous === 'linked' && link.backup === null))
  assert.equal(await readFile(path.join(shared, 'CLAUDE.md'), 'utf8'), 'shared rules\n')
  assert.ok(lstatSync(path.join(shared, 'CLAUDE.md')).isFile())
  assert.deepEqual(readdirSync(shared).filter((name) => name.includes('.backup-')), [])
})
