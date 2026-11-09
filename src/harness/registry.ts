import { antigravityAdapter } from './antigravity.ts'
import { claudeAdapter } from './claude.ts'
import { codexAdapter } from './codex.ts'
import { geminiAdapter } from './gemini.ts'
import { opencodeAdapter } from './opencode.ts'
import { HARNESS_IDS, type HarnessAdapter, type HarnessId } from './types.ts'

export function listAdapters(): readonly HarnessAdapter[] {
  return [claudeAdapter, opencodeAdapter, codexAdapter, geminiAdapter, antigravityAdapter]
}

export function getAdapter(id: HarnessId): HarnessAdapter {
  const adapter = listAdapters().find((candidate) => candidate.id === id)
  if (!adapter) throw new Error(`unknown harness: ${id}`)
  return adapter
}

export function isHarnessId(value: unknown): value is HarnessId {
  return typeof value === 'string' && (HARNESS_IDS as readonly string[]).includes(value)
}

export function harnessBinEnvVar(id: HarnessId): string {
  return `BITA_HARNESS_BIN_${id.toUpperCase()}`
}

export function kitHarnessBinEnvVar(id: HarnessId): string {
  return `KIT_HARNESS_BIN_${id.toUpperCase()}`
}

export function harnessBinEnvVars(id: HarnessId): readonly string[] {
  return [kitHarnessBinEnvVar(id), harnessBinEnvVar(id)]
}
