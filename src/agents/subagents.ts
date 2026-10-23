import { parseFrontmatter, renderForAgent } from './markdown.ts'
import type { AgentName, MemoryAgent } from './types.ts'

export interface Subagent {
  name: string
  description: string
  tools: string[] | null
  model: string | null
  effort: string | null
  maxTurns: number | null
  body: string
}

export function parseSubagent(markdown: string, agent: AgentName, fallbackName: string): Subagent {
  const { attributes, body } = parseFrontmatter(renderForAgent(markdown, agent))
  const tools = attributes['tools']
  const turns = Number.parseInt(attributes['maxTurns'] ?? '', 10)
  return {
    name: attributes['name'] || fallbackName,
    description: attributes['description'] ?? '',
    tools: tools ? tools.split(',').map((tool) => tool.trim()).filter((tool) => tool.length > 0) : null,
    model: attributes['model'] || null,
    effort: attributes['effort'] || null,
    maxTurns: Number.isFinite(turns) && turns > 0 ? turns : null,
    body,
  }
}

const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

function allows(agent: Subagent, ...tools: string[]): boolean {
  return agent.tools === null || agent.tools.includes('*') || tools.some((tool) => agent.tools?.includes(tool))
}

export function subagentForOpenCode(markdown: string, fallbackName: string): string {
  const agent = parseSubagent(markdown, 'opencode', fallbackName)
  const header = ['---', `description: ${JSON.stringify(agent.description)}`, 'mode: subagent']
  if (agent.maxTurns !== null) header.push(`steps: ${agent.maxTurns}`)
  const denied = [
    ...(allows(agent, ...WRITE_TOOLS) ? [] : ['edit']),
    ...(allows(agent, 'Bash') ? [] : ['bash']),
    ...(allows(agent, 'WebFetch') ? [] : ['webfetch']),
    ...(allows(agent, 'WebSearch') ? [] : ['websearch']),
  ]
  if (denied.length > 0) header.push('permission:', ...denied.map((key) => `  ${key}: deny`))
  header.push('---')
  return `${header.join('\n')}\n${agent.body}`
}

const CODEX_EFFORT: Record<string, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' }

function tomlText(value: string): string {
  return value.includes("'''") ? JSON.stringify(value) : `'''\n${value.replace(/\n?$/, '\n')}'''`
}

export function subagentForCodex(markdown: string, fallbackName: string): string {
  const agent = parseSubagent(markdown, 'codex', fallbackName)
  const lines = [`name = ${JSON.stringify(agent.name)}`, `description = ${JSON.stringify(agent.description)}`]
  const effort = agent.effort ? CODEX_EFFORT[agent.effort] : undefined
  if (effort) lines.push(`model_reasoning_effort = ${JSON.stringify(effort)}`)
  lines.push(`developer_instructions = ${tomlText(agent.body)}`)
  if (!allows(agent, 'Bash')) lines.push('', '[features]', 'shell_tool = false')
  return `${lines.join('\n')}\n`
}

const GEMINI_TOOLS: Record<string, string[]> = {
  Read: ['read_file', 'read_many_files', 'list_directory'],
  Grep: ['grep_search'],
  Glob: ['glob'],
  Edit: ['replace'],
  MultiEdit: ['replace'],
  Write: ['write_file'],
  Bash: ['run_shell_command'],
  WebFetch: ['web_fetch'],
  WebSearch: ['google_web_search'],
  Skill: ['activate_skill'],
}

export function subagentForGemini(markdown: string, fallbackName: string): string {
  const agent = parseSubagent(markdown, 'gemini', fallbackName)
  const header = ['---', `name: ${agent.name}`, `description: ${JSON.stringify(agent.description)}`, 'kind: local']
  if (agent.tools !== null && !agent.tools.includes('*')) {
    const tools = [...new Set(agent.tools.flatMap((tool) => GEMINI_TOOLS[tool] ?? []))]
    if (tools.length > 0) header.push('tools:', ...tools.map((tool) => `  - ${tool}`))
  }
  if (agent.maxTurns !== null) header.push(`max_turns: ${agent.maxTurns}`)
  header.push('---')
  return `${header.join('\n')}\n${agent.body}`
}

const ANTIGRAVITY_TOOLS: Record<string, string[]> = {
  Read: ['view_file', 'list_dir'],
  Grep: ['grep_search'],
  Glob: ['find_by_name'],
  LS: ['list_dir'],
  Bash: ['run_command'],
  Edit: ['replace_file_content'],
  MultiEdit: ['multi_replace_file_content'],
  Write: ['write_to_file'],
  WebFetch: ['read_url_content'],
  WebSearch: ['search_web'],
}

const ANTIGRAVITY_ORDER = [
  'view_file',
  'list_dir',
  'grep_search',
  'find_by_name',
  'run_command',
  'replace_file_content',
  'multi_replace_file_content',
  'write_to_file',
  'read_url_content',
  'search_web',
]

export function subagentForAntigravity(markdown: string, fallbackName: string): string {
  const agent = parseSubagent(markdown, 'antigravity', fallbackName)
  const header = ['---', `name: ${agent.name}`, `description: ${JSON.stringify(agent.description)}`]
  let tools = ANTIGRAVITY_ORDER
  if (agent.tools !== null && agent.tools.length > 0 && !agent.tools.includes('*')) {
    const mapped = new Set(agent.tools.flatMap((tool) => ANTIGRAVITY_TOOLS[tool] ?? []))
    tools = ANTIGRAVITY_ORDER.filter((tool) => mapped.has(tool))
    if (tools.length === 0) throw new Error(`subagent ${agent.name}: none of its tools (${agent.tools.join(', ')}) exist in antigravity`)
  }
  header.push(`tools: [${tools.join(', ')}]`)
  header.push('model: inherit', '---')
  return `${header.join('\n')}\n${agent.body}`
}

export const MEMORY_FILES: Record<MemoryAgent, string> = {
  claude: 'CLAUDE.md',
  opencode: 'AGENTS.md',
  codex: 'AGENTS.md',
  gemini: 'GEMINI.md',
  antigravity: 'GEMINI.md',
}

export function renderMemory(text: string, agent: MemoryAgent): string {
  return renderForAgent(text, agent === 'antigravity' ? 'gemini' : agent)
}

function markers(tool: string): { begin: string; end: string } {
  return { begin: `<!-- kit:${tool}:begin -->`, end: `<!-- kit:${tool}:end -->` }
}

function blockRange(text: string, tool: string): { start: number; stop: number } | null {
  const { begin, end } = markers(tool)
  const start = text.indexOf(begin)
  if (start === -1) return null
  const close = text.indexOf(end, start)
  if (close === -1) return null
  return { start, stop: close + end.length }
}

export function memoryBlock(text: string, tool: string): string | null {
  const range = blockRange(text, tool)
  if (!range) return null
  const { begin, end } = markers(tool)
  return text.slice(range.start + begin.length, range.stop - end.length).trim()
}

export function upsertMemoryBlock(text: string, tool: string, content: string): string {
  const { begin, end } = markers(tool)
  const block = `${begin}\n${content.trim()}\n${end}`
  const range = blockRange(text, tool)
  if (range) return `${text.slice(0, range.start)}${block}${text.slice(range.stop)}`
  const base = text.replace(/\s*$/, '')
  return base.length > 0 ? `${base}\n\n${block}\n` : `${block}\n`
}

export function removeMemoryBlock(text: string, tool: string): { text: string; removed: boolean } {
  const range = blockRange(text, tool)
  if (!range) return { text, removed: false }
  const joined = `${text.slice(0, range.start).replace(/\s*$/, '')}\n\n${text.slice(range.stop).replace(/^\s*/, '')}`
  const cleaned = joined.trim()
  return { text: cleaned.length > 0 ? `${cleaned}\n` : '', removed: true }
}
