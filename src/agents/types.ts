import type { PlatformContext } from '../platform.ts'

export const AGENTS = ['claude', 'opencode', 'codex', 'gemini'] as const
export type AgentName = (typeof AGENTS)[number]

export interface HookCommand {
  type: 'command'
  command: string
  timeout?: number
  name?: string
}

export interface HookGroup {
  matcher?: string
  hooks: HookCommand[]
}

export type HookMap = Record<string, HookGroup[]>

export type McpServer =
  | { name: string; command: string[]; env?: Record<string, string> }
  | { name: string; url: string; headers?: Record<string, string> }

export interface SkillSource {
  name: string
  dir: string
}

export interface CommandSource {
  name: string
  file: string
}

export interface AgentIntegration {
  tool: string
  version: string
  description?: string
  skills?: SkillSource[]
  userSkills?: SkillSource[]
  commands?: CommandSource[]
  mcp?: McpServer[]
  claude?: { permissions?: { allow?: string[]; ask?: string[] }; hooks?: HookMap }
  opencode?: { plugins?: CommandSource[] }
  codex?: { hooks?: HookMap }
  gemini?: { hooks?: HookMap; contextFile?: string }
}

export type StepState = 'installed' | 'present' | 'removed' | 'skipped' | 'unavailable' | 'failed'

export interface Step {
  agent: AgentName
  item: string
  state: StepState
  detail: string
  path?: string
}

export interface AgentHomes {
  claude: string
  opencode: string
  codex: string
  agentsSkills: string
  gemini: string
}

export interface InstallOptions {
  agents?: readonly AgentName[] | 'detected' | 'all'
  ctx?: PlatformContext
  homes?: Partial<AgentHomes>
  exec?: (command: string, args: readonly string[]) => Promise<void | string>
  locate?: (command: string) => Promise<string | null>
  skipMcp?: boolean
  skipHooks?: boolean
  claudeCompat?: 'auto' | boolean
}

export interface ClaudePluginSpec {
  marketplace: string
  marketplaceName: string
  plugin: string
  scope?: 'user' | 'project' | 'local'
}

export const EDIT_TOOL_MATCHERS: Record<AgentName, string> = {
  claude: 'Edit|Write|MultiEdit',
  codex: 'apply_patch|Edit|Write',
  opencode: 'edit|write|patch',
  gemini: 'write_file|replace',
}
