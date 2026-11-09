import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { Turn } from './types.ts'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export const SESSION_ID_PATTERN = /^\w[\w-]*$/

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value)
}

export async function confinedFile(file: string, root: string): Promise<string | null> {
  try {
    const [real, base] = await Promise.all([realpath(file), realpath(root)])
    const rel = relative(base, real)
    if (rel.length === 0 || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
    return real
  } catch {
    return null
  }
}

export async function readTextFile(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

export function parseJsonLines(text: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line) as unknown
      if (isRecord(value)) records.push(value)
    } catch {}
  }
  return records
}

export function textOfBlocks(content: unknown, accept: (block: Record<string, unknown>) => boolean): string {
  if (typeof content === 'string') return content
  if (isRecord(content) && typeof content['text'] === 'string') return accept(content) ? content['text'] : ''
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is Record<string, unknown> => isRecord(block) && typeof block['text'] === 'string' && accept(block))
    .map((block) => block['text'] as string)
    .join('\n')
}

export function pushTurn(turns: Turn[], role: Turn['role'], text: string): void {
  const trimmed = text.trim()
  if (!trimmed) return
  const last = turns[turns.length - 1]
  if (last && last.role === role) last.text = `${last.text}\n\n${trimmed}`
  else turns.push({ role, text: trimmed })
}

export function startsWithAny(text: string, prefixes: readonly string[]): boolean {
  const head = text.trimStart()
  return prefixes.some((prefix) => head.startsWith(prefix))
}

export async function walkFiles(root: string, accept: (name: string) => boolean, depth = 6): Promise<string[]> {
  const found: string[] = []
  const visit = async (dir: string, remaining: number): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (remaining > 0) await visit(full, remaining - 1)
      } else if (entry.isFile() && accept(entry.name)) found.push(full)
    }
  }
  await visit(root, depth)
  return found
}

export async function mtimeMs(file: string): Promise<number | null> {
  try {
    return (await stat(file)).mtimeMs
  } catch {
    return null
  }
}
