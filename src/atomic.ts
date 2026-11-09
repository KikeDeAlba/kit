import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, readlink, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const MAX_LINK_HOPS = 40

async function followDanglingLink(file: string): Promise<string> {
  let current = file
  for (let hop = 0; hop < MAX_LINK_HOPS; hop++) {
    const info = await lstat(current).catch(() => null)
    if (!info?.isSymbolicLink()) return current
    current = path.resolve(path.dirname(current), await readlink(current))
  }
  throw Object.assign(new Error(`too many symbolic links resolving ${file}`), { code: 'ELOOP' })
}

export async function resolveWriteTarget(file: string): Promise<string> {
  try {
    return await realpath(file)
  } catch {
    return followDanglingLink(file)
  }
}

export interface AtomicWriteOptions {
  mode?: number
  dirMode?: number
}

export async function writeFileAtomic(file: string, content: string | Uint8Array, options: AtomicWriteOptions = {}): Promise<string> {
  await mkdir(path.dirname(file), options.dirMode === undefined ? { recursive: true } : { recursive: true, mode: options.dirMode })
  const target = await resolveWriteTarget(file)
  if (target !== file) await mkdir(path.dirname(target), { recursive: true })
  const existingMode = options.mode === undefined ? await stat(target).then((info) => info.mode & 0o7777, () => undefined) : undefined
  const mode = options.mode ?? existingMode
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, content, { flag: 'wx', ...(mode === undefined ? {} : { mode }) })
    if (mode !== undefined) await chmod(temporary, mode)
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
  return target
}

export interface FileLockOptions {
  timeoutMs?: number
  staleMs?: number
  retryMs?: number
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function lockIsStale(lock: string, staleMs: number): Promise<boolean> {
  const info = await stat(lock).catch(() => null)
  if (!info) return true
  if (Date.now() - info.mtimeMs > staleMs) return true
  const owner = Number.parseInt((await readFile(lock, 'utf8').catch(() => '')).split('\n')[0] ?? '', 10)
  return Number.isInteger(owner) && owner > 0 && !processAlive(owner)
}

export async function withFileLock<T>(file: string, run: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000
  const staleMs = options.staleMs ?? 30_000
  const retryMs = options.retryMs ?? 20
  await mkdir(path.dirname(file), { recursive: true })
  const lock = `${await resolveWriteTarget(file)}.lock`
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const handle = await open(lock, 'wx', 0o600)
      try {
        await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`)
      } finally {
        await handle.close()
      }
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (await lockIsStale(lock, staleMs)) {
        await rm(lock, { force: true })
        continue
      }
      if (Date.now() >= deadline) throw Object.assign(new Error(`timed out waiting for the lock ${lock}`), { code: 'ELOCKED' })
      await new Promise((resolve) => setTimeout(resolve, retryMs + Math.floor(Math.random() * retryMs)))
    }
  }
  try {
    return await run()
  } finally {
    await rm(lock, { force: true }).catch(() => undefined)
  }
}
