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
  mergeMissingJson,
  mergeMissingToml,
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

test('envFor leaves a single DEN_PROFILE even if the base used another case', { todo: 'envFor sets DEN_PROFILE without removing a differently cased inherited key, so a win32 child sees two' }, () => {
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

test('resolveProfile finds a mapping when the cwd does not exist under a symlinked mapped dir', { skip: posixOnly, todo: 'realOrResolved does not resolve the existing ancestors of a missing cwd, so a symlinked path misses the realpath mapping' }, async (t) => {
  const ctx = await sandboxed(t)
  await addProfile('work', ctx)
  const real = path.join(ctx.home, 'real')
  await mkdir(real)
  await symlink(real, path.join(ctx.home, 'alias'))
  await mapDir(real, 'work', ctx)
  assert.deepEqual(await sourceOf(ctx, path.join(ctx.home, 'alias', 'missing')), ['work', 'dir'])
})

test('resolveProfile matches a child whose name starts with two dots', { skip: posixOnly, todo: 'isWithin treats any relative path starting with ".." as outside, including a directory named "..hidden"' }, async (t) => {
  const ctx = await sandboxed(t)
  await addProfile('work', ctx)
  const root = path.join(ctx.home, 'root')
  const child = path.join(root, '..hidden')
  await mkdir(child, { recursive: true })
  await mapDir(root, 'work', ctx)
  assert.deepEqual(await sourceOf(ctx, child), ['work', 'dir'])
})

test('tildePath stores a home child whose name starts with two dots as ~/', { todo: 'tildePath uses startsWith("..") on the relative path and keeps the absolute path for a "..hidden" directory' }, () => {
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

test('names that exist on Object.prototype are not profiles', { todo: 'profiles is a plain object and lookups use `in` and indexing, so "constructor" and "toString" resolve to inherited members' }, async (t) => {
  const ctx = await sandboxed(t)
  const notFound = (error: unknown): boolean => error instanceof ProfileError && error.code === 'PROFILE_NOT_FOUND'
  for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    await assert.rejects(resolveProfile({ explicit: name }, ctx), notFound, name)
    const added = await addProfile(name, ctx)
    assert.equal(added.created, true, name)
    assert.equal((await getProfile(name, ctx)).builtin, false, name)
  }
})

test('a file whose default or dirs name an inherited member is rejected', { todo: 'parseProfiles validates `default` and dirs[].profile with `in`, which is true for inherited members' }, () => {
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

test('repairSharedLinks merges into a shared settings.json that is itself a symlink and keeps both links', { skip: posixOnly }, async (t) => {
  const ctx = await sandboxed(t)
  await addProfile('work', ctx)
  const dotfiles = path.join(ctx.home, 'dotfiles', 'claude-settings.json')
  await mkdir(path.dirname(dotfiles), { recursive: true })
  await writeFile(dotfiles, JSON.stringify({ model: 'opus' }))
  await mkdir(path.join(ctx.home, '.claude'), { recursive: true })
  const shared = path.join(ctx.home, '.claude', 'settings.json')
  await symlink(dotfiles, shared)
  const claudeHome = (await getProfile('work', ctx)).claude as string
  await writeFile(path.join(claudeHome, 'settings.json'), JSON.stringify({ model: 'sonnet', theme: 'dark' }))

  const repaired = await repairSharedLinks('work', ctx)
  assert.deepEqual(repaired.find((link) => link.name === 'settings.json')?.merged, ['theme'])
  assert.ok(lstatSync(shared).isSymbolicLink())
  assert.equal(readlinkSync(shared), dotfiles)
  assert.ok(lstatSync(path.join(claudeHome, 'settings.json')).isSymbolicLink())
  assert.deepEqual(JSON.parse(readFileSync(dotfiles, 'utf8')), { model: 'opus', theme: 'dark' })
  assert.deepEqual(readdirSync(path.dirname(dotfiles)).sort(), ['claude-settings.json'])
})

test('repairSharedLinks keeps the mode of the shared file it rewrites', { skip: posixOnly, todo: 'writeFileAtomic without a mode creates the temporary file with the default mode and renames it over the original, so a 0600 ~/.claude/settings.json becomes 0644' }, async (t) => {
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
})

test('repairSharedLinks never loses the local copy when a JSON file cannot be merged', { skip: posixOnly }, async (t) => {
  const ctx = await sandboxed(t)
  await addProfile('work', ctx)
  const shared = path.join(ctx.home, '.claude', 'settings.json')
  await mkdir(path.dirname(shared), { recursive: true })
  const claudeHome = (await getProfile('work', ctx)).claude as string
  const local = path.join(claudeHome, 'settings.json')
  const cases: { label: string; local: string; shared: string; sharedAfter: string }[] = [
    { label: 'invalid local', local: '{"a":', shared: '{"x":1}', sharedAfter: '{"x":1}' },
    { label: 'invalid shared', local: '{"a":1}', shared: '{"x":', sharedAfter: '{"x":' },
    { label: 'array local', local: '[1,2]', shared: '{"x":1}', sharedAfter: '{"x":1}' },
    { label: 'array shared', local: '{"a":1}', shared: '[1]', sharedAfter: '[1]' },
    { label: 'null local', local: 'null', shared: '{"x":1}', sharedAfter: '{"x":1}' },
  ]
  for (const item of cases) {
    await rm(local, { force: true })
    await rm(`${local}.backup`, { force: true })
    await rm(shared, { force: true })
    await writeFile(local, item.local)
    await writeFile(shared, item.shared)
    const repaired = (await repairSharedLinks('work', ctx)).find((link) => link.name === 'settings.json')
    assert.equal(repaired?.state, 'linked', item.label)
    assert.deepEqual(repaired?.merged, [], item.label)
    assert.equal(await readFile(shared, 'utf8'), item.sharedAfter, item.label)
    assert.equal(await readFile(`${local}.backup`, 'utf8'), item.local, item.label)
  }
})

test('repairSharedLinks adopts a replaced file when the shared one is empty and survives an empty shared JSON', { skip: posixOnly }, async (t) => {
  const ctx = await sandboxed(t)
  await addProfile('work', ctx)
  const shared = path.join(ctx.home, '.claude')
  await mkdir(shared, { recursive: true })
  await writeFile(path.join(shared, 'settings.json'), '')
  await writeFile(path.join(shared, 'CLAUDE.md'), '\n')
  const claudeHome = (await getProfile('work', ctx)).claude as string
  await writeFile(path.join(claudeHome, 'settings.json'), '{"a":{"b":1}}')
  await writeFile(path.join(claudeHome, 'CLAUDE.md'), 'my rules\n')
  const repaired = Object.fromEntries((await repairSharedLinks('work', ctx)).map((link) => [link.name, link]))
  assert.deepEqual(repaired['settings.json']?.merged, ['a'])
  assert.deepEqual(JSON.parse(await readFile(path.join(shared, 'settings.json'), 'utf8')), { a: { b: 1 } })
  assert.deepEqual(repaired['CLAUDE.md']?.merged, ['content'])
  assert.equal(await readFile(path.join(shared, 'CLAUDE.md'), 'utf8'), 'my rules\n')
})

test('repairSharedLinks never overwrites a non-empty shared markdown file with the local copy', { skip: posixOnly }, async (t) => {
  const ctx = await sandboxed(t)
  await addProfile('work', ctx)
  const shared = path.join(ctx.home, '.claude')
  await mkdir(shared, { recursive: true })
  await writeFile(path.join(shared, 'CLAUDE.md'), 'shared rules\n')
  const claudeHome = (await getProfile('work', ctx)).claude as string
  await writeFile(path.join(claudeHome, 'CLAUDE.md'), 'local rules\n')
  const repaired = (await repairSharedLinks('work', ctx)).find((link) => link.name === 'CLAUDE.md')
  assert.deepEqual(repaired?.merged, [])
  assert.equal(await readFile(path.join(shared, 'CLAUDE.md'), 'utf8'), 'shared rules\n')
  assert.equal(await readFile(path.join(claudeHome, 'CLAUDE.md.backup'), 'utf8'), 'local rules\n')
  assert.equal(await readFile(path.join(claudeHome, 'CLAUDE.md'), 'utf8'), 'shared rules\n')
})

test('repairSharedLinks merges directories without overwriting and keeps conflicting entries in the backup', { skip: posixOnly }, async (t) => {
  const ctx = await sandboxed(t)
  await addProfile('work', ctx)
  const shared = path.join(ctx.home, '.claude', 'skills')
  await mkdir(path.join(shared, 'both'), { recursive: true })
  await writeFile(path.join(shared, 'both', 'SKILL.md'), 'shared version')
  const claudeHome = (await getProfile('work', ctx)).claude as string
  const local = path.join(claudeHome, 'skills')
  await mkdir(path.join(local, 'both'), { recursive: true })
  await mkdir(path.join(local, 'only-local'), { recursive: true })
  await writeFile(path.join(local, 'both', 'SKILL.md'), 'local version')
  await writeFile(path.join(local, 'only-local', 'SKILL.md'), 'new')
  await writeFile(path.join(local, '.hidden'), 'dot')
  const repaired = (await repairSharedLinks('work', ctx)).find((link) => link.name === 'skills')
  assert.deepEqual([...(repaired?.merged ?? [])].sort(), ['.hidden', 'only-local'])
  assert.equal(await readFile(path.join(shared, 'both', 'SKILL.md'), 'utf8'), 'shared version')
  assert.equal(await readFile(path.join(shared, 'only-local', 'SKILL.md'), 'utf8'), 'new')
  assert.equal(await readFile(path.join(`${local}.backup`, 'both', 'SKILL.md'), 'utf8'), 'local version')
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
  assert.equal(await readFile(path.join(claudeHome, 'settings.json.backup', 'inner'), 'utf8'), 'x')
  assert.equal(await readFile(path.join(claudeHome, 'skills.backup'), 'utf8'), 'not a dir')
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
  assert.ok(second.every((link) => link.previous === 'linked' && link.merged.length === 0 && link.backup === null))
  assert.equal(existsSync(path.join((await getProfile('work', ctx)).claude as string, 'settings.json.backup')), false)
})

test('mergeMissingJson adds only missing keys, recurses into objects and never replaces values', () => {
  const shared: Record<string, unknown> = { a: 1, o: { x: 1 }, arr: [1], n: null }
  const added = mergeMissingJson(shared, { a: 2, o: { x: 9, y: 2, deep: { z: 1 } }, arr: [2], n: { was: 'null' }, fresh: { k: 1 }, empty: {} })
  assert.deepEqual(added, ['o.y', 'o.deep', 'fresh', 'empty'])
  assert.deepEqual(shared, { a: 1, o: { x: 1, y: 2, deep: { z: 1 } }, arr: [1], n: null, fresh: { k: 1 }, empty: {} })
  assert.deepEqual(mergeMissingJson({ a: 1 }, {}), [])
})

test('mergeMissingJson keeps local keys named like Object.prototype members', { todo: 'mergeMissingJson uses `key in shared`, which is true for inherited members, so these local keys are dropped silently' }, () => {
  const shared: Record<string, unknown> = { a: 1 }
  const added = mergeMissingJson(shared, JSON.parse('{"toString":"x","constructor":{"y":1},"valueOf":2}') as Record<string, unknown>)
  assert.deepEqual(added.sort(), ['constructor', 'toString', 'valueOf'])
  assert.equal(Object.hasOwn(shared, 'toString'), true)
})

test('mergeMissingToml never drops a line of the shared file and is idempotent', () => {
  const shared = [
    '# my codex config',
    'model = "gpt"   # inline comment',
    '',
    '[mcp_servers.gaze]',
    'command = "gaze"',
    'args = [',
    '  "mcp",',
    '  "serve",',
    ']',
    '',
    '[profiles.fast]',
    'model = "mini"',
    '',
  ].join('\n')
  const local = ['model = "other"', 'approval = "never"', '', '[mcp_servers.gaze]', 'command = "x"', 'env = { A = "1" }', '', '[projects."/work/repo"]', 'trust = "trusted"', ''].join('\n')
  const first = mergeMissingToml(shared, local)
  assert.deepEqual(first.added, ['approval', 'mcp_servers.gaze.env', '[projects."/work/repo"]'])
  const sharedLines = shared.split('\n').filter((line) => line.length > 0)
  const mergedLines = first.text.split('\n')
  let cursor = 0
  for (const line of sharedLines) {
    cursor = mergedLines.indexOf(line, cursor)
    assert.notEqual(cursor, -1, `lost or reordered: ${line}`)
  }
  assert.ok(first.text.endsWith('\n'))
  assert.equal(first.text.includes('\n\n\n'), false)
  assert.deepEqual(mergeMissingToml(first.text, local), { text: first.text, added: [] })
  assert.deepEqual(mergeMissingToml(shared, ''), { text: shared, added: [] })
  assert.deepEqual(mergeMissingToml(shared, shared), { text: shared, added: [] })
})

test('mergeMissingToml treats equivalent headers, quoted keys and CRLF input as the same tables', () => {
  const sharedText = '[ mcp_servers.gaze ]\r\ncommand = "gaze"\r\n'
  const localText = '[mcp_servers.gaze]\r\ncommand = "x"\r\nargs = ["mcp"]\r\n\r\n["quoted key"]\r\nv = 1\r\n'
  const merged = mergeMissingToml(sharedText, localText)
  assert.deepEqual(merged.added, ['mcp_servers.gaze.args', '["quotedkey"]'])
  assert.match(merged.text, /command = "gaze"\r\nargs = \["mcp"\]/)
  assert.equal((merged.text.match(/mcp_servers/g) ?? []).length, 1)
})

test('mergeMissingToml keeps a table whose quoted name has spaces distinct from its squashed twin', { todo: 'header normalisation strips all whitespace, so ["a b"] and ["ab"] collide and the local table is dropped' }, () => {
  const merged = mergeMissingToml('["ab"]\nv = 1\n', '["a b"]\nv = 2\n')
  assert.equal(merged.added.length, 1)
  assert.match(merged.text, /v = 2/)
})

test('mergeMissingToml does not mistake bracketed lines inside multi-line values for table headers', { todo: 'parseTomlSections matches any line that looks like [x] as a header, even inside a multi-line array or string' }, () => {
  const local = ['matrix = [', '  [1, 2],', '  [3, 4]', ']', 'doc = """', '[not-a-table]', '"""', ''].join('\n')
  const merged = mergeMissingToml('a = 1\n', local)
  assert.deepEqual(merged.added, ['matrix', 'doc'])
  assert.equal(merged.text, `a = 1\n${local}`)
})

test('mergeMissingToml keeps array-of-tables entries that exist only in the local file', { todo: 'when the shared file already has [[x]], every local [[x]] entry is skipped silently and is not reported in `added`' }, () => {
  const merged = mergeMissingToml('[[hooks]]\nname = "a"\n', '[[hooks]]\nname = "b"\n')
  assert.match(merged.text, /name = "b"/)
  assert.deepEqual(merged.added, ['[[hooks]]'])
})
