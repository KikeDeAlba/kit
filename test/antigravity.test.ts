import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import {
  agentHomes,
  detectAgents,
  installIntegration,
  memoryFile,
  renderForAgent,
  renderMemory,
  subagentForAntigravity,
  uninstallIntegration,
  type AgentIntegration,
} from '../src/agents/index.ts'
import { dataHome } from '../src/platform.ts'
import { fakeAgy, sandbox, tempDir } from './helpers.ts'

const REVIEWER = `---
name: reviewer
description: Reviews the diff.
tools: Read, Grep, Glob, LS, Skill, Read
model: sonnet
effort: high
maxTurns: 20
---

Review the diff.

::: agent antigravity
Only antigravity.
:::
`

const SKILL = `---
name: demo
description: Demo skill
allowed-tools: Bash(demo:*)
argument-hint: <task>
---

# Demo

::: agent !antigravity
Not for antigravity.
:::
`

const MEMORY = `# Rules

Commit in English.

::: agent gemini
Gemini only.
:::

::: agent claude
Claude only.
:::
`

function subagent(tools: string): string {
  return `---\nname: x\ndescription: X\ntools: ${tools}\n---\n\nBody.\n`
}

test('subagents convert to antigravity markdown with mapped tools', () => {
  const reviewer = subagentForAntigravity(REVIEWER, 'reviewer')
  assert.equal(
    reviewer.split('\n---\n')[0],
    '---\nname: reviewer\ndescription: "Reviews the diff."\ntools: [view_file, list_dir, grep_search, find_by_name]\nmodel: inherit',
  )
  assert.match(reviewer, /Only antigravity/)
  assert.doesNotMatch(reviewer, /effort|max_turns|maxTurns|sonnet|commandExecutionPolicy|:::/)
  assert.match(
    subagentForAntigravity(subagent('Write, Bash, WebSearch, Edit, MultiEdit, WebFetch, TodoWrite, Agent'), 'x'),
    /\ntools: \[run_command, replace_file_content, multi_replace_file_content, write_to_file, read_url_content, search_web\]\n/,
  )
  assert.doesNotMatch(subagentForAntigravity(subagent('*'), 'x'), /tools:/)
  assert.doesNotMatch(subagentForAntigravity('---\nname: x\ndescription: X\n---\nBody.\n', 'x'), /tools:/)
  assert.throws(() => subagentForAntigravity(subagent('Skill, Task, NotebookEdit'), 'x'), /none of its tools/)
})

test('antigravity memory renders as gemini and lives next to the antigravity config', () => {
  assert.equal(renderMemory(MEMORY, 'antigravity'), renderForAgent(MEMORY, 'gemini'))
  assert.equal(renderMemory(MEMORY, 'claude'), renderForAgent(MEMORY, 'claude'))
  const ctx = sandbox('/home/u')
  const homes = agentHomes(ctx)
  assert.equal(homes.antigravity, path.join('/home/u', '.gemini', 'config'))
  assert.equal(memoryFile('antigravity', homes), path.join('/home/u', '.gemini', 'GEMINI.md'))
  assert.equal(memoryFile('antigravity', homes), memoryFile('gemini', homes))
  assert.equal(memoryFile('antigravity', agentHomes(ctx, { antigravity: '/x/config' })), path.join('/x', 'GEMINI.md'))
})

test('gemini and antigravity are detected by binary or their own folders', async (t) => {
  const home = await tempDir(t)
  const ctx = sandbox(home, { PATH: '' })
  const homes = agentHomes(ctx, { claudeDesktop: null })
  const none = async () => null
  await mkdir(homes.gemini, { recursive: true })
  assert.deepEqual(await detectAgents(ctx, homes, none), [])
  assert.deepEqual(await detectAgents(ctx, homes, async (command) => (command === 'gemini' ? '/bin/gemini' : null)), ['gemini'])
  assert.deepEqual(await detectAgents(ctx, homes, async (command) => (command === 'agy' ? '/bin/agy' : null)), ['antigravity'])
  await mkdir(homes.antigravity, { recursive: true })
  assert.deepEqual(await detectAgents(ctx, homes, none), ['antigravity'])
  await mkdir(path.join(homes.gemini, 'extensions'), { recursive: true })
  assert.deepEqual(await detectAgents(ctx, homes, none), ['gemini', 'antigravity'])
})

async function fixture(home: string): Promise<{ integration: AgentIntegration; homes: { gemini: string; antigravity: string } }> {
  const pkg = path.join(home, 'pkg')
  await mkdir(path.join(pkg, 'agents'), { recursive: true })
  await mkdir(path.join(pkg, 'skills', 'demo'), { recursive: true })
  await mkdir(path.join(pkg, 'skills', 'demo-go'), { recursive: true })
  await mkdir(path.join(pkg, 'commands'), { recursive: true })
  await writeFile(path.join(pkg, 'agents', 'reviewer.md'), REVIEWER)
  await writeFile(path.join(pkg, 'skills', 'demo', 'SKILL.md'), SKILL)
  await writeFile(path.join(pkg, 'skills', 'demo', 'notes.txt'), 'extra\n')
  await writeFile(path.join(pkg, 'skills', 'demo-go', 'SKILL.md'), '---\nname: demo-go\ndescription: Go\ndisable-model-invocation: true\n---\n\nGo.\n')
  await writeFile(path.join(pkg, 'commands', 'demo-start.md'), '---\ndescription: Start\n---\n\nStart.\n')
  await writeFile(path.join(pkg, 'memory.md'), MEMORY)
  await writeFile(path.join(pkg, 'rules.md'), 'Delegate with invoke_subagent.\n\n::: agent !antigravity\nHidden.\n:::\n')
  return {
    integration: {
      tool: 'demo',
      version: '1.2.3',
      description: 'Demo tool',
      subagents: [{ name: 'reviewer', file: path.join(pkg, 'agents', 'reviewer.md') }],
      skills: [{ name: 'demo', dir: path.join(pkg, 'skills', 'demo') }],
      userSkills: [{ name: 'demo-go', dir: path.join(pkg, 'skills', 'demo-go') }],
      commands: [{ name: 'demo-start', file: path.join(pkg, 'commands', 'demo-start.md') }],
      mcp: [{ name: 'demo', command: ['demo', 'mcp'] }],
      memory: path.join(pkg, 'memory.md'),
      antigravity: { rules: path.join(pkg, 'rules.md') },
    },
    homes: { gemini: path.join(home, '.gemini'), antigravity: path.join(home, '.gemini', 'config') },
  }
}

test('installs an antigravity plugin through agy and is idempotent', async (t) => {
  const home = await tempDir(t)
  const ctx = sandbox(home, { PATH: '' })
  const { integration, homes } = await fixture(home)
  const agy = fakeAgy(homes)
  const steps = await installIntegration(integration, { agents: ['antigravity'], ctx, homes, exec: agy.exec, locate: agy.locate })
  assert.deepEqual(steps.map((step) => [step.item, step.state]), [
    ['memory', 'installed'],
    ['commands', 'skipped'],
    ['mcp', 'skipped'],
    ['plugin', 'installed'],
  ])
  assert.match(steps.find((step) => step.item === 'commands')?.detail ?? '', /not supported for antigravity/)
  const root = path.join(dataHome(ctx), 'kikedealba', 'agents', 'antigravity', 'demo')
  assert.deepEqual(agy.calls, ['plugin list --json', `plugin validate ${root} --strict --json`, `plugin install ${root}`])

  const installed = path.join(homes.antigravity, 'plugins', 'demo')
  assert.deepEqual(JSON.parse(await readFile(path.join(installed, 'plugin.json'), 'utf8')), { name: 'demo', version: '1.2.3', description: 'Demo tool' })
  assert.match(await readFile(path.join(installed, 'agents', 'reviewer.md'), 'utf8'), /^---\nname: reviewer\n/)
  const skill = await readFile(path.join(installed, 'skills', 'demo', 'SKILL.md'), 'utf8')
  assert.match(skill, /^---\nname: demo\ndescription: "Demo skill"\n---\n\n# Demo\n/)
  assert.doesNotMatch(skill, /allowed-tools|argument-hint|Not for antigravity/)
  assert.equal(await readFile(path.join(installed, 'skills', 'demo', 'notes.txt'), 'utf8'), 'extra\n')
  assert.doesNotMatch(await readFile(path.join(installed, 'skills', 'demo-go', 'SKILL.md'), 'utf8'), /disable-model-invocation/)
  assert.equal(await readFile(path.join(installed, 'rules', 'demo.md'), 'utf8'), '---\ntrigger: always_on\n---\nDelegate with invoke_subagent.\n\n')
  assert.ok(!existsSync(path.join(installed, 'hooks.json')))
  assert.ok(!existsSync(path.join(installed, 'mcp_config.json')))
  assert.ok(!existsSync(path.join(installed, 'commands')))

  agy.calls.length = 0
  const again = await installIntegration(integration, { agents: ['antigravity'], ctx, homes, exec: agy.exec, locate: agy.locate })
  assert.deepEqual(again.filter((step) => ['plugin', 'memory'].includes(step.item)).map((step) => step.state), ['present', 'present'])
  assert.deepEqual(agy.calls, ['plugin list --json'])

  agy.calls.length = 0
  const removed = await uninstallIntegration(integration, { agents: ['antigravity'], ctx, homes, exec: agy.exec, locate: agy.locate })
  assert.deepEqual(removed.map((step) => [step.item, step.state]), [['plugin', 'removed'], ['memory', 'removed']])
  assert.deepEqual(agy.calls, ['plugin list --json', 'plugin uninstall demo'])
  assert.ok(!existsSync(installed))
  assert.ok(!existsSync(root))
  const twice = await uninstallIntegration(integration, { agents: ['antigravity'], ctx, homes, exec: agy.exec, locate: agy.locate })
  assert.equal(twice.find((step) => step.item === 'plugin')?.state, 'skipped')
})

test('a failed validation does not install the plugin', async (t) => {
  const home = await tempDir(t)
  const ctx = sandbox(home, { PATH: '' })
  const { integration, homes } = await fixture(home)
  const agy = fakeAgy(homes, { validate: Object.assign(new Error('Command failed'), { stderr: 'plugin.json: missing field' }) })
  const steps = await installIntegration(integration, { agents: ['antigravity'], ctx, homes, exec: agy.exec, locate: agy.locate })
  const plugin = steps.find((step) => step.item === 'plugin')
  assert.equal(plugin?.state, 'failed')
  assert.match(plugin?.detail ?? '', /missing field/)
  assert.ok(!agy.calls.some((call) => call.startsWith('plugin install')))
  assert.ok(!existsSync(path.join(homes.antigravity, 'plugins', 'demo')))
})

test('without agy the plugin is rendered and reported as unavailable', async (t) => {
  const home = await tempDir(t)
  const ctx = sandbox(home, { PATH: '' })
  const { integration, homes } = await fixture(home)
  const steps = await installIntegration(integration, { agents: ['antigravity'], ctx, homes, locate: async () => null })
  const plugin = steps.find((step) => step.item === 'plugin')
  assert.equal(plugin?.state, 'unavailable')
  assert.match(plugin?.detail ?? '', /agy plugin install /)
  assert.ok(plugin?.path && existsSync(path.join(plugin.path, 'plugin.json')))
  const removed = await uninstallIntegration(integration, { agents: ['antigravity'], ctx, homes, locate: async () => null })
  assert.equal(removed.find((step) => step.item === 'plugin')?.state, 'unavailable')
})

test('a subagent without antigravity tools fails the render and nothing is installed', async (t) => {
  const home = await tempDir(t)
  const ctx = sandbox(home, { PATH: '' })
  const { integration, homes } = await fixture(home)
  const broken = path.join(home, 'pkg', 'agents', 'broken.md')
  await writeFile(broken, subagent('Skill, Agent'))
  const agy = fakeAgy(homes)
  const steps = await installIntegration({ ...integration, subagents: [{ name: 'broken', file: broken }] }, { agents: ['antigravity'], ctx, homes, exec: agy.exec, locate: agy.locate })
  const plugin = steps.filter((step) => step.item === 'plugin')
  assert.deepEqual(plugin.map((step) => step.state), ['failed'])
  assert.match(plugin[0]?.detail ?? '', /none of its tools/)
  assert.deepEqual(agy.calls, [])
})

test('gemini and antigravity share one memory block and either can be removed first', async (t) => {
  for (const order of [['gemini', 'antigravity'], ['antigravity', 'gemini']] as const) {
    const home = await tempDir(t)
    const ctx = sandbox(home, { PATH: '' })
    const { integration, homes } = await fixture(home)
    const file = path.join(homes.gemini, 'GEMINI.md')
    await mkdir(homes.gemini, { recursive: true })
    await writeFile(file, '# Mine\n')
    const agy = fakeAgy(homes)
    const options = { ctx, homes, exec: agy.exec, locate: agy.locate }

    const first = await installIntegration(integration, { ...options, agents: ['gemini', 'antigravity'] })
    assert.deepEqual(first.filter((step) => step.item === 'memory').map((step) => [step.agent, step.state]), [['gemini', 'installed'], ['antigravity', 'present']])
    const text = await readFile(file, 'utf8')
    assert.equal(text.match(/kit:demo:begin/g)?.length, 1)
    assert.match(text, /Gemini only/)
    assert.doesNotMatch(text, /Claude only/)
    const second = await installIntegration(integration, { ...options, agents: ['antigravity', 'gemini'] })
    assert.deepEqual(second.filter((step) => step.item === 'memory').map((step) => step.state), ['present', 'present'])
    assert.equal(await readFile(file, 'utf8'), text)

    const [head, tail] = order
    const kept = await uninstallIntegration(integration, { ...options, agents: [head] })
    const memory = kept.find((step) => step.item === 'memory')
    assert.equal(memory?.state, 'skipped')
    assert.match(memory?.detail ?? '', new RegExp(`still used by ${tail}`))
    assert.match(await readFile(file, 'utf8'), /kit:demo:begin/)
    const gone = await uninstallIntegration(integration, { ...options, agents: [tail] })
    assert.equal(gone.find((step) => step.item === 'memory')?.state, 'removed')
    assert.equal(await readFile(file, 'utf8'), '# Mine\n')
  }
})

test('uninstalling gemini and antigravity together removes the shared memory block', async (t) => {
  const home = await tempDir(t)
  const ctx = sandbox(home, { PATH: '' })
  const { integration, homes } = await fixture(home)
  const agy = fakeAgy(homes)
  const options = { ctx, homes, exec: agy.exec, locate: agy.locate, agents: ['gemini', 'antigravity'] as const }
  await installIntegration(integration, options)
  const steps = await uninstallIntegration(integration, options)
  assert.deepEqual(steps.filter((step) => step.item === 'memory').map((step) => [step.agent, step.state]), [['gemini', 'skipped'], ['antigravity', 'removed']])
  assert.equal(await readFile(path.join(homes.gemini, 'GEMINI.md'), 'utf8'), '')
})
