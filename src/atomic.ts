import { randomUUID } from 'node:crypto'
import { chmod, link, lstat, mkdir, readFile, readlink, realpath, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
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
    await retryTransient(() => rename(temporary, target))
  } catch (error) {
    await retryTransient(() => rm(temporary, { force: true })).catch(() => undefined)
    throw error
  }
  return target
}

export interface FileLockOptions {
  timeoutMs?: number
  staleMs?: number
  retryMs?: number
}

const TRANSIENT_WINDOWS_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

async function retryTransient<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run()
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (process.platform !== 'win32' || attempt >= 5 || !TRANSIENT_WINDOWS_CODES.has(code)) throw error
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)))
    }
  }
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

async function readOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

function ownerPid(content: string): number {
  return Number.parseInt(content.split('\n')[0] ?? '', 10)
}

async function tryCreateLock(lock: string, token: string): Promise<boolean> {
  const staging = `${lock}.${randomUUID()}.new`
  await writeFile(staging, token, { flag: 'wx', mode: 0o600 })
  try {
    await link(staging, lock)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  } finally {
    await retryTransient(() => rm(staging, { force: true })).catch(() => undefined)
  }
}

async function stealIfStale(lock: string, staleMs: number): Promise<void> {
  let info
  try {
    info = await stat(lock)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const observed = await readOrNull(lock)
  if (observed === null) return
  const tooOld = Date.now() - info.mtimeMs > staleMs
  const pid = ownerPid(observed)
  const deadOwner = Number.isInteger(pid) && pid > 0 && pid !== process.pid && !processAlive(pid)
  if (!tooOld && !deadOwner) return
  const moved = `${lock}.${randomUUID()}.stale`
  try {
    await rename(lock, moved)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const content = await readOrNull(moved)
  if (content !== observed) await link(moved, lock).catch(() => undefined)
  await retryTransient(() => rm(moved, { force: true })).catch(() => undefined)
}

export async function withFileLock<T>(file: string, run: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000
  const staleMs = options.staleMs ?? 30_000
  const retryMs = options.retryMs ?? 20
  const target = await resolveWriteTarget(file)
  await mkdir(path.dirname(target), { recursive: true })
  const lock = `${target}.lock`
  const token = `${process.pid}\n${randomUUID()}\n`
  const deadline = Date.now() + timeoutMs
  while (!(await tryCreateLock(lock, token))) {
    await stealIfStale(lock, staleMs)
    if (Date.now() >= deadline) throw Object.assign(new Error(`timed out waiting for the lock ${lock}`), { code: 'ELOCKED' })
    await new Promise((resolve) => setTimeout(resolve, retryMs + Math.floor(Math.random() * retryMs)))
  }
  const heartbeat = setInterval(() => {
    void readOrNull(lock).then((content) => {
      if (content === token) {
        const now = new Date()
        return utimes(lock, now, now)
      }
      return undefined
    }).catch(() => undefined)
  }, Math.max(50, Math.floor(staleMs / 3)))
  heartbeat.unref()
  try {
    return await run()
  } finally {
    clearInterval(heartbeat)
    try {
      if ((await readOrNull(lock)) === token) await retryTransient(() => rm(lock, { force: true }))
    } catch {}
  }
}
