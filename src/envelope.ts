export const ENVELOPE_VERSION = 1

export interface EnvelopeError {
  code: string
  message: string
  hint?: string
  status?: number
  paths?: string[]
}

export interface Envelope<T = unknown> {
  schemaVersion: number
  ok: boolean
  command: string
  generatedAt: string
  meta?: Record<string, unknown>
  data?: T
  error?: EnvelopeError
}

export function successEnvelope<T>(schemaVersion: number, command: string, data: T, meta?: Record<string, unknown>): Envelope<T> {
  return {
    schemaVersion,
    ok: true,
    command,
    generatedAt: new Date().toISOString(),
    ...(meta ? { meta } : {}),
    data,
  }
}

export function errorEnvelope(
  schemaVersion: number,
  command: string,
  error: EnvelopeError,
  data?: unknown,
  meta?: Record<string, unknown>,
): Envelope<unknown> {
  return {
    schemaVersion,
    ok: false,
    command,
    generatedAt: new Date().toISOString(),
    ...(meta ? { meta } : {}),
    ...(data !== undefined ? { data } : {}),
    error,
  }
}

export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

export function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  if (typeof candidate['schemaVersion'] !== 'number') return false
  if (typeof candidate['ok'] !== 'boolean') return false
  if (typeof candidate['command'] !== 'string') return false
  if (typeof candidate['generatedAt'] !== 'string') return false
  if (candidate['ok'] === false) {
    const error = candidate['error'] as Record<string, unknown> | undefined
    if (typeof error !== 'object' || error === null) return false
    if (typeof error['code'] !== 'string' || typeof error['message'] !== 'string') return false
  }
  return true
}

export function parseEnvelope(stdout: string): Envelope | null {
  const lines = stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (line === undefined || !line.startsWith('{')) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (isEnvelope(parsed)) return parsed
    } catch {
      continue
    }
  }
  return null
}
