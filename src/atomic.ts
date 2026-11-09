import { chmod, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export async function resolveWriteTarget(file: string): Promise<string> {
  try {
    return await realpath(file)
  } catch {
    return file
  }
}

export async function writeFileAtomic(file: string, content: string, options: { mode?: number; dirMode?: number } = {}): Promise<string> {
  await mkdir(path.dirname(file), options.dirMode === undefined ? { recursive: true } : { recursive: true, mode: options.dirMode })
  const target = await resolveWriteTarget(file)
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`)
  try {
    await writeFile(temporary, content, options.mode === undefined ? {} : { mode: options.mode })
    if (options.mode !== undefined) await chmod(temporary, options.mode)
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
  return target
}
