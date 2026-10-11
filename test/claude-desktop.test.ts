import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { agentHomes, detectAgents, installIntegration, uninstallIntegration, type AgentIntegration } from '../src/agents/index.ts'
import { platformContext } from '../src/platform.ts'
import { tempDir } from './helpers.ts'

function desktopContext(home: string, platform: 'darwin' | 'win32' | 'linux' = 'darwin') {
  return platformContext({ platform, home, env: { PATH: '/usr/bin', APPDATA: path.join(home, 'AppData', 'Roaming') } })
}

const INTEGRATION: AgentIntegration = {
  tool: 'demo',
  version: '1.0.0',
  mcp: [{ name: 'demo-cli', command: ['demo', 'mcp'] }],
  claudeDesktop: {
    mcp: [
      { name: 'demo', command: ['/opt/bin/demo', 'mcp'] },
      { name: 'demo-http', url: 'http://127.0.0.1:7781/mcp', headers: { Authorization: 'Bearer x' } },
    ],
  },
}

test('claude desktop config lives in Application Support on macOS, APPDATA on Windows and nowhere on Linux', () => {
  assert.equal(agentHomes(desktopContext('/Users/a')).claudeDesktop, '/Users/a/Library/Application Support/Claude')
  const win = platformContext({ platform: 'win32', home: 'C:\\Users\\a', env: { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' } })
  assert.equal(agentHomes(win).claudeDesktop, 'C:\\Users\\a\\AppData\\Roaming\\Claude')
  assert.equal(agentHomes(desktopContext('/home/a', 'linux')).claudeDesktop, null)
})

test('claude desktop is detected only when its app support dir exists', async (t) => {
  const home = await tempDir(t)
  const ctx = desktopContext(home)
  assert.ok(!(await detectAgents(ctx, agentHomes(ctx), async () => null)).includes('claude-desktop'))
  await mkdir(path.join(home, 'Library', 'Application Support', 'Claude'), { recursive: true })
  assert.ok((await detectAgents(ctx, agentHomes(ctx), async () => null)).includes('claude-desktop'))
})

test('claude desktop install merges mcpServers, keeps preferences and uninstalls only its entries', async (t) => {
  const home = await tempDir(t)
  const ctx = desktopContext(home)
  const dir = path.join(home, 'Library', 'Application Support', 'Claude')
  const file = path.join(dir, 'claude_desktop_config.json')
  await mkdir(dir, { recursive: true })
  await writeFile(file, JSON.stringify({ preferences: { menuBarEnabled: true }, mcpServers: { other: { command: 'other' } } }))

  const steps = await installIntegration(INTEGRATION, { agents: ['claude-desktop'], ctx, locate: async () => null })
  assert.deepEqual(steps.map((step) => [step.agent, step.item, step.state]), [['claude-desktop', 'mcp demo, demo-http', 'installed']])
  const config = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(config.preferences, { menuBarEnabled: true })
  assert.deepEqual(config.mcpServers.other, { command: 'other' })
  assert.equal(config.mcpServers['demo-cli'], undefined)
  assert.equal(config.mcpServers.demo.command, '/opt/bin/demo')
  assert.deepEqual(config.mcpServers.demo.args, ['mcp'])
  assert.deepEqual(Object.keys(config.mcpServers.demo.env), ['PATH'])
  assert.ok(config.mcpServers.demo.env.PATH.split(path.delimiter).includes(path.dirname(process.execPath)))
  assert.deepEqual(config.mcpServers['demo-http'], { type: 'http', url: 'http://127.0.0.1:7781/mcp', headers: { Authorization: 'Bearer x' } })

  const again = await installIntegration(INTEGRATION, { agents: ['claude-desktop'], ctx, locate: async () => null })
  assert.equal(again[0]?.state, 'present')

  const removed = await uninstallIntegration(INTEGRATION, { agents: ['claude-desktop'], ctx, locate: async () => null })
  assert.equal(removed[0]?.state, 'removed')
  const cleaned = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(cleaned, { preferences: { menuBarEnabled: true }, mcpServers: { other: { command: 'other' } } })
})

test('claude desktop config is created only when the app dir exists', async (t) => {
  const home = await tempDir(t)
  const ctx = desktopContext(home)
  const dir = path.join(home, 'Library', 'Application Support', 'Claude')
  const missing = await installIntegration(INTEGRATION, { agents: ['claude-desktop'], ctx, locate: async () => null })
  assert.equal(missing[0]?.state, 'unavailable')
  assert.ok(!existsSync(dir))
  await mkdir(dir, { recursive: true })
  const created = await installIntegration(INTEGRATION, { agents: ['claude-desktop'], ctx, locate: async () => null })
  assert.equal(created[0]?.state, 'installed')
  assert.ok(JSON.parse(await readFile(path.join(dir, 'claude_desktop_config.json'), 'utf8')).mcpServers.demo)
})

test('claude desktop is unavailable on linux', async (t) => {
  const home = await tempDir(t)
  const steps = await installIntegration(INTEGRATION, { agents: ['claude-desktop'], ctx: desktopContext(home, 'linux'), locate: async () => null })
  assert.equal(steps[0]?.state, 'unavailable')
})

test('tools without claudeDesktop skip it and generic mcp never reaches it', async (t) => {
  const home = await tempDir(t)
  const ctx = desktopContext(home)
  const dir = path.join(home, 'Library', 'Application Support', 'Claude')
  await mkdir(dir, { recursive: true })
  const { claudeDesktop: _unused, ...cliOnly } = INTEGRATION
  const steps = await installIntegration(cliOnly, { agents: 'detected', ctx, locate: async () => null })
  assert.deepEqual(steps.map((step) => [step.agent, step.state]), [['claude-desktop', 'skipped']])
  assert.ok(!existsSync(path.join(dir, 'claude_desktop_config.json')))
  const all = await installIntegration(cliOnly, { agents: 'all', ctx, homes: { claude: path.join(home, '.claude') }, locate: async () => null })
  assert.ok(all.some((step) => step.agent === 'claude-desktop' && step.state === 'skipped'))
  assert.ok(!all.some((step) => step.agent === 'claude-desktop' && step.state === 'failed'))
})
