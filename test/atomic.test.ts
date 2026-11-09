import assert from 'node:assert/strict'
import { lstatSync, readdirSync, readlinkSync } from 'node:fs'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { writeJsonFile } from '../src/agents/files.ts'
import { agentHomes, installClaudePlugin } from '../src/agents/index.ts'
import { headlessEnv, HEADLESS_ENV_PREFIXES } from '../src/agents/headless.ts'
import { writeFileAtomic } from '../src/atomic.ts'
import { fileStore } from '../src/credentials.ts'
import { platformContext } from '../src/platform.ts'
import { registerTool, defineManifest } from '../src/registry.ts'
import { fakeTool, sandbox, tempDir } from './helpers.ts'

const posixOnly = process.platform === 'win32' ? 'symlinks need privileges on Windows' : false

test('writeJsonFile writes through a symlink and keeps the link', { skip: posixOnly }, async (t) => {
  const dir = await tempDir(t)
  const shared = path.join(dir, 'shared', 'settings.json')
  await mkdir(path.dirname(shared), { recursive: true })
  await writeFile(shared, '{"a":1}\n')
  const link = path.join(dir, 'profile', 'settings.json')
  await mkdir(path.dirname(link), { recursive: true })
  await symlink(shared, link)
  await writeJsonFile(link, { a: 2 }, true)
  assert.ok(lstatSync(link).isSymbolicLink())
  assert.equal(readlinkSync(link), shared)
  assert.deepEqual(JSON.parse(await readFile(shared, 'utf8')), { a: 2 })
  assert.deepEqual(JSON.parse(await readFile(`${link}.backup`, 'utf8')), { a: 1 })
  assert.deepEqual(readdirSync(path.dirname(shared)).sort(), ['settings.json'])
})

test('writeFileAtomic creates new files and applies the mode', async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, 'nested', 'x.json')
  assert.equal(await writeFileAtomic(file, 'hi', { mode: 0o600 }), file)
  assert.equal(await readFile(file, 'utf8'), 'hi')
  if (process.platform !== 'win32') assert.equal(lstatSync(file).mode & 0o777, 0o600)
})

test('registerTool and the file credential store keep symlinked files linked', { skip: posixOnly }, async (t) => {
  const home = await tempDir(t)
  const ctx = sandbox(home)
  const registry = path.join(home, 'registry')
  const real = path.join(home, 'real-demo.json')
  await mkdir(registry, { recursive: true })
  await writeFile(real, '{}')
  await symlink(real, path.join(registry, 'demo.json'))
  await registerTool(defineManifest({ name: 'demo', version: '1.0.0', bin: ['demo'], capabilities: [] }), ctx)
  assert.ok(lstatSync(path.join(registry, 'demo.json')).isSymbolicLink())
  assert.equal(JSON.parse(await readFile(real, 'utf8')).name, 'demo')

  const secrets = path.join(home, 'secrets.json')
  const realSecrets = path.join(home, 'real-secrets.json')
  await writeFile(realSecrets, '{}')
  await symlink(realSecrets, secrets)
  const store = fileStore(secrets)
  await store.set('svc', 'acct', 'value')
  assert.ok(lstatSync(secrets).isSymbolicLink())
  assert.equal(await store.get('svc', 'acct'), 'value')
})

test('KIT_ANTIGRAVITY_HOME moves the antigravity home and overrides still win', () => {
  const ctx = platformContext({ platform: 'linux', home: '/h', env: { KIT_ANTIGRAVITY_HOME: '/custom/agy' } })
  assert.equal(agentHomes(ctx).antigravity, '/custom/agy')
  assert.equal(agentHomes(ctx, { antigravity: '/x' }).antigravity, '/x')
  assert.equal(agentHomes(platformContext({ platform: 'linux', home: '/h', env: {} })).antigravity, '/h/.gemini/config')
})

test('headless children keep DEN_ variables', () => {
  assert.ok(HEADLESS_ENV_PREFIXES.includes('DEN_'))
  const env = headlessEnv('claude', { PATH: '/bin', DEN_PROFILE: 'work', BITA_WRAPPER_ID: 'x' })
  assert.equal(env['DEN_PROFILE'], 'work')
  assert.equal(env['BITA_WRAPPER_ID'], undefined)
})

test('the default exec runs claude with the environment of the context', { skip: posixOnly }, async (t) => {
  const home = await tempDir(t)
  const log = path.join(home, 'calls.log')
  const bin = await fakeTool(home, 'claude', `#!${process.execPath}
const fs = require('node:fs')
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), dir: process.env.CLAUDE_CONFIG_DIR ?? null }) + '\\n')
if (process.argv[2] === 'plugin' && process.argv[3] === 'list') process.stdout.write('[]')
if (process.argv[2] === 'plugin' && process.argv[3] === 'marketplace' && process.argv[4] === 'list') process.stdout.write('[]')
`.replace("require('node:fs')", "(await import('node:fs')).default"))
  const ctx = platformContext({ home, env: { PATH: process.env['PATH'] ?? '', CLAUDE_CONFIG_DIR: path.join(home, 'profile') } })
  const steps = await installClaudePlugin({ marketplace: 'owner/repo', marketplaceName: 'demo', plugin: 'demo' }, { ctx, locate: async () => bin })
  assert.ok(steps.every((step) => step.state !== 'failed'), JSON.stringify(steps))
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { argv: string[]; dir: string | null })
  assert.ok(calls.length >= 3)
  assert.ok(calls.every((call) => call.dir === path.join(home, 'profile')))
})
