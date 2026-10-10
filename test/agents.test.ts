import assert from 'node:assert/strict'
import { existsSync, lstatSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { installIntegration, uninstallIntegration, type AgentIntegration } from '../src/agents/index.ts'
import { commandToGeminiToml, parseFrontmatter, renderForAgent } from '../src/agents/markdown.ts'
import { mergeHooks, removeTomlTable, stripHooks } from '../src/agents/files.ts'
import { sandbox, tempDir } from './helpers.ts'

const SKILL = `---
name: demo
description: Demo skill
---

# Demo

Shared text.

::: agent codex opencode
Only for codex and opencode.
:::

::: agent !gemini
Everyone but gemini.
:::
`

const COMMAND = `---
description: Start the demo
allowed-tools: Bash(demo:*)
---

Run demo with $ARGUMENTS.
`

async function fixture(root: string): Promise<AgentIntegration> {
  const skillDir = path.join(root, 'pkg', 'skill')
  await mkdir(skillDir, { recursive: true })
  await writeFile(path.join(skillDir, 'SKILL.md'), SKILL)
  const commands = path.join(root, 'pkg', 'commands')
  await mkdir(commands, { recursive: true })
  await writeFile(path.join(commands, 'demo-start.md'), COMMAND)
  await writeFile(path.join(root, 'pkg', 'plugin.ts'), 'export default {}\n')
  return {
    tool: 'demo',
    version: '1.0.0',
    description: 'Demo tool',
    skills: [{ name: 'demo', dir: skillDir }],
    commands: [{ name: 'demo-start', file: path.join(commands, 'demo-start.md') }],
    mcp: [{ name: 'demo', command: ['demo', 'mcp'] }, { name: 'demo-http', url: 'http://127.0.0.1:7781/mcp' }],
    claude: {
      permissions: { allow: ['Bash(demo:*)'], ask: ['Bash(demo rm:*)'] },
      hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'demo hook session-start', timeout: 5 }] }] },
    },
    opencode: { plugins: [{ name: 'demo', file: path.join(root, 'pkg', 'plugin.ts') }] },
    codex: { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'demo hook codex', timeout: 5 }] }] } },
    gemini: { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'demo hook gemini', timeout: 5000 }] }] }, contextFile: path.join(skillDir, 'SKILL.md') },
  }
}

test('agent blocks render per agent', () => {
  const codex = renderForAgent(SKILL, 'codex')
  assert.match(codex, /Only for codex/)
  assert.match(codex, /Everyone but gemini/)
  const gemini = renderForAgent(SKILL, 'gemini')
  assert.doesNotMatch(gemini, /Only for codex/)
  assert.doesNotMatch(gemini, /Everyone but gemini/)
  assert.doesNotMatch(gemini, /:::/)
  const claude = renderForAgent(SKILL, 'claude')
  assert.doesNotMatch(claude, /Only for codex/)
  assert.match(claude, /Everyone but gemini/)
})

test('markdown commands become Gemini TOML', () => {
  const toml = commandToGeminiToml(COMMAND)
  assert.match(toml, /^description = "Start the demo"/)
  assert.match(toml, /\{\{args\}\}/)
  assert.doesNotMatch(toml, /allowed-tools/)
  assert.equal(parseFrontmatter(COMMAND).attributes['allowed-tools'], 'Bash(demo:*)')
})

test('hooks merge without duplicates and strip only what is owned', () => {
  const wanted = { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command' as const, command: 'demo touched' }] }] }
  const existing = { PostToolUse: [{ hooks: [{ type: 'command', command: 'other' }] }] }
  const once = mergeHooks(existing, wanted)
  assert.equal(once.added.length, 1)
  const twice = mergeHooks(once.hooks, wanted)
  assert.equal(twice.added.length, 0)
  assert.equal(twice.hooks['PostToolUse']?.length, 2)
  const stripped = stripHooks(twice.hooks, wanted)
  assert.equal(stripped.removed, 1)
  assert.equal(stripped.hooks['PostToolUse']?.length, 1)
})

test('toml tables are removed with their subtables', () => {
  const text = 'model = "x"\n\n[mcp_servers.demo]\ncommand = "demo"\n\n[mcp_servers.demo.env]\nA = "1"\n\n[mcp_servers.other]\nurl = "u"\n'
  const result = removeTomlTable(text, 'mcp_servers.demo')
  assert.equal(result.removed, true)
  assert.doesNotMatch(result.text, /demo/)
  assert.match(result.text, /mcp_servers\.other/)
})

test('installs into all four agents and uninstalls cleanly', async (t) => {
  const home = await tempDir(t)
  const ctx = sandbox(home, { PATH: '' })
  const integration = await fixture(home)
  const homes = {
    claude: path.join(home, '.claude'),
    opencode: path.join(home, '.config', 'opencode'),
    codex: path.join(home, '.codex'),
    agentsSkills: path.join(home, '.agents', 'skills'),
    gemini: path.join(home, '.gemini'),
  }
  await mkdir(homes.claude, { recursive: true })
  await writeFile(path.join(homes.claude, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, theme: 'dark' }))
  await mkdir(homes.codex, { recursive: true })
  await writeFile(path.join(homes.codex, 'config.toml'), 'model = "gpt"\n')

  const steps = await installIntegration(integration, { agents: 'all', ctx, homes, locate: async () => null })
  const failed = steps.filter((step) => step.state === 'failed')
  assert.deepEqual(failed, [])

  assert.ok(lstatSync(path.join(homes.claude, 'skills', 'demo')).isSymbolicLink())
  const claudeSkill = await readFile(path.join(homes.claude, 'skills', 'demo', 'SKILL.md'), 'utf8')
  assert.doesNotMatch(claudeSkill, /Only for codex/)
  assert.ok(existsSync(path.join(homes.claude, 'commands', 'demo-start.md')))
  const settings = JSON.parse(await readFile(path.join(homes.claude, 'settings.json'), 'utf8'))
  assert.equal(settings.theme, 'dark')
  assert.deepEqual(settings.permissions.allow, ['Bash(ls:*)', 'Bash(demo:*)'])
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, 'demo hook session-start')
  assert.ok(steps.some((step) => step.agent === 'claude' && step.item === 'mcp demo' && step.state === 'unavailable'))

  const opencode = JSON.parse(await readFile(path.join(homes.opencode, 'opencode.json'), 'utf8'))
  assert.deepEqual(opencode.mcp.demo, { type: 'local', command: ['demo', 'mcp'], enabled: true })
  assert.equal(opencode.mcp['demo-http'].type, 'remote')
  assert.ok(existsSync(path.join(homes.opencode, 'plugins', 'demo.ts')))
  assert.match(await readFile(path.join(homes.opencode, 'skills', 'demo', 'SKILL.md'), 'utf8'), /Only for codex/)

  const toml = await readFile(path.join(homes.codex, 'config.toml'), 'utf8')
  assert.match(toml, /^model = "gpt"/)
  assert.match(toml, /\[mcp_servers\.demo\]\ncommand = "demo"\nargs = \["mcp"\]/)
  assert.match(toml, /\[mcp_servers\.demo-http\]\nurl = "http:\/\/127\.0\.0\.1:7781\/mcp"/)
  assert.ok(existsSync(path.join(homes.agentsSkills, 'demo', 'SKILL.md')))
  assert.ok(existsSync(path.join(homes.codex, 'prompts', 'demo-start.md')))
  assert.doesNotMatch(await readFile(path.join(homes.codex, 'prompts', 'demo-start.md'), 'utf8'), /allowed-tools/)
  const codexHooks = JSON.parse(await readFile(path.join(homes.codex, 'hooks.json'), 'utf8'))
  assert.equal(codexHooks.hooks.SessionStart[0].hooks[0].command, 'demo hook codex')

  const extension = path.join(homes.gemini, 'extensions', 'demo')
  const manifest = JSON.parse(await readFile(path.join(extension, 'gemini-extension.json'), 'utf8'))
  assert.equal(manifest.name, 'demo')
  assert.equal(manifest.contextFileName, 'GEMINI.md')
  assert.deepEqual(manifest.mcpServers.demo, { command: 'demo', args: ['mcp'] })
  assert.deepEqual(manifest.mcpServers['demo-http'], { httpUrl: 'http://127.0.0.1:7781/mcp' })
  assert.match(await readFile(path.join(extension, 'commands', 'demo-start.toml'), 'utf8'), /\{\{args\}\}/)
  assert.doesNotMatch(await readFile(path.join(extension, 'GEMINI.md'), 'utf8'), /Everyone but gemini/)
  assert.ok(existsSync(path.join(extension, 'skills', 'demo', 'SKILL.md')))
  assert.ok(existsSync(path.join(extension, 'hooks', 'hooks.json')))

  const again = await installIntegration(integration, { agents: 'all', ctx, homes })
  assert.deepEqual(again.filter((step) => step.state === 'failed'), [])
  const tomlAgain = await readFile(path.join(homes.codex, 'config.toml'), 'utf8')
  assert.equal(tomlAgain.match(/\[mcp_servers\.demo\]/g)?.length, 1)
  const settingsAgain = JSON.parse(await readFile(path.join(homes.claude, 'settings.json'), 'utf8'))
  assert.equal(settingsAgain.hooks.SessionStart.length, 1)

  await uninstallIntegration(integration, { agents: 'all', ctx, homes })
  assert.ok(!existsSync(path.join(homes.claude, 'skills', 'demo')))
  assert.ok(!existsSync(path.join(homes.claude, 'commands', 'demo-start.md')))
  const cleaned = JSON.parse(await readFile(path.join(homes.claude, 'settings.json'), 'utf8'))
  assert.deepEqual(cleaned.permissions.allow, ['Bash(ls:*)'])
  assert.equal(cleaned.hooks.SessionStart, undefined)
  assert.equal(JSON.parse(await readFile(path.join(homes.opencode, 'opencode.json'), 'utf8')).mcp.demo, undefined)
  assert.doesNotMatch(await readFile(path.join(homes.codex, 'config.toml'), 'utf8'), /mcp_servers\.demo/)
  assert.ok(!existsSync(extension))
})

test('detected mode only installs into agents that are present', async (t) => {
  const home = await tempDir(t)
  const ctx = sandbox(home, { PATH: '' })
  const integration = await fixture(home)
  const homes = {
    claude: path.join(home, '.claude'),
    opencode: path.join(home, '.config', 'opencode'),
    codex: path.join(home, '.codex'),
    agentsSkills: path.join(home, '.agents', 'skills'),
    gemini: path.join(home, '.gemini'),
  }
  await mkdir(homes.gemini, { recursive: true })
  const steps = await installIntegration(integration, { ctx, homes, locate: async () => null })
  assert.deepEqual([...new Set(steps.map((step) => step.agent))], ['gemini'])
  assert.ok(!existsSync(homes.claude))
})

test('opencode.jsonc is edited when it is plain JSON and left alone when it has comments', async (t) => {
  const home = await tempDir(t)
  const ctx = sandbox(home, { PATH: '' })
  const integration = await fixture(home)
  const homes = { opencode: path.join(home, 'opencode') }
  await mkdir(homes.opencode, { recursive: true })
  const file = path.join(homes.opencode, 'opencode.jsonc')
  await writeFile(file, JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { other: { type: 'remote', url: 'https://x' } } }))
  const steps = await installIntegration(integration, { agents: ['opencode'], ctx, homes, locate: async () => null })
  assert.ok(steps.some((step) => step.item.startsWith('mcp') && step.state === 'installed'))
  const edited = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(edited.mcp.other.url, 'https://x')
  assert.deepEqual(edited.mcp.demo.command, ['demo', 'mcp'])
  await writeFile(file, '{\n  // mine\n  "mcp": {}\n}\n')
  const again = await installIntegration(integration, { agents: ['opencode'], ctx, homes, locate: async () => null })
  assert.ok(again.some((step) => step.item.startsWith('mcp') && step.state === 'unavailable'))
  assert.match(await readFile(file, 'utf8'), /\/\/ mine/)
})
