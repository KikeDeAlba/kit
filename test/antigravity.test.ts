import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
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
    ['mcp demo', 'installed'],
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
  assert.deepEqual(again.filter((step) => ['plugin', 'memory', 'mcp demo'].includes(step.item)).map((step) => step.state), ['present', 'present', 'present'])
  assert.deepEqual(agy.calls, ['plugin list --json'])

  agy.calls.length = 0
  const removed = await uninstallIntegration(integration, { agents: ['antigravity'], ctx, homes, exec: agy.exec, locate: agy.locate })
  assert.deepEqual(removed.map((step) => [step.item, step.state]), [['plugin', 'removed'], ['mcp demo', 'removed'], ['memory', 'removed']])
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

test('tool mapping covers every entry, drops unsupported tools and keeps a fixed order without duplicates', () => {
  const table: Array<[string, string]> = [
    ['Read', 'view_file, list_dir'],
    ['Grep', 'grep_search'],
    ['Glob', 'find_by_name'],
    ['LS', 'list_dir'],
    ['Bash', 'run_command'],
    ['Edit', 'replace_file_content'],
    ['MultiEdit', 'multi_replace_file_content'],
    ['Write', 'write_to_file'],
    ['WebFetch', 'read_url_content'],
    ['WebSearch', 'search_web'],
  ]
  for (const [claude, expected] of table) {
    assert.match(subagentForAntigravity(subagent(claude), 'x'), new RegExp(`\\ntools: \\[${expected}\\]\\n`))
  }
  const mixed = subagentForAntigravity(subagent('Skill, Agent, Task, NotebookEdit, TodoWrite, Unknown, WebSearch, Grep, LS, Read, Grep'), 'x')
  assert.match(mixed, /\ntools: \[view_file, list_dir, grep_search, search_web\]\n/)
  assert.doesNotMatch(mixed, /Skill|Agent|Task|NotebookEdit|TodoWrite|Unknown/)
  assert.match(subagentForAntigravity(subagent('Read, Skill'), 'x'), /\ntools: \[view_file, list_dir\]\n/)
  assert.throws(() => subagentForAntigravity(subagent('Skill, Unknown'), 'x'), /none of its tools/)
  assert.throws(() => subagentForAntigravity(subagent('Agent'), 'x'), /none of its tools/)
})

test('unrestricted subagents get the full antigravity tool list', () => {
  const full =
    '\ntools: [view_file, list_dir, grep_search, find_by_name, run_command, replace_file_content, multi_replace_file_content, write_to_file, read_url_content, search_web]\nmodel: inherit\n'
  assert.ok(subagentForAntigravity('---\nname: x\ndescription: X\n---\nBody.\n', 'x').includes(full))
  assert.ok(subagentForAntigravity(subagent(''), 'x').includes(full))
  assert.ok(subagentForAntigravity(subagent('*'), 'x').includes(full))
  assert.ok(subagentForAntigravity(subagent('Read, *'), 'x').includes(full))
  assert.ok(subagentForAntigravity(subagent('*, Skill'), 'x').includes(full))
})

test('the plugin tree holds real files and reinstalls when the rendered plugin differs from the installed one', async (t) => {
  const home = await tempDir(t)
  const ctx = sandbox(home, { PATH: '' })
  const { integration, homes } = await fixture(home)
  const agy = fakeAgy(homes)
  const options = { agents: ['antigravity'] as const, ctx, homes, exec: agy.exec, locate: agy.locate }
  await installIntegration(integration, options)
  const root = path.join(dataHome(ctx), 'kikedealba', 'agents', 'antigravity', 'demo')
  for (const file of ['plugin.json', 'agents/reviewer.md', 'skills/demo/SKILL.md', 'skills/demo/notes.txt', 'skills/demo-go/SKILL.md', 'rules/demo.md']) {
    const stat = await lstat(path.join(root, file))
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), file)
  }
  assert.ok((await lstat(path.join(root, 'skills', 'demo'))).isDirectory())
  assert.ok(!(await lstat(path.join(root, 'skills', 'demo'))).isSymbolicLink())

  agy.calls.length = 0
  const steps = await installIntegration({ ...integration, version: '1.2.4' }, options)
  assert.equal(steps.find((step) => step.item === 'plugin')?.state, 'installed')
  assert.deepEqual(agy.calls, ['plugin list --json', `plugin validate ${root} --strict --json`, `plugin install ${root}`])
  assert.equal(JSON.parse(await readFile(path.join(homes.antigravity, 'plugins', 'demo', 'plugin.json'), 'utf8')).version, '1.2.4')
})

test('an integration without antigravity rules renders no rules directory', async (t) => {
  const home = await tempDir(t)
  const ctx = sandbox(home, { PATH: '' })
  const { integration, homes } = await fixture(home)
  const agy = fakeAgy(homes)
  await installIntegration({ ...integration, antigravity: {} }, { agents: ['antigravity'], ctx, homes, exec: agy.exec, locate: agy.locate })
  assert.ok(!existsSync(path.join(homes.antigravity, 'plugins', 'demo', 'rules')))
})

test('an unreadable plugin list falls back to validate and install, and uninstall of an absent plugin is skipped', async (t) => {
  const home = await tempDir(t)
  const ctx = sandbox(home, { PATH: '' })
  const { integration, homes } = await fixture(home)
  const agy = fakeAgy(homes)
  const exec: typeof agy.exec = async (command, args) => (args[1] === 'list' ? 'not json' : agy.exec(command, args))
  const steps = await installIntegration(integration, { agents: ['antigravity'], ctx, homes, exec, locate: agy.locate })
  assert.equal(steps.find((step) => step.item === 'plugin')?.state, 'installed')
  const removed = await uninstallIntegration(integration, { agents: ['antigravity'], ctx, homes, exec: async (command, args) => (args[1] === 'list' ? JSON.stringify([]) : agy.exec(command, args)), locate: agy.locate })
  assert.equal(removed.find((step) => step.item === 'plugin')?.state, 'skipped')
  assert.ok(!agy.calls.includes('plugin uninstall demo'))
})

test('a plugin list wrapped in an object is understood', async (t) => {
  const home = await tempDir(t)
  const ctx = sandbox(home, { PATH: '' })
  const { integration, homes } = await fixture(home)
  const agy = fakeAgy(homes)
  const exec: typeof agy.exec = async (command, args) => {
    const output = await agy.exec(command, args)
    return args[1] === 'list' ? JSON.stringify({ plugins: JSON.parse(output as string) }) : output
  }
  const options = { agents: ['antigravity'] as const, ctx, homes, exec, locate: agy.locate }
  assert.equal((await installIntegration(integration, options)).find((step) => step.item === 'plugin')?.state, 'installed')
  agy.calls.length = 0
  assert.equal((await installIntegration(integration, options)).find((step) => step.item === 'plugin')?.state, 'present')
  assert.deepEqual(agy.calls, ['plugin list --json'])
  assert.equal((await uninstallIntegration(integration, options)).find((step) => step.item === 'plugin')?.state, 'removed')
  agy.calls.length = 0
  assert.equal((await uninstallIntegration(integration, options)).find((step) => step.item === 'plugin')?.state, 'skipped')
  assert.deepEqual(agy.calls, ['plugin list --json'])
})

test('failing plugin list and uninstall commands become steps instead of exceptions', async (t) => {
  const home = await tempDir(t)
  const ctx = sandbox(home, { PATH: '' })
  const { integration, homes } = await fixture(home)
  const agy = fakeAgy(homes)
  const failing = (uninstall: Error) => async (command: string, args: readonly string[]) => {
    if (args[1] === 'list') throw new Error('agy crashed')
    if (args[1] === 'uninstall') throw uninstall
    return agy.exec(command, args)
  }
  const options = { agents: ['antigravity'] as const, ctx, homes, locate: agy.locate }
  const installed = await installIntegration(integration, { ...options, exec: failing(new Error('unused')) })
  assert.equal(installed.find((step) => step.item === 'plugin')?.state, 'installed')

  const failed = await uninstallIntegration(integration, { ...options, exec: failing(Object.assign(new Error('Command failed'), { stderr: 'permission denied' })) })
  const plugin = failed.find((step) => step.item === 'plugin')
  assert.equal(plugin?.state, 'failed')
  assert.match(plugin?.detail ?? '', /agy plugin uninstall failed/)
  assert.equal(failed.find((step) => step.item === 'memory')?.state, 'removed')

  const absent = await uninstallIntegration(integration, { ...options, exec: failing(Object.assign(new Error('Command failed'), { stderr: 'plugin demo not found' })) })
  assert.equal(absent.find((step) => step.item === 'plugin')?.state, 'skipped')

  const removed = await uninstallIntegration(integration, { ...options, exec: async (command, args) => (args[1] === 'list' ? Promise.reject(new Error('agy crashed')) : agy.exec(command, args)) })
  assert.equal(removed.find((step) => step.item === 'plugin')?.state, 'removed')
  assert.ok(!existsSync(path.join(homes.antigravity, 'plugins', 'demo')))
})

async function splitHomes(t: Parameters<typeof tempDir>[0]) {
  const home = await tempDir(t)
  const ctx = sandbox(home, { PATH: '', GEMINI_CLI_HOME: path.join(home, 'cli') })
  const { integration } = await fixture(home)
  const homes = agentHomes(ctx, { claudeDesktop: null })
  return { ctx, integration, homes, geminiFile: memoryFile('gemini', homes), antigravityFile: memoryFile('antigravity', homes) }
}

test('with GEMINI_CLI_HOME gemini and antigravity keep separate memory blocks', async (t) => {
  const { ctx, integration, homes, geminiFile, antigravityFile } = await splitHomes(t)
  assert.notEqual(geminiFile, antigravityFile)
  assert.equal(geminiFile, path.join(ctx.home, 'cli', '.gemini', 'GEMINI.md'))
  assert.equal(antigravityFile, path.join(ctx.home, '.gemini', 'GEMINI.md'))
  const agy = fakeAgy(homes)
  const options = { ctx, homes, exec: agy.exec, locate: agy.locate }

  const steps = await installIntegration(integration, { ...options, agents: ['gemini', 'antigravity'] })
  assert.deepEqual(steps.filter((step) => step.item === 'memory').map((step) => [step.agent, step.state]), [['gemini', 'installed'], ['antigravity', 'installed']])
  assert.match(await readFile(geminiFile, 'utf8'), /kit:demo:begin/)
  assert.match(await readFile(antigravityFile, 'utf8'), /kit:demo:begin/)

  const gemini = await uninstallIntegration(integration, { ...options, agents: ['gemini'] })
  assert.equal(gemini.find((step) => step.item === 'memory')?.state, 'removed')
  assert.doesNotMatch(await readFile(geminiFile, 'utf8'), /kit:demo:begin/)
  assert.match(await readFile(antigravityFile, 'utf8'), /kit:demo:begin/)

  const antigravity = await uninstallIntegration(integration, { ...options, agents: ['antigravity'] })
  assert.equal(antigravity.find((step) => step.item === 'memory')?.state, 'removed')
  assert.doesNotMatch(await readFile(antigravityFile, 'utf8'), /kit:demo:begin/)
})

test('an exception in one agent during uninstall does not stop the others or its memory removal', async (t) => {
  const { ctx, integration, homes, geminiFile, antigravityFile } = await splitHomes(t)
  const agy = fakeAgy(homes)
  await installIntegration(integration, { ctx, homes, exec: agy.exec, locate: agy.locate, agents: ['antigravity', 'gemini'] })
  const locate = async (command: string) => {
    if (command === 'agy') throw new Error('locator exploded')
    return agy.locate(command)
  }
  const steps = await uninstallIntegration(integration, { ctx, homes, exec: agy.exec, locate, agents: ['antigravity', 'gemini'] })
  const failed = steps.find((step) => step.agent === 'antigravity' && step.item === 'integration')
  assert.equal(failed?.state, 'failed')
  assert.match(failed?.detail ?? '', /locator exploded/)
  assert.deepEqual(steps.filter((step) => step.item === 'memory').map((step) => [step.agent, step.state]).sort(), [['antigravity', 'removed'], ['gemini', 'removed']])
  assert.equal(steps.find((step) => step.agent === 'gemini' && step.item === 'extension')?.state, 'removed')
  assert.doesNotMatch(await readFile(antigravityFile, 'utf8'), /kit:demo:begin/)
  assert.doesNotMatch(await readFile(geminiFile, 'utf8'), /kit:demo:begin/)
})

test('antigravity MCP servers merge into mcp_config.json and keep foreign entries', async (t) => {
  const home = await tempDir(t)
  const ctx = sandbox(home, { PATH: '' })
  const { integration, homes } = await fixture(home)
  const file = path.join(homes.antigravity, 'mcp_config.json')
  await mkdir(homes.antigravity, { recursive: true })
  await writeFile(file, JSON.stringify({ mcpServers: { other: { command: 'other', args: [], disabled: true } }, extra: { keep: 1 } }))
  const withRemote: AgentIntegration = {
    ...integration,
    mcp: [
      { name: 'demo', command: ['demo', 'mcp', '--stdio'], env: { DEMO: '1' } },
      { name: 'demo-remote', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer x' } },
    ],
  }
  const agy = fakeAgy(homes)
  const steps = await installIntegration(withRemote, { agents: ['antigravity'], ctx, homes, exec: agy.exec, locate: agy.locate })
  assert.equal(steps.find((step) => step.item === 'mcp demo, demo-remote')?.state, 'installed')
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
    mcpServers: {
      other: { command: 'other', args: [], disabled: true },
      demo: { command: 'demo', args: ['mcp', '--stdio'], env: { DEMO: '1' }, disabled: false },
      'demo-remote': { serverUrl: 'https://example.test/mcp', headers: { Authorization: 'Bearer x' }, disabled: false },
    },
    extra: { keep: 1 },
  })
  assert.ok(existsSync(`${file}.backup`))

  const removed = await uninstallIntegration(withRemote, { agents: ['antigravity'], ctx, homes, exec: agy.exec, locate: agy.locate })
  assert.equal(removed.find((step) => step.item === 'mcp demo, demo-remote')?.state, 'removed')
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { mcpServers: { other: { command: 'other', args: [], disabled: true } }, extra: { keep: 1 } })
  const twice = await uninstallIntegration(withRemote, { agents: ['antigravity'], ctx, homes, exec: agy.exec, locate: agy.locate })
  assert.equal(twice.find((step) => step.item === 'mcp demo, demo-remote')?.state, 'skipped')
})

test('antigravity MCP handles an empty config file, skips invalid JSON and honors skipMcp', async (t) => {
  const home = await tempDir(t)
  const ctx = sandbox(home, { PATH: '' })
  const { integration, homes } = await fixture(home)
  const file = path.join(homes.antigravity, 'mcp_config.json')
  await mkdir(homes.antigravity, { recursive: true })
  await writeFile(file, '')
  const agy = fakeAgy(homes)
  await installIntegration(integration, { agents: ['antigravity'], ctx, homes, exec: agy.exec, locate: agy.locate })
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { mcpServers: { demo: { command: 'demo', args: ['mcp'], env: {}, disabled: false } } })

  await writeFile(file, '{ not json')
  const broken = await installIntegration(integration, { agents: ['antigravity'], ctx, homes, exec: agy.exec, locate: agy.locate })
  assert.equal(broken.find((step) => step.item === 'mcp demo')?.state, 'failed')
  assert.equal(await readFile(file, 'utf8'), '{ not json')

  const skipped = await installIntegration(integration, { agents: ['antigravity'], ctx, homes, exec: agy.exec, locate: agy.locate, skipMcp: true })
  assert.ok(!skipped.some((step) => step.item.startsWith('mcp')))
})
