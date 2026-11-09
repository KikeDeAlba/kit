import type { LaunchPlan } from './types.ts'

export const CLAUDE_SKIP_PERMISSION_FLAGS = ['--allow-dangerously-skip-permissions', '--dangerously-skip-permissions'] as const

const VALUE_FLAGS = new Set([
  '--add-dir',
  '--agent',
  '--agents',
  '--allowedTools',
  '--allowed-tools',
  '--append-system-prompt',
  '--append-system-prompt-file',
  '--autocompact',
  '--betas',
  '--debug-file',
  '--disallowedTools',
  '--disallowed-tools',
  '--effort',
  '--environment',
  '--fallback-model',
  '--file',
  '--input-format',
  '--json-schema',
  '--max-budget-usd',
  '--mcp-config',
  '--model',
  '-n',
  '--name',
  '--output-format',
  '--permission-mode',
  '--permission-prompts',
  '--plugin-dir',
  '--plugin-url',
  '--remote-control-session-name-prefix',
  '--resume',
  '--session-id',
  '--setting-sources',
  '--settings',
  '--system-prompt',
  '--system-prompt-file',
  '--system-prompt-snapshot',
  '--tools',
])

export type ResumeIntent = { kind: 'none' } | { kind: 'continue' } | { kind: 'resume'; id: string | null }

export interface ParsedClaudeArgs {
  resume: ResumeIntent
  skipPermissions: boolean
  prompt: string | null
  extra: string[]
  extraFlags: string[]
}

function flagName(token: string): string {
  const eq = token.indexOf('=')
  return token.startsWith('--') && eq > 0 ? token.slice(0, eq) : token
}

export function parseClaudeArgs(args: readonly string[], keep: (token: string) => boolean = () => false): ParsedClaudeArgs {
  const positionals: string[] = []
  const extra: string[] = []
  const extraFlags: string[] = []
  let resume: ResumeIntent = { kind: 'none' }
  let skipPermissions = false
  for (let i = 0; i < args.length; i++) {
    const token = args[i] as string
    if (token === '--') {
      positionals.push(...args.slice(i + 1))
      break
    }
    if (!token.startsWith('-') || token === '-') {
      positionals.push(token)
      continue
    }
    const name = flagName(token)
    if ((CLAUDE_SKIP_PERMISSION_FLAGS as readonly string[]).includes(name)) {
      skipPermissions = true
      continue
    }
    if (keep(token)) {
      extra.push(token)
      continue
    }
    if (name === '-c' || name === '--continue') {
      if (resume.kind === 'none') resume = { kind: 'continue' }
      continue
    }
    if (name === '-r' || name === '--resume') {
      let id: string | null = null
      if (name !== token) id = token.slice(name.length + 1) || null
      else {
        const next = args[i + 1]
        if (next !== undefined && !next.startsWith('-')) {
          id = next
          i++
        }
      }
      if (resume.kind === 'none') resume = { kind: 'resume', id }
      continue
    }
    extraFlags.push(name)
    if (name === token && VALUE_FLAGS.has(name) && args[i + 1] !== undefined) i++
  }
  const prompt = positionals.length > 0 ? positionals.join(' ') : null
  return { resume, skipPermissions, prompt, extra, extraFlags }
}

export function droppedWarning(label: string, flag: string): string {
  return `${label} has no equivalent for ${flag}; dropped.`
}

export function withDefaultFlag(defaultFlag: string, args: readonly string[], absorbs: (token: string) => boolean): LaunchPlan {
  const cut = args.indexOf('--')
  const hasFlag = (cut < 0 ? args : args.slice(0, cut)).some(absorbs)
  return { args: hasFlag ? [...args] : [defaultFlag, ...args], warnings: [] }
}
