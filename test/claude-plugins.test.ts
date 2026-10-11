import assert from 'node:assert/strict'
import { existsSync, lstatSync } from 'node:fs'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import {
  EDIT_TOOL_MATCHERS,
  installClaudePlugin,
  installIntegration,
  removeLegacyClaude,
  uninstallClaudePlugin,
  uninstallIntegration,
  type AgentIntegration,
  type ClaudePluginSpec,
} from '../src/agents/index.ts'
import { sandbox, tempDir } from './helpers.ts'

const SPEC: ClaudePluginSpec = { marketplace: 'KikeDeAlba/demo', marketplaceName: 'demo', plugin: 'demo' }

interface FakeClaude {
  calls: string[]
  exec: (command: string, args: readonly string[]) => Promise<string | void>
}

function fakeClaude(responses: Record<string, string | Error | undefined>): FakeClaude {
  const calls: string[] = []
  return {
    calls,
    exec: async (command, args) => {
      assert.equal(command, '/bin/claude')
      const line = args.join(' ')
      calls.push(line)
      const key = Object.keys(responses).find((prefix) => line.startsWith(prefix))
      const response = key === undefined ? '' : responses[key]
      if (response instanceof Error) throw response
      return response
    },
  }
}

const locate = async (command: string) => (command === 'claude' ? '/bin/claude' : null)

test('installClaudePlugin adds the marketplace and installs the plugin when it is new', async () => {
  const claude = fakeClaude({ 'plugin marketplace list': '[]', 'plugin list': '[]' })
  const steps = await installClaudePlugin(SPEC, { exec: claude.exec, locate })
  assert.deepEqual(claude.calls, [
    'plugin marketplace list --json',
    'plugin marketplace add KikeDeAlba/demo',
    'plugin marketplace update demo',
    'plugin list --json',
    'plugin install demo@demo --scope user',
  ])
  assert.deepEqual(steps.map((step) => [step.item, step.state]), [
    ['marketplace demo', 'installed'],
    ['plugin demo@demo', 'installed'],
  ])
})

test('installClaudePlugin updates an installed plugin from a known marketplace', async () => {
  const claude = fakeClaude({
    'plugin marketplace list': JSON.stringify([{ name: 'demo', repo: 'KikeDeAlba/demo' }]),
    'plugin list': JSON.stringify([{ id: 'demo@demo', scope: 'user' }]),
  })
  const steps = await installClaudePlugin(SPEC, { exec: claude.exec, locate })
  assert.deepEqual(claude.calls, ['plugin marketplace list --json', 'plugin marketplace update demo', 'plugin list --json', 'plugin update demo@demo --scope user'])
  assert.deepEqual(steps.map((step) => [step.item, step.state]), [
    ['marketplace demo', 'present'],
    ['plugin demo@demo', 'installed'],
  ])
  assert.match(steps[1]?.detail ?? '', /updated/)
})

test('installClaudePlugin falls back to install then update when nothing can be listed', async () => {
  const claude = fakeClaude({
    'plugin marketplace add': Object.assign(new Error('Command failed'), { stderr: "Marketplace 'demo' is already added" }),
    'plugin install': new Error('Plugin demo@demo is already installed'),
  })
  const steps = await installClaudePlugin({ ...SPEC, scope: 'project' }, { exec: async (command, args) => { await claude.exec(command, args) }, locate })
  assert.deepEqual(claude.calls, [
    'plugin marketplace list --json',
    'plugin marketplace add KikeDeAlba/demo --scope project',
    'plugin marketplace update demo',
    'plugin list --json',
    'plugin install demo@demo --scope project',
    'plugin update demo@demo --scope project',
  ])
  assert.deepEqual(steps.map((step) => step.state), ['present', 'installed'])
})

test('installClaudePlugin also updates after a blind install so an old copy cannot linger', async () => {
  const claude = fakeClaude({})
  const steps = await installClaudePlugin(SPEC, { exec: async (command, args) => { await claude.exec(command, args) }, locate })
  assert.deepEqual(claude.calls.slice(-2), ['plugin install demo@demo --scope user', 'plugin update demo@demo --scope user'])
  assert.deepEqual(steps.map((step) => step.state), ['installed', 'installed'])
})

test('installClaudePlugin stops when the marketplace cannot be added', async () => {
  const claude = fakeClaude({ 'plugin marketplace list': '[]', 'plugin marketplace add': new Error('repository not found') })
  const steps = await installClaudePlugin(SPEC, { exec: claude.exec, locate })
  assert.deepEqual(steps.map((step) => [step.item, step.state]), [['marketplace demo', 'failed']])
  assert.ok(!claude.calls.some((call) => call.startsWith('plugin install')))
})

test('installClaudePlugin reports a failed install of a plugin that is not there', async () => {
  const claude = fakeClaude({ 'plugin marketplace list': '[{"name":"demo"}]', 'plugin list': '[]', 'plugin install': new Error('Plugin demo not found in marketplace demo') })
  const steps = await installClaudePlugin(SPEC, { exec: claude.exec, locate })
  assert.equal(steps.at(-1)?.state, 'failed')
  assert.ok(!claude.calls.some((call) => call.startsWith('plugin update')))
})

test('installClaudePlugin without claude prints the manual commands', async () => {
  const steps = await installClaudePlugin(SPEC, { locate: async () => null, exec: async () => assert.fail('must not run') })
  assert.equal(steps.length, 1)
  assert.equal(steps[0]?.state, 'unavailable')
  assert.match(steps[0]?.detail ?? '', /claude plugin marketplace add KikeDeAlba\/demo && claude plugin marketplace update demo && claude plugin install demo@demo --scope user/)
})

test('uninstallClaudePlugin removes an installed plugin and skips a missing one', async () => {
  const installed = fakeClaude({ 'plugin list': '[{"id":"demo@demo","scope":"user"}]' })
  const removed = await uninstallClaudePlugin(SPEC, { exec: installed.exec, locate })
  assert.deepEqual(installed.calls, ['plugin list --json', 'plugin uninstall demo@demo --scope user'])
  assert.equal(removed[0]?.state, 'removed')

  const missing = fakeClaude({ 'plugin list': '[]' })
  const skipped = await uninstallClaudePlugin(SPEC, { exec: missing.exec, locate })
  assert.deepEqual(missing.calls, ['plugin list --json'])
  assert.equal(skipped[0]?.state, 'skipped')

  const blind = fakeClaude({ 'plugin uninstall': new Error('Plugin "demo@demo" is not installed') })
  const blindSteps = await uninstallClaudePlugin(SPEC, { exec: async (command, args) => { await blind.exec(command, args) }, locate })
  assert.equal(blindSteps[0]?.state, 'skipped')

  const absent = await uninstallClaudePlugin(SPEC, { locate: async () => null })
  assert.equal(absent[0]?.state, 'unavailable')
})

async function legacyFixture(root: string): Promise<AgentIntegration> {
  const skillDir = path.join(root, 'pkg', 'skills', 'demo')
  await mkdir(skillDir, { recursive: true })
  await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: Demo\n---\n\n::: agent claude\nClaude only.\n:::\n')
  const plainDir = path.join(root, 'pkg', 'skills', 'plain')
  await mkdir(plainDir, { recursive: true })
  await writeFile(path.join(plainDir, 'SKILL.md'), '---\nname: plain\ndescription: Plain\n---\n\nPlain.\n')
  const commands = path.join(root, 'pkg', 'commands')
  await mkdir(commands, { recursive: true })
  await writeFile(path.join(commands, 'demo-start.md'), '---\ndescription: Start\n---\n\nStart $ARGUMENTS.\n')
  return {
    tool: 'demo',
    version: '1.0.0',
    skills: [{ name: 'demo', dir: skillDir }, { name: 'plain', dir: plainDir }, { name: 'foreign', dir: path.join(root, 'pkg', 'skills', 'foreign') }],
    commands: [{ name: 'demo-start', file: path.join(commands, 'demo-start.md') }],
    mcp: [{ name: 'demo', command: ['demo', 'mcp'] }],
    claude: {
      permissions: { allow: ['Bash(demo:*)'] },
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'demo hook prompt' }] }] },
    },
  }
}

test('removeLegacyClaude removes what kit 0.2 wrote and nothing else', async (t) => {
  const home = await tempDir(t)
  const ctx = sandbox(home, { PATH: '' })
  const homes = { claude: path.join(home, '.claude') }
  const integration = await legacyFixture(home)
  await mkdir(homes.claude, { recursive: true })
  await writeFile(
    path.join(homes.claude, 'settings.json'),
    JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'other hook' }] }] } }),
  )
  const setup = await installIntegration({ ...integration, skills: (integration.skills ?? []).slice(0, 2) }, { agents: ['claude'], ctx, homes, locate: async () => null })
  assert.deepEqual(setup.filter((step) => step.state === 'failed'), [])
  const foreign = path.join(homes.claude, 'skills', 'foreign')
  await mkdir(foreign, { recursive: true })
  await writeFile(path.join(foreign, 'SKILL.md'), 'mine')

  const claude = fakeClaude({})
  const steps = await removeLegacyClaude(integration, { ctx, homes, exec: claude.exec, locate })

  assert.ok(!existsSync(path.join(homes.claude, 'skills', 'demo')))
  assert.ok(!existsSync(path.join(homes.claude, 'skills', 'plain')))
  assert.ok(existsSync(path.join(foreign, 'SKILL.md')))
  assert.ok(!existsSync(path.join(homes.claude, 'commands', 'demo-start.md')))
  assert.ok(existsSync(path.join(integration.skills?.[0]?.dir ?? '', 'SKILL.md')))
  const settings = JSON.parse(await readFile(path.join(homes.claude, 'settings.json'), 'utf8'))
  assert.deepEqual(settings.permissions.allow, ['Bash(ls:*)'])
  assert.deepEqual(settings.hooks.UserPromptSubmit, [{ hooks: [{ type: 'command', command: 'other hook' }] }])
  assert.deepEqual(claude.calls, ['mcp remove --scope user demo'])
  assert.deepEqual(
    steps.map((step) => [step.item, step.state]),
    [
      ['skill demo', 'removed'],
      ['skill plain', 'removed'],
      ['skill foreign', 'skipped'],
      ['command demo-start', 'removed'],
      ['settings', 'removed'],
      ['mcp demo', 'removed'],
    ],
  )

  const again = await removeLegacyClaude(integration, { ctx, homes, exec: claude.exec, locate, skipMcp: true })
  assert.ok(again.every((step) => step.state === 'skipped'))
})

test('removeLegacyClaude removes links into an older copy of the package', { skip: process.platform === 'win32' }, async (t) => {
  const home = await tempDir(t)
  const ctx = sandbox(home, { PATH: '' })
  const homes = { claude: path.join(home, '.claude') }
  const integration = await legacyFixture(home)
  const old = path.join(home, 'store', '@kikedealba', 'demo', '0.9.0', 'skills', 'demo')
  await mkdir(old, { recursive: true })
  await mkdir(path.join(homes.claude, 'skills'), { recursive: true })
  await symlink(old, path.join(homes.claude, 'skills', 'demo'))
  const elsewhere = path.join(home, 'dev', 'github.com', 'KikeDeAlba', 'demo', 'plain')
  await mkdir(elsewhere, { recursive: true })
  await symlink(elsewhere, path.join(homes.claude, 'skills', 'plain'))
  await removeLegacyClaude(integration, { ctx, homes, locate: async () => null, skipMcp: true })
  assert.ok(!existsSync(path.join(homes.claude, 'skills', 'demo')))
  assert.ok(lstatSync(path.join(homes.claude, 'skills', 'plain')).isSymbolicLink())
})

test('opencode skips what claude-compat already relays from Claude Code', async (t) => {
  const home = await tempDir(t)
  const ctx = sandbox(home, { PATH: '' })
  const pkg = path.join(home, 'pkg')
  await mkdir(path.join(pkg, 'skill'), { recursive: true })
  await writeFile(path.join(pkg, 'skill', 'SKILL.md'), '---\nname: demo\ndescription: Demo\n---\n\nDemo.\n')
  await mkdir(path.join(pkg, 'user-start'), { recursive: true })
  await writeFile(path.join(pkg, 'user-start', 'SKILL.md'), '---\nname: demo-go\ndescription: Go now\ndisable-model-invocation: true\n---\n\nGo $ARGUMENTS.\n')
  await writeFile(path.join(pkg, 'start.md'), '---\ndescription: Start\n---\n\nStart.\n')
  await writeFile(path.join(pkg, 'plugin.js'), 'export default {}\n')
  const hooks = { UserPromptSubmit: [{ hooks: [{ type: 'command' as const, command: 'demo hook prompt' }] }] }
  const integration: AgentIntegration = {
    tool: 'demo',
    version: '1.0.0',
    skills: [{ name: 'demo', dir: path.join(pkg, 'skill') }],
    userSkills: [{ name: 'demo-go', dir: path.join(pkg, 'user-start') }],
    commands: [{ name: 'demo-start', file: path.join(pkg, 'start.md') }],
    claude: { hooks },
    opencode: { plugins: [{ name: 'demo', file: path.join(pkg, 'plugin.js') }] },
  }
  const homes = { claude: path.join(home, '.claude'), opencode: path.join(home, '.config', 'opencode') }
  const options = { agents: ['opencode'] as const, ctx, homes, locate: async () => null }

  const plain = await installIntegration(integration, options)
  assert.deepEqual(plain.filter((step) => step.state === 'skipped'), [])
  assert.ok(existsSync(path.join(homes.opencode, 'plugins', 'demo.js')))
  const converted = await readFile(path.join(homes.opencode, 'commands', 'demo-go.md'), 'utf8')
  assert.match(converted, /^---\ndescription: "Go now"\n---\n/)
  assert.doesNotMatch(converted, /disable-model-invocation/)

  await mkdir(path.join(homes.opencode, 'plugins', 'claude-compat'), { recursive: true })
  const migrated = await installIntegration(integration, options)
  assert.deepEqual(migrated.filter((step) => step.state === 'skipped'), [])

  await mkdir(path.join(homes.claude, 'commands'), { recursive: true })
  await writeFile(path.join(homes.claude, 'commands', 'demo-start.md'), 'legacy')
  await writeFile(path.join(homes.claude, 'settings.json'), JSON.stringify({ hooks }))
  const relayed = await installIntegration(integration, options)
  assert.deepEqual(
    relayed.filter((step) => step.state === 'skipped').map((step) => step.item),
    ['command demo-start', 'plugin demo'],
  )
  assert.ok(relayed.every((step) => step.state !== 'skipped' || /claude-compat already relays/.test(step.detail)))
  assert.ok(!existsSync(path.join(homes.opencode, 'plugins', 'demo.js')))
  assert.ok(!existsSync(path.join(homes.opencode, 'commands', 'demo-start.md')))
  assert.ok(existsSync(path.join(homes.opencode, 'commands', 'demo-go.md')))
  assert.ok(existsSync(path.join(homes.opencode, 'skills', 'demo', 'SKILL.md')))

  const forcedOff = await installIntegration(integration, { ...options, claudeCompat: false })
  assert.deepEqual(forcedOff.filter((step) => step.state === 'skipped'), [])
  assert.ok(existsSync(path.join(homes.opencode, 'plugins', 'demo.js')))

  const forcedOn = await installIntegration(integration, { ...options, homes: { ...homes, claude: path.join(home, 'empty') }, claudeCompat: true })
  assert.deepEqual(
    forcedOn.filter((step) => step.state === 'skipped').map((step) => step.item),
    ['command demo-start', 'plugin demo'],
  )
})

test('user skills become commands for codex and gemini and are removed on uninstall', async (t) => {
  const home = await tempDir(t)
  const ctx = sandbox(home, { PATH: '' })
  const dir = path.join(home, 'pkg', 'demo-go')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'SKILL.md'), '---\nname: demo-go\ndescription: Go now\nargument-hint: "[title]"\ndisable-model-invocation: true\n---\n\nGo $ARGUMENTS.\n')
  const integration: AgentIntegration = { tool: 'demo', version: '1.0.0', userSkills: [{ name: 'demo-go', dir }] }
  const homes = {
    claude: path.join(home, '.claude'),
    codex: path.join(home, '.codex'),
    agentsSkills: path.join(home, '.agents', 'skills'),
    gemini: path.join(home, '.gemini'),
    opencode: path.join(home, '.config', 'opencode'),
  }
  const steps = await installIntegration(integration, { agents: 'all', ctx, homes, locate: async () => null })
  assert.deepEqual(steps.filter((step) => step.state === 'failed'), [])
  assert.ok(!steps.some((step) => step.agent === 'claude'))
  assert.ok(!existsSync(path.join(homes.claude, 'commands')))
  const prompt = await readFile(path.join(homes.codex, 'prompts', 'demo-go.md'), 'utf8')
  assert.match(prompt, /description: "Go now"/)
  assert.match(prompt, /argument-hint: "\[title\]"/)
  assert.doesNotMatch(prompt, /disable-model-invocation/)
  const toml = await readFile(path.join(homes.gemini, 'extensions', 'demo', 'commands', 'demo-go.toml'), 'utf8')
  assert.match(toml, /Go \{\{args\}\}/)
  assert.ok(!existsSync(path.join(homes.agentsSkills, 'demo-go')))

  await uninstallIntegration(integration, { agents: 'all', ctx, homes })
  assert.ok(!existsSync(path.join(homes.codex, 'prompts', 'demo-go.md')))
  assert.ok(!existsSync(path.join(homes.opencode, 'commands', 'demo-go.md')))
})

test('edit tool matchers cover every agent', () => {
  assert.equal(EDIT_TOOL_MATCHERS.claude, 'Edit|Write|MultiEdit')
  assert.match(EDIT_TOOL_MATCHERS.codex, /apply_patch/)
  assert.deepEqual(Object.keys(EDIT_TOOL_MATCHERS).sort(), ['claude', 'codex', 'gemini', 'opencode'])
})
