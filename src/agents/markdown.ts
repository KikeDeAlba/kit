import type { AgentName } from './types.ts'

const OPEN = /^:::\s*agent\s+(.+?)\s*$/
const CLOSE = /^:::\s*$/

export function hasAgentBlocks(text: string): boolean {
  return text.split('\n').some((line) => OPEN.test(line))
}

export function renderForAgent(text: string, agent: AgentName): string {
  const output: string[] = []
  let keep: boolean | null = null
  for (const line of text.split('\n')) {
    const open = OPEN.exec(line)
    if (open && keep === null) {
      const targets = (open[1] ?? '').split(/[\s,]+/).filter((name) => name.length > 0)
      const negated = targets.filter((name) => name.startsWith('!')).map((name) => name.slice(1))
      const positive = targets.filter((name) => !name.startsWith('!'))
      keep = positive.length > 0 ? positive.includes(agent) : !negated.includes(agent)
      if (negated.length > 0 && negated.includes(agent)) keep = false
      continue
    }
    if (keep !== null && CLOSE.test(line)) {
      keep = null
      continue
    }
    if (keep === false) continue
    output.push(line)
  }
  return output.join('\n').replace(/\n{3,}/g, '\n\n')
}

export interface Frontmatter {
  attributes: Record<string, string>
  body: string
}

export function parseFrontmatter(text: string): Frontmatter {
  if (!text.startsWith('---\n')) return { attributes: {}, body: text }
  const end = text.indexOf('\n---', 4)
  if (end === -1) return { attributes: {}, body: text }
  const attributes: Record<string, string> = {}
  for (const line of text.slice(4, end).split('\n')) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!match) continue
    attributes[match[1] ?? ''] = (match[2] ?? '').replace(/^["']|["']$/g, '')
  }
  const rest = text.slice(end + 4)
  return { attributes, body: rest.startsWith('\n') ? rest.slice(1) : rest }
}

function tomlMultiline(value: string): string {
  if (!value.includes("'''")) return `'''\n${value}'''`
  return JSON.stringify(value)
}

export function commandToGeminiToml(markdown: string): string {
  const { attributes, body } = parseFrontmatter(renderForAgent(markdown, 'gemini'))
  const prompt = body.replace(/\$ARGUMENTS/g, '{{args}}').replace(/\n?$/, '\n')
  const lines: string[] = []
  if (attributes['description']) lines.push(`description = ${JSON.stringify(attributes['description'])}`)
  lines.push(`prompt = ${tomlMultiline(prompt)}`)
  return `${lines.join('\n')}\n`
}

export function commandForCodex(markdown: string): string {
  const { attributes, body } = parseFrontmatter(renderForAgent(markdown, 'codex'))
  const header = ['---']
  if (attributes['description']) header.push(`description: ${JSON.stringify(attributes['description'])}`)
  if (attributes['argument-hint']) header.push(`argument-hint: ${JSON.stringify(attributes['argument-hint'])}`)
  header.push('---')
  return `${header.join('\n')}\n${body}`
}
