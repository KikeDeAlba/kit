import { existsSync } from 'node:fs'
import { chmod, copyFile, cp, lstat, mkdir, readdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { HookGroup, HookMap } from './types.ts'

export async function linkPath(target: string, linkName: string, platform: NodeJS.Platform = process.platform): Promise<'installed' | 'present'> {
  await mkdir(path.dirname(linkName), { recursive: true })
  const isDir = (await lstat(target)).isDirectory()
  const info = await lstat(linkName).catch(() => null)
  if (info?.isSymbolicLink()) {
    if (path.resolve(path.dirname(linkName), await readlink(linkName)) === path.resolve(target)) return 'present'
    await rm(linkName, { force: true })
  } else if (info) {
    await rm(`${linkName}.backup`, { recursive: true, force: true })
    await rename(linkName, `${linkName}.backup`)
  }
  if (platform === 'win32') {
    if (isDir) await symlink(target, linkName, 'junction')
    else await copyFile(target, linkName)
  } else {
    await symlink(target, linkName)
  }
  return 'installed'
}

export async function copyInto(source: string, destination: string): Promise<void> {
  await rm(destination, { recursive: true, force: true })
  await mkdir(path.dirname(destination), { recursive: true })
  await cp(source, destination, { recursive: true, dereference: true })
}

export async function removeOwnedLink(linkName: string, target?: string): Promise<boolean> {
  try {
    const info = await lstat(linkName)
    if (info.isSymbolicLink()) {
      if (target && path.resolve(path.dirname(linkName), await readlink(linkName)) !== path.resolve(target)) return false
      await rm(linkName, { force: true })
      return true
    }
    if (!target) {
      await rm(linkName, { recursive: true, force: true })
      return true
    }
    return false
  } catch {
    return false
  }
}

export async function readJsonFile(file: string): Promise<{ value: Record<string, unknown>; existed: boolean } | { error: string }> {
  if (!existsSync(file)) return { value: {}, existed: false }
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { error: `${file} is not a JSON object` }
    return { value: parsed as Record<string, unknown>, existed: true }
  } catch (error) {
    return { error: `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export async function writeJsonFile(file: string, value: unknown, backup: boolean, options: { mode?: number } = {}): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  if (backup && existsSync(file)) await copyFile(file, `${file}.backup`)
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, options.mode === undefined ? {} : { mode: options.mode })
  if (options.mode !== undefined) await chmod(temporary, options.mode)
  await rename(temporary, file)
}

function commandsOf(group: HookGroup): string[] {
  return (group.hooks ?? []).map((hook) => hook.command)
}

export function mergeHooks(existing: unknown, wanted: HookMap): { hooks: Record<string, HookGroup[]>; added: string[] } {
  const hooks: Record<string, HookGroup[]> = typeof existing === 'object' && existing !== null ? { ...(existing as Record<string, HookGroup[]>) } : {}
  const added: string[] = []
  for (const [event, groups] of Object.entries(wanted)) {
    const current = Array.isArray(hooks[event]) ? [...hooks[event]] : []
    for (const group of groups) {
      const present = commandsOf(group).every((command) => current.some((entry) => commandsOf(entry).includes(command)))
      if (present) continue
      current.push(group)
      added.push(`${event}: ${commandsOf(group).join(', ')}`)
    }
    hooks[event] = current
  }
  return { hooks, added }
}

export function stripHooks(existing: unknown, wanted: HookMap): { hooks: Record<string, HookGroup[]>; removed: number } {
  const hooks: Record<string, HookGroup[]> = typeof existing === 'object' && existing !== null ? { ...(existing as Record<string, HookGroup[]>) } : {}
  const commands = new Set(Object.values(wanted).flatMap((groups) => groups.flatMap(commandsOf)))
  let removed = 0
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue
    const kept = groups.filter((group) => {
      const owned = commandsOf(group).length > 0 && commandsOf(group).every((command) => commands.has(command))
      if (owned) removed += 1
      return !owned
    })
    if (kept.length === 0) delete hooks[event]
    else hooks[event] = kept
  }
  return { hooks, removed }
}

export function tomlString(value: string): string {
  return JSON.stringify(value)
}

export function tomlTableBlock(header: string, entries: Record<string, string | string[] | Record<string, string>>): string {
  const lines = [`[${header}]`]
  const nested: string[] = []
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value === 'string') lines.push(`${key} = ${tomlString(value)}`)
    else if (Array.isArray(value)) lines.push(`${key} = [${value.map(tomlString).join(', ')}]`)
    else {
      nested.push('', `[${header}.${key}]`)
      for (const [inner, innerValue] of Object.entries(value)) nested.push(`${tomlString(inner)} = ${tomlString(innerValue)}`)
    }
  }
  return `${[...lines, ...nested].join('\n')}\n`
}

export function hasTomlTable(text: string, header: string): boolean {
  const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^\\s*\\[${escaped}(?:\\.[^\\]]+)?\\]\\s*$`, 'm').test(text)
}

export function removeTomlTable(text: string, header: string): { text: string; removed: boolean } {
  const lines = text.split('\n')
  const kept: string[] = []
  let skipping = false
  let removed = false
  const own = (line: string) => {
    const match = /^\s*\[([^\]]+)\]\s*$/.exec(line)
    if (!match) return null
    const name = match[1] ?? ''
    return name === header || name.startsWith(`${header}.`)
  }
  for (const line of lines) {
    const ownership = own(line)
    if (ownership === true) {
      skipping = true
      removed = true
      continue
    }
    if (ownership === false) skipping = false
    if (!skipping) kept.push(line)
  }
  return { text: kept.join('\n').replace(/\n{3,}/g, '\n\n'), removed }
}

async function treeEntries(root: string): Promise<Map<string, Buffer | null>> {
  const entries = new Map<string, Buffer | null>()
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const relative = path.relative(root, full)
      if (entry.isDirectory()) {
        entries.set(relative, null)
        await walk(full)
      } else {
        entries.set(relative, await readFile(full))
      }
    }
  }
  await walk(root)
  return entries
}

export async function sameTree(left: string, right: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([treeEntries(left), treeEntries(right)])
    if (a.size !== b.size) return false
    for (const [name, content] of a) {
      if (!b.has(name)) return false
      const other = b.get(name) ?? null
      if (content === null || other === null) {
        if (content !== other) return false
      } else if (!content.equals(other)) {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}
