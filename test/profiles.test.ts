import assert from 'node:assert/strict'
import { existsSync, lstatSync, readlinkSync, statSync } from 'node:fs'
import { mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import {
  PROFILE_ENV,
  ProfileError,
  addProfile,
  authStatus,
  envFor,
  expandPath,
  getProfile,
  inspectSharedLinks,
  listProfiles,
  mapDir,
  profileHome,
  profileHomes,
  profileSupports,
  profilesPath,
  removeProfile,
  renameBuiltinProfile,
  repairSharedLinks,
  resolveProfile,
  setDefaultProfile,
  tildePath,
  unmapDir,
  type Profile,
} from '../src/profiles.ts'
import { platformContext, type PlatformContext } from '../src/platform.ts'
import { fakeTool, tempDir } from './helpers.ts'

const posixOnly = process.platform === 'win32' ? 'posix modes and symlinks' : false

async function home(t: Parameters<typeof tempDir>[0], env: NodeJS.ProcessEnv = {}): Promise<PlatformContext> {
  const dir = await realpath(await tempDir(t))
  return platformContext({ home: dir, env: { PATH: process.env['PATH'] ?? '', XDG_CONFIG_HOME: path.join(dir, '.config'), ...env } })
}

const builtin: Profile = { name: 'personal', builtin: true, claude: null, codex: null, createdAt: null }
const work: Profile = { name: 'work', builtin: false, claude: '/p/work/claude', codex: '/p/work/codex', createdAt: '2026-11-08T00:00:00.000Z' }

const inherited: NodeJS.ProcessEnv = {
  PATH: '/usr/bin',
  CLAUDE_CONFIG_DIR: '/other/claude',
  CODEX_HOME: '/other/codex',
  ANTHROPIC_API_KEY: 'sk-ant',
  ANTHROPIC_AUTH_TOKEN: 'tok',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
  OPENAI_API_KEY: 'sk-oai',
  CODEX_API_KEY: 'cdx',
  CLAUDECODE: '1',
  CLAUDE_CODE_SESSION_ID: 's',
  CODEX_THREAD_ID: 't',
  ANTIGRAVITY_CONVERSATION_ID: 'c',
  DEN_PROFILE: 'work',
}

test('envFor on the builtin drops inherited homes and harness sessions but keeps tokens', () => {
  const env = envFor(builtin, 'all', inherited)
  assert.equal(env['CLAUDE_CONFIG_DIR'], undefined)
  assert.equal(env['CODEX_HOME'], undefined)
  for (const key of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'ANTIGRAVITY_CONVERSATION_ID']) assert.equal(env[key], undefined, key)
  assert.equal(env['ANTHROPIC_API_KEY'], 'sk-ant')
  assert.equal(env['OPENAI_API_KEY'], 'sk-oai')
  assert.equal(env[PROFILE_ENV], 'personal')
  assert.equal(env['PATH'], '/usr/bin')
  assert.equal(inherited['CLAUDE_CONFIG_DIR'], '/other/claude')
})

test('envFor on a non-builtin profile drops tokens and sets the home of each harness', () => {
  const all = envFor(work, 'all', inherited)
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY']) assert.equal(all[key], undefined, key)
  assert.equal(all['CLAUDE_CONFIG_DIR'], '/p/work/claude')
  assert.equal(all['CODEX_HOME'], '/p/work/codex')
  assert.equal(all[PROFILE_ENV], 'work')

  const claude = envFor(work, 'claude', inherited)
  assert.equal(claude['CLAUDE_CONFIG_DIR'], '/p/work/claude')
  assert.equal(claude['CODEX_HOME'], undefined)

  const codex = envFor(work, 'codex', inherited)
  assert.equal(codex['CODEX_HOME'], '/p/work/codex')
  assert.equal(codex['CLAUDE_CONFIG_DIR'], undefined)

  const gemini = envFor(work, 'gemini', inherited)
  assert.equal(gemini['CLAUDE_CONFIG_DIR'], undefined)
  assert.equal(gemini['CODEX_HOME'], undefined)
  assert.equal(gemini['ANTHROPIC_API_KEY'], 'sk-ant')
  const agentAccount = { ANTHROPIC_BASE_URL: 'u', OPENAI_ORG: 'o', AWS_BEARER_TOKEN_BEDROCK: 'b', CLAUDE_CODE_USE_BEDROCK: '1', GEMINI_API_KEY: 'g', GOOGLE_API_KEY: 'k', CLAUDE_CODE_SSE_PORT: '1', AWS_REGION: 'r' }
  assert.deepEqual(Object.keys(envFor(work, 'claude', agentAccount)).sort(), ['AWS_REGION', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CONFIG_DIR', 'DEN_PROFILE'])
  assert.deepEqual(Object.keys(envFor(work, 'gemini', agentAccount)).sort(), [...Object.keys(agentAccount), 'DEN_PROFILE'].sort())
  assert.equal(gemini['CLAUDECODE'], undefined)
  assert.equal(gemini[PROFILE_ENV], 'work')
})

test('envFor on a non-builtin profile drops only the agent account credentials, and only for harnesses with profiles', () => {
  const agentAccount: NodeJS.ProcessEnv = {
    ANTHROPIC_API_KEY: 'a',
    ANTHROPIC_VERTEX_PROJECT_ID: 'v',
    OPENAI_API_KEY: 'b',
    AZURE_OPENAI_API_KEY: 'c',
    CLAUDE_CODE_USE_VERTEX: '1',
    CLAUDE_CODE_OAUTH_TOKEN: 'd',
    CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'e',
    CLAUDE_CODE_API_KEY_HELPER_TTL_MS: '1',
    AWS_BEARER_TOKEN_BEDROCK: 'f',
    CODEX_API_KEY: 'g',
    CODEX_ACCESS_TOKEN: 'h',
    GEMINI_API_KEY: 'i',
    GOOGLE_API_KEY: 'j',
    GOOGLE_GENAI_USE_VERTEXAI: 'true',
    CLOUD_ML_REGION: 'us-east5',
  }
  const workTools: NodeJS.ProcessEnv = {
    AWS_ACCESS_KEY_ID: 'k',
    AWS_SECRET_ACCESS_KEY: 'l',
    AWS_SESSION_TOKEN: 'm',
    AWS_PROFILE: 'n',
    GITHUB_TOKEN: 'o',
    NPM_TOKEN: 'p',
    AZURE_CLIENT_SECRET: 'q',
    GOOGLE_APPLICATION_CREDENTIALS: '/k.json',
    DB_PASSWORD: 'r',
    PATH: '/usr/bin',
  }
  const base = { ...agentAccount, ...workTools, CLAUDE_CONFIG_DIR: '/inherited', CODEX_HOME: '/inherited', DEN_PROFILE: 'other' }
  for (const harness of ['claude', 'codex', 'all'] as const) {
    const env = envFor(work, harness, base)
    for (const key of Object.keys(agentAccount)) assert.equal(env[key], undefined, `${harness} ${key}`)
    for (const [key, value] of Object.entries(workTools)) assert.equal(env[key], value, `${harness} ${key}`)
    assert.equal(env[PROFILE_ENV], 'work')
  }
  for (const harness of ['gemini', 'opencode', 'antigravity'] as const) {
    const env = envFor(work, harness, base)
    for (const [key, value] of Object.entries({ ...agentAccount, ...workTools })) assert.equal(env[key], value, `${harness} ${key}`)
    assert.equal(env['CLAUDE_CONFIG_DIR'], undefined)
    assert.equal(env['CODEX_HOME'], undefined)
    assert.equal(env[PROFILE_ENV], 'work')
  }
  assert.deepEqual(envFor(builtin, 'claude', base)['ANTHROPIC_API_KEY'], 'a')
})

test('profileSupports and profileHome only accept claude and codex', () => {
  assert.equal(profileSupports('claude'), true)
  assert.equal(profileSupports('codex'), true)
  assert.equal(profileSupports('gemini'), false)
  assert.equal(profileHome(work, 'claude'), '/p/work/claude')
  assert.throws(() => profileHome(work, 'opencode'), (error: unknown) => error instanceof ProfileError && error.code === 'PROFILE_UNSUPPORTED_HARNESS')
})

test('paths under home are stored with ~ and expanded on read', async (t) => {
  const ctx = await home(t)
  assert.equal(tildePath(path.join(ctx.home, 'a', 'b'), ctx), '~/a/b')
  assert.equal(tildePath('/elsewhere/x', ctx), '/elsewhere/x')
  assert.equal(expandPath('~/a/b', ctx), path.join(ctx.home, 'a', 'b'))
})

test('a missing profiles.json means a single builtin named default', async (t) => {
  const ctx = await home(t)
  const listed = await listProfiles(ctx)
  assert.deepEqual(listed, { default: 'default', profiles: [{ name: 'default', builtin: true, claude: null, codex: null, createdAt: null }], dirs: [] })
  assert.equal(existsSync(profilesPath(ctx)), false)
  assert.equal((await resolveProfile({ cwd: ctx.home }, ctx)).source, 'default')
})

test('KIT_CONFIG_DIR replaces the whole config root', async (t) => {
  const ctx = await home(t)
  const custom = platformContext({ ...ctx, env: { ...ctx.env, KIT_CONFIG_DIR: path.join(ctx.home, 'custom') } })
  assert.equal(profilesPath(custom), path.join(ctx.home, 'custom', 'profiles.json'))
  assert.equal(profilesPath(ctx), path.join(ctx.home, '.config', 'kikedealba', 'profiles.json'))
})

test('addProfile registers once, creates private dirs and stores ~ paths with mode 0600', { skip: posixOnly }, async (t) => {
  const ctx = await home(t)
  const first = await addProfile('work', ctx)
  assert.equal(first.created, true)
  const homes = profileHomes('work', ctx)
  assert.equal(first.profile.claude, homes.claude)
  for (const dir of [homes.root, homes.claude, homes.codex]) assert.equal(statSync(dir).mode & 0o777, 0o700, dir)
  assert.equal(statSync(profilesPath(ctx)).mode & 0o777, 0o600)
  const stored = JSON.parse(await readFile(profilesPath(ctx), 'utf8')) as Record<string, unknown>
  assert.equal(stored['version'], 1)
  assert.equal(stored['default'], 'default')
  assert.deepEqual((stored['profiles'] as Record<string, unknown>)['default'], { builtin: true })
  const entry = (stored['profiles'] as Record<string, Record<string, unknown>>)['work']
  assert.equal(entry?.['claude'], '~/.config/kikedealba/profiles/work/claude')
  assert.equal(entry?.['codex'], '~/.config/kikedealba/profiles/work/codex')

  const second = await addProfile('work', ctx)
  assert.equal(second.created, false)
  assert.deepEqual(second.profile, first.profile)
  await assert.rejects(addProfile('Bad_Name', ctx), (error: unknown) => error instanceof ProfileError && error.code === 'PROFILE_INVALID_NAME')
})

test('removeProfile refuses the builtin and the default, unmaps dirs and purges on request', async (t) => {
  const ctx = await home(t)
  await addProfile('work', ctx)
  const repo = path.join(ctx.home, 'repo')
  await mkdir(repo)
  await mapDir(repo, 'work', ctx)
  await assert.rejects(removeProfile('default', {}, ctx), (error: unknown) => error instanceof ProfileError && error.code === 'PROFILE_BUILTIN')
  await setDefaultProfile('work', ctx)
  await assert.rejects(removeProfile('work', {}, ctx), (error: unknown) => error instanceof ProfileError && error.code === 'PROFILE_IS_DEFAULT')
  await setDefaultProfile('default', ctx)
  const removed = await removeProfile('work', { purge: true }, ctx)
  assert.deepEqual(removed, { removed: true, purged: true, unmapped: [repo], logoutRequired: ctx.platform === 'darwin' })
  assert.equal(existsSync(profileHomes('work', ctx).root), false)
  assert.deepEqual((await listProfiles(ctx)).dirs, [])
  await assert.rejects(removeProfile('work', {}, ctx), (error: unknown) => error instanceof ProfileError && error.code === 'PROFILE_NOT_FOUND')
})

test('logoutRequired is only reported on macOS, where the Keychain keeps the login', async (t) => {
  for (const platform of ['darwin', 'linux'] as const) {
    const base = await home(t)
    const ctx = platformContext({ platform, home: base.home, env: base.env })
    await addProfile('work', ctx)
    assert.equal((await removeProfile('work', { purge: true }, ctx)).logoutRequired, platform === 'darwin', platform)
  }
})

test('removeProfile keeps the directory without purge', async (t) => {
  const ctx = await home(t)
  await addProfile('work', ctx)
  assert.deepEqual(await removeProfile('work', {}, ctx), { removed: true, purged: false, unmapped: [], logoutRequired: false })
  assert.equal(existsSync(profileHomes('work', ctx).claude), true)
})

test('renameBuiltinProfile renames the builtin and follows default and dirs', async (t) => {
  const ctx = await home(t)
  await mapDir(ctx.home, 'default', ctx)
  const renamed = await renameBuiltinProfile('personal', ctx)
  assert.equal(renamed.name, 'personal')
  const listed = await listProfiles(ctx)
  assert.equal(listed.default, 'personal')
  assert.deepEqual(listed.profiles.map((profile) => profile.name), ['personal'])
  assert.equal(listed.dirs[0]?.profile, 'personal')
  await addProfile('work', ctx)
  await assert.rejects(renameBuiltinProfile('work', ctx), (error: unknown) => error instanceof ProfileError && error.code === 'PROFILE_INVALID_NAME')
})

test('resolveProfile goes explicit, then DEN_PROFILE, then the longest mapped dir, then default', { skip: posixOnly }, async (t) => {
  const ctx = await home(t)
  await addProfile('work', ctx)
  await addProfile('client', ctx)
  const company = path.join(ctx.home, 'dev', 'company')
  const nested = path.join(company, 'client-repo')
  const sibling = path.join(ctx.home, 'dev', 'company-other')
  for (const dir of [nested, sibling]) await mkdir(dir, { recursive: true })
  await mapDir(company, 'work', ctx)
  await mapDir(nested, 'client', ctx)
  const link = path.join(ctx.home, 'shortcut')
  await symlink(nested, link)

  assert.deepEqual(await resolveProfile({ cwd: nested, explicit: 'default' }, ctx).then((r) => [r.profile.name, r.source]), ['default', 'explicit'])
  const withEnv = platformContext({ ...ctx, env: { ...ctx.env, DEN_PROFILE: 'work' } })
  assert.deepEqual(await resolveProfile({ cwd: nested }, withEnv).then((r) => [r.profile.name, r.source]), ['work', 'env'])
  assert.deepEqual(await resolveProfile({ cwd: path.join(nested, 'src') }, ctx).then((r) => [r.profile.name, r.source]), ['client', 'dir'])
  assert.deepEqual(await resolveProfile({ cwd: link }, ctx).then((r) => [r.profile.name, r.source]), ['client', 'dir'])
  assert.deepEqual(await resolveProfile({ cwd: company }, ctx).then((r) => [r.profile.name, r.source]), ['work', 'dir'])
  assert.deepEqual(await resolveProfile({ cwd: sibling }, ctx).then((r) => [r.profile.name, r.source]), ['default', 'default'])

  await assert.rejects(resolveProfile({ explicit: 'ghost' }, ctx), (error: unknown) => error instanceof ProfileError && error.code === 'PROFILE_NOT_FOUND')
  const ghostEnv = platformContext({ ...ctx, env: { ...ctx.env, DEN_PROFILE: 'ghost' } })
  await assert.rejects(resolveProfile({ cwd: nested }, ghostEnv), (error: unknown) => error instanceof ProfileError && error.code === 'PROFILE_NOT_FOUND')
})

test('mapDir stores the realpath, replaces an earlier mapping and unmapDir removes it', { skip: posixOnly }, async (t) => {
  const ctx = await home(t)
  await addProfile('work', ctx)
  const real = path.join(ctx.home, 'real')
  await mkdir(real)
  const link = path.join(ctx.home, 'link')
  await symlink(real, link)
  assert.deepEqual(await mapDir(link, 'default', ctx), { path: real, profile: 'default' })
  await mapDir(real, 'work', ctx)
  assert.deepEqual((await listProfiles(ctx)).dirs, [{ path: real, profile: 'work' }])
  const stored = JSON.parse(await readFile(profilesPath(ctx), 'utf8')) as { dirs: { path: string }[] }
  assert.equal(stored.dirs[0]?.path, '~/real')
  await assert.rejects(mapDir(real, 'ghost', ctx), (error: unknown) => error instanceof ProfileError && error.code === 'PROFILE_NOT_FOUND')
  assert.equal(await unmapDir(link, ctx), true)
  assert.equal(await unmapDir(link, ctx), false)
})

test('an invalid profiles.json fails with PROFILES_INVALID', async (t) => {
  const ctx = await home(t)
  await mkdir(path.dirname(profilesPath(ctx)), { recursive: true })
  const cases: unknown[] = [
    'not json',
    { version: 2, default: 'a', profiles: { a: { builtin: true } } },
    { version: 1, default: 'a', profiles: { a: { builtin: true }, b: { builtin: true } } },
    { version: 1, default: 'x', profiles: { a: { builtin: true } } },
    { version: 1, default: 'a', profiles: { a: { builtin: true, claude: '/x' } } },
    { version: 1, default: 'a', profiles: { a: { builtin: true }, b: { claude: '/x' } } },
    { version: 1, default: 'a', profiles: { a: { builtin: true } }, dirs: [{ path: '/x', profile: 'ghost' }] },
    { version: 1, default: 'A', profiles: { A: { builtin: true } } },
  ]
  for (const value of cases) {
    await writeFile(profilesPath(ctx), typeof value === 'string' ? value : JSON.stringify(value))
    await assert.rejects(listProfiles(ctx), (error: unknown) => error instanceof ProfileError && error.code === 'PROFILES_INVALID', JSON.stringify(value))
  }
})

test('shared links are created, detected when replaced and repaired with a backup instead of a merge', { skip: posixOnly }, async (t) => {
  const ctx = await home(t)
  await addProfile('work', ctx)
  const shared = path.join(ctx.home, '.claude')
  await mkdir(path.join(shared, 'skills', 'kept'), { recursive: true })
  await writeFile(path.join(shared, 'settings.json'), JSON.stringify({ model: 'opus' }))

  const before = await inspectSharedLinks('work', ctx)
  assert.deepEqual(before.map((link) => `${link.harness}/${link.name}:${link.strategy}`), [
    'claude/CLAUDE.md:link',
    'claude/skills:link',
    'claude/agents:link',
    'claude/commands:link',
    'codex/AGENTS.md:link',
    'claude/settings.json:copy',
  ])
  assert.ok(before.every((link) => link.state === 'missing'))

  const first = await repairSharedLinks('work', ctx)
  assert.ok(first.every((link) => link.state === (link.strategy === 'copy' ? 'generated' : 'linked') && link.backup === null), JSON.stringify(first))
  const profile = await getProfile('work', ctx)
  const claudeHome = profile.claude as string
  const settings = path.join(claudeHome, 'settings.json')
  assert.equal(lstatSync(settings).isFile(), true)
  assert.deepEqual(JSON.parse(await readFile(settings, 'utf8')), { model: 'opus' })
  assert.equal(statSync(settings).mode & 0o777, 0o600)
  assert.equal(existsSync(path.join(claudeHome, '.den-shared.json')), true)
  assert.equal(existsSync(path.join(shared, 'CLAUDE.md')), true)
  assert.equal(existsSync(path.join(ctx.home, '.codex', 'AGENTS.md')), true)
  assert.equal(existsSync(path.join(profile.codex as string, 'config.toml')), false)
  assert.equal(existsSync(path.join(ctx.home, '.codex', 'config.toml')), false)

  await writeFile(`${settings}.tmp`, JSON.stringify({ model: 'sonnet', theme: 'dark' }))
  await rename(`${settings}.tmp`, settings)
  const other = path.join(ctx.home, 'other.md')
  await writeFile(other, 'x')
  await rm(path.join(claudeHome, 'CLAUDE.md'))
  await symlink(other, path.join(claudeHome, 'CLAUDE.md'))

  const inspected = Object.fromEntries((await inspectSharedLinks('work', ctx)).map((link) => [link.name, link.state]))
  assert.deepEqual(inspected, { 'CLAUDE.md': 'foreign', 'settings.json': 'drifted', skills: 'linked', agents: 'linked', commands: 'linked', 'AGENTS.md': 'linked' })

  const repaired = Object.fromEntries((await repairSharedLinks('work', ctx)).map((link) => [link.name, link]))
  assert.ok(Object.values(repaired).every((link) => link.state === 'linked' || link.state === 'generated'))
  assert.equal(repaired['settings.json']?.previous, 'drifted')
  assert.ok(repaired['settings.json']?.backup?.startsWith(`${settings}.backup-`))
  assert.deepEqual(JSON.parse(await readFile(path.join(shared, 'settings.json'), 'utf8')), { model: 'opus' })
  assert.deepEqual(JSON.parse(await readFile(settings, 'utf8')), { model: 'opus' })
  assert.deepEqual(JSON.parse(await readFile(repaired['settings.json']?.backup as string, 'utf8')), { model: 'sonnet', theme: 'dark' })
  assert.equal(repaired['CLAUDE.md']?.previous, 'foreign')
  assert.equal(repaired['CLAUDE.md']?.backup, null)
  assert.equal(await readFile(other, 'utf8'), 'x')
  assert.ok(lstatSync(path.join(claudeHome, 'CLAUDE.md')).isSymbolicLink())
})

test('the builtin profile has no shared links', async (t) => {
  const ctx = await home(t)
  assert.deepEqual(await inspectSharedLinks('default', ctx), [])
  assert.deepEqual(await repairSharedLinks('default', ctx), [])
})

test('authStatus runs claude auth status with the profile home and reads logged out answers too', { skip: posixOnly }, async (t) => {
  const ctx = await home(t, { ANTHROPIC_API_KEY: 'leak', CLAUDE_CONFIG_DIR: '/inherited' })
  const bin = await fakeTool(ctx.home, 'claude', `#!${process.execPath}
const dir = process.env.CLAUDE_CONFIG_DIR ?? null
const loggedIn = dir !== null && !dir.endsWith('logged-out')
process.stdout.write(JSON.stringify({ loggedIn, authMethod: loggedIn ? 'claude.ai' : 'none', email: loggedIn ? 'a@b.c' : undefined, orgName: loggedIn ? 'Org' : undefined, subscriptionType: loggedIn ? 'max' : undefined, configDirectory: dir, leaked: process.env.ANTHROPIC_API_KEY ?? null, argv: process.argv.slice(2) }))
process.exitCode = loggedIn ? 0 : 1
`)
  const status = await authStatus(work, { ctx, bin })
  assert.deepEqual(status, { loggedIn: true, authMethod: 'claude.ai', email: 'a@b.c', orgName: 'Org', subscriptionType: 'max', configDirectory: '/p/work/claude' })
  const loggedOut = await authStatus({ ...work, claude: '/p/logged-out' }, { ctx, bin })
  assert.deepEqual(loggedOut, { loggedIn: false, authMethod: 'none', email: null, orgName: null, subscriptionType: null, configDirectory: '/p/logged-out' })
  const builtinStatus = await authStatus(builtin, { ctx, bin })
  assert.equal(builtinStatus?.configDirectory, null)
  assert.equal(await authStatus(work, { ctx: platformContext({ ...ctx, env: { PATH: '' } }), bin: path.join(ctx.home, 'missing') }), null)
})
