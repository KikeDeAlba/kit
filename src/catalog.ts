export const CATALOG_VERSION = 1

export const CATALOG_TOOL_NAMES = ['kit', 'nursery', 'bita', 'gaze', 'inkwell', 'recap', 'tally', 'atl'] as const
export type CatalogToolName = (typeof CATALOG_TOOL_NAMES)[number]

export interface CatalogTool {
  name: CatalogToolName
  package: string
  bin: string
  description: string
  homepage: string
  setup: readonly string[]
  uninstall: readonly string[]
  agentsFlag: boolean
  optional: boolean
}

export const CATALOG: readonly CatalogTool[] = [
  {
    name: 'kit',
    package: '@kikedealba/kit',
    bin: 'kit',
    description: 'Shared contract: tool registry, JSON envelope, events, agent integrations, profiles and settings',
    homepage: 'https://github.com/KikeDeAlba/kit',
    setup: [],
    uninstall: [],
    agentsFlag: false,
    optional: false,
  },
  {
    name: 'nursery',
    package: '@kikedealba/nursery',
    bin: 'nursery',
    description: 'Specialist subagents and shared working rules for coding agents',
    homepage: 'https://github.com/KikeDeAlba/nursery',
    setup: ['setup'],
    uninstall: ['uninstall'],
    agentsFlag: true,
    optional: true,
  },
  {
    name: 'bita',
    package: '@kikedealba/bita',
    bin: 'bita',
    description: 'Local time tracker: timers, entries, projects and agent sessions',
    homepage: 'https://github.com/KikeDeAlba/bita-cli',
    setup: ['setup'],
    uninstall: [],
    agentsFlag: true,
    optional: true,
  },
  {
    name: 'gaze',
    package: '@kikedealba/gaze',
    bin: 'gaze',
    description: 'Per-project brain for coding agents with hybrid vector search',
    homepage: 'https://github.com/KikeDeAlba/gaze',
    setup: ['setup'],
    uninstall: ['uninstall'],
    agentsFlag: true,
    optional: true,
  },
  {
    name: 'inkwell',
    package: '@kikedealba/inkwell',
    bin: 'inkwell',
    description: 'Living technical documentation: pages, entry notes, backlog, diagrams and Confluence sync',
    homepage: 'https://github.com/KikeDeAlba/inkwell',
    setup: ['setup'],
    uninstall: ['uninstall'],
    agentsFlag: true,
    optional: true,
  },
  {
    name: 'recap',
    package: '@kikedealba/recap',
    bin: 'recap',
    description: 'Meeting recorder: local transcription and minutes',
    homepage: 'https://github.com/KikeDeAlba/recap',
    setup: ['setup'],
    uninstall: [],
    agentsFlag: true,
    optional: true,
  },
  {
    name: 'tally',
    package: '@kikedealba/tally',
    bin: 'tally',
    description: 'Groups bita time into Jira-ready work logs',
    homepage: 'https://github.com/KikeDeAlba/tally',
    setup: ['setup'],
    uninstall: ['uninstall'],
    agentsFlag: true,
    optional: true,
  },
  {
    name: 'atl',
    package: '@kikedealba/atl',
    bin: 'atl',
    description: 'Atlassian CLI and MCP server for Jira and Confluence Cloud',
    homepage: 'https://github.com/KikeDeAlba/atl',
    setup: ['setup'],
    uninstall: ['uninstall'],
    agentsFlag: true,
    optional: true,
  },
]

export const DEN_APP = { name: 'den', releases: 'https://github.com/KikeDeAlba/den/releases/latest' } as const

export function isCatalogToolName(value: unknown): value is CatalogToolName {
  return typeof value === 'string' && (CATALOG_TOOL_NAMES as readonly string[]).includes(value)
}

export function catalogTool(name: string): CatalogTool | null {
  return CATALOG.find((tool) => tool.name === name) ?? null
}

export function catalogDocument(): { version: typeof CATALOG_VERSION; tools: readonly CatalogTool[]; denApp: typeof DEN_APP } {
  return { version: CATALOG_VERSION, tools: CATALOG, denApp: DEN_APP }
}
