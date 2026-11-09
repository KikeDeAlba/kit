export const ANTIGRAVITY_CONVERSATION_ENV = 'ANTIGRAVITY_CONVERSATION_ID'

export const HARNESS_SESSION_ENV: readonly string[] = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
  'CODEX_THREAD_ID',
  'CODEX_SESSION_ID',
  'GEMINI_CLI',
  'GEMINI_SESSION_ID',
  'GEMINI_PROJECT_DIR',
  'OPENCODE',
  'OPENCODE_SESSION_ID',
]

export const ANTIGRAVITY_SESSION_ENV: readonly string[] = [
  'ANTIGRAVITY_CONVERSATION_ID',
  'ANTIGRAVITY_TRAJECTORY_ID',
  'ANTIGRAVITY_AGENT',
  'ANTIGRAVITY_PROJECT_ID',
  'ANTIGRAVITY_LS_ADDRESS',
  'ANTIGRAVITY_CSRF_TOKEN',
  'ANTIGRAVITY_SOURCE_METADATA',
  'ANTIGRAVITY_AGENTAPI_EXE',
  'ANTIGRAVITY_LS_VERSION',
  'ANTIGRAVITY_APP_DATA_DIR',
]

export function withoutHarnessSession(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {}
  const names = new Set([...HARNESS_SESSION_ENV, ...ANTIGRAVITY_SESSION_ENV].map((name) => name.toUpperCase()))
  for (const [key, value] of Object.entries(env)) {
    if (names.has(key.toUpperCase())) continue
    next[key] = value
  }
  return next
}
