import assert from 'node:assert/strict'
import { existsSync, lstatSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { installIntegration, uninstallIntegration, type AgentIntegration } from '../src/agents/index.ts'
import { memoryBlock, removeMemoryBlock, subagentForCodex, subagentForGemini, subagentForOpenCode, upsertMemoryBlock } from '../src/agents/subagents.ts'
import { sandbox, tempDir } from './helpers.ts'

const REVIEWER = `---
name: reviewer
description: Reviews the diff; use proactively before merging.
tools: Read, Grep, Glob
model: sonnet
effort: high
maxTurns: 20
---

Review the diff.

::: agent !claude
Follow the general rules.
:::
`

const BUILDER = `---
name: builder
description: Builds features end to end.
model: opus
effort: max
---

Build it.
`

const MEMORY = `# Rules

Commit in English.

::: agent claude
Use EnterWorktree.
:::
`

test('subagents convert to opencode markdown with denied permissions', () => {
  const reviewer = subagentForOpenCode(REVIEWER, 'reviewer')
  assert.match(reviewer, /^---\ndescription: "Reviews the diff; use proactively before merging."\nmode: subagent\nsteps: 20\npermission:\n  edit: deny\n  bash: deny\n  webfetch: deny\n  websearch: deny\n---\n/)
  assert.match(reviewer, /Follow the general rules/)
  assert.doesNotMatch(reviewer, /model:|:::/)
  assert.doesNotMatch(subagentForOpenCode(BUILDER, 'builder'), /permission/)
})

test('subagents convert to codex toml', () => {
  const reviewer = subagentForCodex(REVIEWER, 'reviewer')
  assert.match(reviewer, /^name = "reviewer"\ndescription = "Reviews the diff; use proactively before merging."\nmodel_reasoning_effort = "high"\ndeveloper_instructions = '''\n/)
  assert.match(reviewer, /\[features\]\nshell_tool = false\n$/)
  assert.doesNotMatch(reviewer, /^model =/m)
  const builder = subagentForCodex(BUILDER, 'builder')
  assert.match(builder, /model_reasoning_effort = "xhigh"/)
  assert.doesNotMatch(builder, /\[features\]/)
})

test('subagents convert to gemini markdown with mapped tools', () => {
  const reviewer = subagentForGemini(REVIEWER, 'reviewer')
  assert.match(reviewer, /^---\nname: reviewer\ndescription: ".+"\nkind: local\ntools:\n  - read_file\n  - read_many_files\n  - list_directory\n  - grep_search\n  - glob\nmax_turns: 20\n---\n/)
  assert.doesNotMatch(subagentForGemini(BUILDER, 'builder'), /tools:/)
})

test('memory blocks are upserted idempotently and removed cleanly', () => {
  const original = '# Mine\n\nKeep this.\n'
  const once = upsertMemoryBlock(original, 'demo', 'Rule A')
  assert.equal(once, '# Mine\n\nKeep this.\n\n<!-- kit:demo:begin -->\nRule A\n<!-- kit:demo:end -->\n')
  assert.equal(upsertMemoryBlock(once, 'demo', 'Rule A'), once)
  const changed = upsertMemoryBlock(once, 'demo', 'Rule B')
  assert.equal(memoryBlock(changed, 'demo'), 'Rule B')
  assert.equal(changed.match(/kit:demo:begin/g)?.length, 1)
  assert.equal(removeMemoryBlock(changed, 'demo').text, original)
  assert.deepEqual(removeMemoryBlock(original, 'demo'), { text: original, removed: false })
  assert.equal(upsertMemoryBlock('', 'demo', 'Rule A'), '<!-- kit:demo:begin -->\nRule A\n<!-- kit:demo:end -->\n')
})

test('installs subagents and memory into every agent and uninstalls them', async (t) => {
  const home = await tempDir(t)
  const ctx = sandbox(home, { PATH: '' })
  const pkg = path.join(home, 'pkg')
  await mkdir(path.join(pkg, 'agents'), { recursive: true })
  await writeFile(path.join(pkg, 'agents', 'reviewer.md'), REVIEWER)
  await writeFile(path.join(pkg, 'agents', 'builder.md'), BUILDER)
  await writeFile(path.join(pkg, 'memory.md'), MEMORY)
  const integration: AgentIntegration = {
    tool: 'demo',
    version: '1.0.0',
    subagents: ['reviewer', 'builder'].map((name) => ({ name, file: path.join(pkg, 'agents', `${name}.md`) })),
    memory: path.join(pkg, 'memory.md'),
  }
  const homes = {
    claude: path.join(home, '.claude'),
    opencode: path.join(home, '.config', 'opencode'),
    codex: path.join(home, '.codex'),
    agentsSkills: path.join(home, '.agents', 'skills'),
    gemini: path.join(home, '.gemini'),
  }
  await mkdir(homes.claude, { recursive: true })
  await writeFile(path.join(homes.claude, 'CLAUDE.md'), '# Personal\n')

  const steps = await installIntegration(integration, { agents: 'all', ctx, homes, locate: async () => null })
  assert.deepEqual(steps.filter((step) => step.state === 'failed'), [])

  const claudeReviewer = path.join(homes.claude, 'agents', 'reviewer.md')
  assert.ok(lstatSync(claudeReviewer).isSymbolicLink())
  assert.doesNotMatch(await readFile(claudeReviewer, 'utf8'), /general rules/)
  assert.ok(lstatSync(path.join(homes.claude, 'agents', 'builder.md')).isSymbolicLink())
  const claudeMemory = await readFile(path.join(homes.claude, 'CLAUDE.md'), 'utf8')
  assert.match(claudeMemory, /^# Personal\n\n<!-- kit:demo:begin -->\n# Rules/)
  assert.match(claudeMemory, /Use EnterWorktree/)

  assert.match(await readFile(path.join(homes.opencode, 'agents', 'reviewer.md'), 'utf8'), /mode: subagent/)
  assert.doesNotMatch(await readFile(path.join(homes.opencode, 'AGENTS.md'), 'utf8'), /EnterWorktree/)
  assert.match(await readFile(path.join(homes.codex, 'agents', 'builder.toml'), 'utf8'), /name = "builder"/)
  assert.match(await readFile(path.join(homes.codex, 'AGENTS.md'), 'utf8'), /Commit in English/)
  assert.match(await readFile(path.join(homes.gemini, 'extensions', 'demo', 'agents', 'reviewer.md'), 'utf8'), /kind: local/)
  assert.match(await readFile(path.join(homes.gemini, 'GEMINI.md'), 'utf8'), /Commit in English/)

  const again = await installIntegration(integration, { agents: ['claude', 'opencode', 'codex'], ctx, homes })
  assert.deepEqual(again.filter((step) => step.item === 'memory').map((step) => step.state), ['present', 'present', 'present'])
  assert.ok(again.filter((step) => step.item.startsWith('subagent')).every((step) => step.state === 'present'))

  await uninstallIntegration(integration, { agents: 'all', ctx, homes })
  assert.ok(!existsSync(claudeReviewer))
  assert.equal(await readFile(path.join(homes.claude, 'CLAUDE.md'), 'utf8'), '# Personal\n')
  assert.ok(!existsSync(path.join(homes.opencode, 'agents', 'reviewer.md')))
  assert.ok(!existsSync(path.join(homes.codex, 'agents', 'builder.toml')))
  assert.equal(await readFile(path.join(homes.codex, 'AGENTS.md'), 'utf8'), '')
  assert.ok(!existsSync(path.join(homes.gemini, 'extensions', 'demo')))
})
