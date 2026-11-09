export const HARNESS_IDS = ['claude', 'opencode', 'codex', 'gemini', 'antigravity'] as const

export type HarnessId = (typeof HARNESS_IDS)[number]

export interface LaunchPlan {
  args: string[]
  warnings: string[]
}

export interface LaunchOptions {
  skipPermissions: boolean
  extraArgs: readonly string[]
}

export const DEFAULT_LAUNCH_OPTIONS: LaunchOptions = { skipPermissions: true, extraArgs: [] }

export interface TranscriptRef {
  harness: HarnessId
  sessionId: string | null
  transcriptPath: string | null
  cwd: string
  startedAt: string
  endedAt: string
  profile: string | null
}

export interface Turn {
  role: 'user' | 'assistant'
  text: string
}

export interface SessionNote {
  context: string
  done: string
  decisions: string | null
  findings: string | null
  verification: string | null
  pending: string | null
}

export interface SessionSummary {
  title: string
  kind: string | null
  note: SessionNote
}

export interface SummaryMeta {
  harness: HarnessId
  projectName: string | null
  repo: string | null
  branch: string | null
  cwd: string
  durationSeconds: number
  touchedFiles: readonly string[]
}

export interface SummaryInput {
  turns: readonly Turn[]
  meta: SummaryMeta
  kinds: readonly string[]
  model: string | null
  timeoutMs: number
  profile: string | null
  baseEnv?: NodeJS.ProcessEnv
}

export type SummaryResult = { ok: true; summary: SessionSummary } | { ok: false; error: string }

export interface ExitRef {
  cwd: string
  startedAt: string
  endedAt: string
}

export interface ExitSession {
  sessionId: string
  transcriptPath: string | null
}

export interface HarnessAdapter {
  readonly id: HarnessId
  readonly label: string
  readonly bin: string
  readonly defaultSummaryModel: string
  readonly profiles: boolean
  resolveBin(env?: NodeJS.ProcessEnv): string | null
  available(env?: NodeJS.ProcessEnv): boolean
  launchArgs(userArgs: readonly string[], options?: LaunchOptions): LaunchPlan
  extractTranscript(ref: TranscriptRef, baseEnv?: NodeJS.ProcessEnv): Promise<Turn[]>
  summarize(input: SummaryInput): Promise<SummaryResult>
  afterExit?(ref: ExitRef, env?: NodeJS.ProcessEnv): Promise<ExitSession | null>
}
