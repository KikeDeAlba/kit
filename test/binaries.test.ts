import assert from 'node:assert/strict'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { agentHomes, agentSearchDirs, detectAgents, findAgentBinary, findAgentBinarySync, toolchainSearchDirs } from '../src/agents/index.ts'
import { platformContext } from '../src/platform.ts'
import { sandbox, tempDir } from './helpers.ts'

async function executable(file: string): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, '#!/bin/sh\n')
  await chmod(file, 0o755)
  return file
}

test('toolchain directories cover the node version managers on unix', async (t) => {
  const home = await tempDir(t)
  for (const version of ['v9.11.2', 'v22.3.0', 'v20.1.0', 'not-a-version']) await mkdir(path.join(home, '.nvm', 'versions', 'node', version, 'bin'), { recursive: true })
  const ctx = platformContext({ platform: 'linux', home, env: { NVM_BIN: '/nvm/current/bin', VOLTA_HOME: '/volta', NPM_CONFIG_PREFIX: '/prefix', BUN_INSTALL: '/bun' } })
  const dirs = toolchainSearchDirs(ctx)
  const nvm = (version: string) => path.join(home, '.nvm', 'versions', 'node', version, 'bin')
  assert.deepEqual(dirs.slice(0, 4), ['/nvm/current/bin', nvm('v22.3.0'), nvm('v20.1.0'), nvm('v9.11.2')])
  for (const dir of [
    path.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
    '/volta/bin',
    '/prefix/bin',
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.local', 'share', 'pnpm'),
    '/bun/bin',
    path.join(home, '.local', 'bin'),
  ]) {
    assert.ok(dirs.includes(dir), dir)
  }
  assert.ok(toolchainSearchDirs(platformContext({ platform: 'darwin', home, env: {} })).includes(path.join(home, 'Library', 'pnpm')))
})

test('toolchain directories follow the Windows layout', () => {
  const ctx = platformContext({
    platform: 'win32',
    home: 'C:\\Users\\a',
    env: { APPDATA: 'C:\\Users\\a\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local', NVM_SYMLINK: 'C:\\nvm4w\\nodejs' },
  })
  const dirs = toolchainSearchDirs(ctx)
  for (const dir of [
    'C:\\nvm4w\\nodejs',
    'C:\\Users\\a\\AppData\\Local\\fnm\\aliases\\default',
    'C:\\Users\\a\\AppData\\Local\\pnpm',
    'C:\\Users\\a\\AppData\\Roaming\\npm',
    'C:\\Users\\a\\AppData\\Local\\Volta\\bin',
  ]) {
    assert.ok(dirs.includes(dir), dir)
  }
  assert.ok(!dirs.some((dir) => dir.includes('/')))
  assert.deepEqual(agentSearchDirs('antigravity', ctx), ['C:\\Users\\a\\.gemini\\antigravity-cli\\bin'])
})

test('findAgentBinary walks PATH, then the toolchain, then agent-specific directories', { skip: process.platform === 'win32' }, async (t) => {
  const home = await tempDir(t)
  const ctx = sandbox(home, { PATH: path.join(home, 'path-bin') })
  const older = await executable(path.join(home, '.nvm', 'versions', 'node', 'v20.1.0', 'bin', 'gemini'))
  const newer = await executable(path.join(home, '.nvm', 'versions', 'node', 'v22.3.0', 'bin', 'gemini'))
  assert.notEqual(older, newer)
  assert.equal(await findAgentBinary('gemini', { ctx }), newer)
  assert.equal(findAgentBinarySync('gemini', { ctx }), newer)

  const onPath = await executable(path.join(home, 'path-bin', 'gemini'))
  assert.equal(await findAgentBinary('gemini', { ctx }), onPath)

  const agy = await executable(path.join(home, '.gemini', 'antigravity-cli', 'bin', 'agy'))
  assert.equal(await findAgentBinary('antigravity', { ctx }), agy)
  assert.equal(findAgentBinarySync('antigravity', { ctx }), agy)
  const claude = await executable(path.join(home, '.claude', 'local', 'claude'))
  assert.equal(await findAgentBinary('claude', { ctx }), claude)

  const override = await executable(path.join(home, 'custom', 'my-gemini'))
  assert.equal(await findAgentBinary('gemini', { ctx, override }), override)
  assert.equal(findAgentBinarySync('gemini', { ctx, override }), override)
  assert.equal(await findAgentBinary('gemini', { ctx, override: path.join(home, 'nope') }), null)
  assert.equal(findAgentBinarySync('gemini', { ctx, override: path.join(home, 'nope') }), null)
  assert.equal(await findAgentBinary('nope' as never, { ctx }), null)
  assert.equal(await findAgentBinary('claude-desktop', { ctx }), null)
})

test('detectAgents finds harnesses installed outside PATH', { skip: process.platform === 'win32' }, async (t) => {
  const home = await tempDir(t)
  const ctx = sandbox(home, { PATH: '' })
  await executable(path.join(home, '.gemini', 'antigravity-cli', 'bin', 'agy'))
  await executable(path.join(home, '.nvm', 'versions', 'node', 'v24.0.0', 'bin', 'gemini'))
  const found = await detectAgents(ctx, agentHomes(ctx))
  assert.ok(found.includes('antigravity'))
  assert.ok(found.includes('gemini'))
})
