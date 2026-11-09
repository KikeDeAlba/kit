import { join, relative, resolve, isAbsolute } from 'node:path'

const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export function isConversationId(value: unknown): value is string {
  return typeof value === 'string' && CONVERSATION_ID.test(value)
}

export function confinedTranscript(home: string, file: string): string | null {
  const resolved = resolve(file)
  const name = resolved.slice(resolve(home, 'conversations').length + 1)
  if (!name.endsWith('.db')) return null
  const expected = conversationFile(home, name.slice(0, -3))
  return expected !== null && resolve(expected) === resolved ? expected : null
}

export function conversationFile(home: string, conversationId: string): string | null {
  if (!isConversationId(conversationId)) return null
  const dir = resolve(home, 'conversations')
  const file = resolve(dir, `${conversationId}.db`)
  const rel = relative(dir, file)
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel !== `${conversationId}.db`) return null
  return join(dir, `${conversationId}.db`)
}
