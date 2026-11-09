import type { SessionNote, SummaryInput, SummaryResult, Turn } from './types.ts'

const nullableString = { type: ['string', 'null'] } as const

export const SESSION_SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'kind', 'note'],
  properties: {
    title: { type: 'string' },
    kind: nullableString,
    note: {
      type: 'object',
      additionalProperties: false,
      required: ['context', 'done', 'decisions', 'findings', 'verification', 'pending'],
      properties: {
        context: { type: 'string' },
        done: { type: 'string' },
        decisions: nullableString,
        findings: nullableString,
        verification: nullableString,
        pending: nullableString,
      },
    },
  },
} as const

export const TRANSCRIPT_MAX_CHARS = 60_000
const TURN_MAX_CHARS = 4_000
const HEAD_CHARS = 8_000
const CUT_MARKER = '\n\n[… recortado …]\n\n'
const TITLE_MAX = 100
const TITLE_MIN = 3

const ROLE_HEADINGS: Record<Turn['role'], string> = { user: 'Usuario', assistant: 'Asistente' }

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

export function renderTranscript(turns: readonly Turn[], max: number = TRANSCRIPT_MAX_CHARS): string {
  const full = turns.map((turn) => `### ${ROLE_HEADINGS[turn.role]}\n${clip(turn.text.trim(), TURN_MAX_CHARS)}`).join('\n\n')
  if (full.length <= max) return full
  const head = full.slice(0, Math.min(HEAD_CHARS, max))
  const tailLength = Math.max(0, max - head.length - CUT_MARKER.length)
  return `${head}${CUT_MARKER}${tailLength > 0 ? full.slice(full.length - tailLength) : ''}`
}

export function summaryInstructions(input: Pick<SummaryInput, 'kinds'>): string {
  const kinds = input.kinds.length > 0 ? input.kinds.map((kind) => `"${kind}"`).join(', ') : '(ninguno: usa null)'
  return [
    'Eres un asistente que resume sesiones de trabajo con un agente de código para un registro de tiempo.',
    'Lee los metadatos y la transcripción que vienen después y devuelve SOLO un objeto JSON, sin texto alrededor ni bloques de código, con esta forma exacta:',
    '{"title": string, "kind": string | null, "note": {"context": string, "done": string, "decisions": string | null, "findings": string | null, "verification": string | null, "pending": string | null}}',
    'Reglas:',
    '- "title": en español, de 80 caracteres o menos, concreto, en infinitivo o sustantivo (por ejemplo "Agregar wrapper de sesión a bita"), sin comillas ni punto final.',
    `- "kind": uno de estos valores exactos o null si ninguno encaja: ${kinds}.`,
    '- "note.context": por qué se trabajó en esto, en una o dos frases.',
    '- "note.done": qué se hizo, en markdown breve (viñetas).',
    '- "note.decisions", "note.findings", "note.verification" y "note.pending": markdown breve, o null si la transcripción no dice nada al respecto.',
    '- Escribe en español y no inventes nada que no esté en la transcripción.',
  ].join('\n')
}

function formatDuration(seconds: number): string {
  const minutes = Math.max(0, Math.round(seconds / 60))
  const hours = Math.floor(minutes / 60)
  return hours > 0 ? `${hours} h ${minutes % 60} min` : `${minutes} min`
}

export function summaryContext(input: Pick<SummaryInput, 'meta' | 'turns'>, max: number = TRANSCRIPT_MAX_CHARS): string {
  const { meta } = input
  const files = meta.touchedFiles.slice(0, 50)
  const lines = [
    '## Metadatos',
    `- Harness: ${meta.harness}`,
    `- Proyecto: ${meta.projectName ?? '(sin proyecto)'}`,
    `- Repositorio: ${meta.repo ?? '(desconocido)'}`,
    `- Rama: ${meta.branch ?? '(desconocida)'}`,
    `- Directorio: ${meta.cwd}`,
    `- Duración: ${formatDuration(meta.durationSeconds)}`,
    `- Archivos tocados: ${files.length > 0 ? files.join(', ') : '(ninguno registrado)'}`,
    '',
    '## Transcripción',
    renderTranscript(input.turns, max),
  ]
  return lines.join('\n')
}

export function buildSummaryPrompt(input: SummaryInput): string {
  return `${summaryInstructions(input)}\n\n${summaryContext(input)}`
}

export function retryInstructions(input: Pick<SummaryInput, 'kinds'>, error: string): string {
  return `${summaryInstructions(input)}\n\nTu respuesta anterior no pasó la validación (${error}). Devuelve solo el objeto JSON válido con la forma indicada.`
}

export function parseJsonLoose(text: string): unknown {
  const unfenced = text.replace(/```(?:json)?/gi, '')
  const start = unfenced.indexOf('{')
  const end = unfenced.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(unfenced.slice(start, end + 1)) as unknown
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cleanTitle(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'`«“”‘’»]+|["'`«“”‘’»]+$/g, '')
    .trim()
    .slice(0, TITLE_MAX)
    .trim()
}

function optionalText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error(`note.${field} must be a string or null`)
  const text = value.trim()
  return text.length > 0 ? text : null
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`note.${field} must be a non-empty string`)
  return value.trim()
}

export function validateSessionSummary(raw: unknown, kinds: readonly string[]): SummaryResult {
  if (!isRecord(raw)) return { ok: false, error: 'summary is not a JSON object' }
  if (typeof raw['title'] !== 'string') return { ok: false, error: 'title must be a string' }
  const title = cleanTitle(raw['title'])
  if (title.length < TITLE_MIN) return { ok: false, error: `title must have at least ${TITLE_MIN} characters` }
  const rawKind = raw['kind']
  const kind = typeof rawKind === 'string' && kinds.includes(rawKind.trim()) ? rawKind.trim() : null
  const note = raw['note']
  if (!isRecord(note)) return { ok: false, error: 'note must be an object' }
  try {
    const parsed: SessionNote = {
      context: requiredText(note['context'], 'context'),
      done: requiredText(note['done'], 'done'),
      decisions: optionalText(note['decisions'], 'decisions'),
      findings: optionalText(note['findings'], 'findings'),
      verification: optionalText(note['verification'], 'verification'),
      pending: optionalText(note['pending'], 'pending'),
    }
    return { ok: true, summary: { title, kind, note: parsed } }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
