import { readFile } from 'node:fs/promises'
import { withFileLock, writeFileAtomic } from '../../../src/atomic.ts'

const [file, rounds] = process.argv.slice(2)
for (let index = 0; index < Number(rounds); index++) {
  await withFileLock(file as string, async () => {
    const value = Number(await readFile(file as string, 'utf8'))
    await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 3)))
    await writeFileAtomic(file as string, String(value + 1))
  }, { timeoutMs: 60_000 })
}
