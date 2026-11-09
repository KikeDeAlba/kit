import './isolate.ts'
import { strict as assert } from 'node:assert'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { POSIX_ONLY } from './fake-bin.ts'
import { runProcess } from '../src/harness/process.ts'

const root = mkdtempSync(join(tmpdir(), 'kit-process-'))
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

function script(name: string, body: string): string {
  const file = join(root, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function settle(pid: number): Promise<boolean> {
  for (let i = 0; i < 20 && alive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 50))
  return alive(pid)
}

test('a grandchild that inherits stderr does not keep runProcess from resolving', { skip: POSIX_ONLY }, async () => {
  const pidFile = join(root, 'exit.pid')
  const bin = script('leaky', `sleep 30 >/dev/null &\necho $! > ${pidFile}\necho done\nexit 0`)
  const started = Date.now()
  const result = await runProcess(bin, [], { env: process.env, cwd: root, timeoutMs: 20_000 })
  assert.ok(Date.now() - started < 6_000, `took ${Date.now() - started}ms`)
  assert.equal(result.code, 0)
  assert.equal(result.timedOut, false)
  assert.equal(result.stdout.trim(), 'done')
  assert.equal(await settle(Number(readFileSync(pidFile, 'utf8'))), false)
})

test('a timeout kills the whole process group', { skip: POSIX_ONLY }, async () => {
  const pidFile = join(root, 'timeout.pid')
  const bin = script('hung', `sleep 30 >/dev/null &\necho $! > ${pidFile}\nsleep 30`)
  const started = Date.now()
  const result = await runProcess(bin, [], { env: process.env, cwd: root, timeoutMs: 2_000 })
  assert.ok(Date.now() - started < 7_000, `took ${Date.now() - started}ms`)
  assert.equal(result.timedOut, true)
  assert.equal(await settle(Number(readFileSync(pidFile, 'utf8'))), false)
})
