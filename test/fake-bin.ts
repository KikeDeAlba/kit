import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface FakeBinCall {
  argv: string[]
  stdin: string
  env: Record<string, string>
  cwd: string
  files: Record<string, string | string[] | null>
}

const SCRIPT = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const argv = process.argv.slice(2)
const chunks = []
process.stdin.on('data', (chunk) => chunks.push(chunk))
process.stdin.on('end', () => {
  const stdin = Buffer.concat(chunks).toString('utf8')
  const log = process.env.FAKE_BIN_LOG
  const read = (file) => { try { return fs.readFileSync(file, 'utf8') } catch { return null } }
  const files = {}
  const after = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined }
  for (const flag of ['-f', '--output-schema']) { const file = after(flag); if (file) files[flag] = read(file) }
  files['.gemini/settings.json'] = read(path.join(process.cwd(), '.gemini', 'settings.json'))
  if (process.env.OPENCODE_CONFIG_DIR) { try { files.OPENCODE_CONFIG_DIR = fs.readdirSync(process.env.OPENCODE_CONFIG_DIR) } catch { files.OPENCODE_CONFIG_DIR = null } }
  let index = 0
  if (log) {
    index = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\\n').filter(Boolean).length : 0
    fs.appendFileSync(log, JSON.stringify({ argv, stdin, env: process.env, cwd: process.cwd(), files }) + '\\n')
  }
  let reply = process.env.FAKE_BIN_REPLY ?? ''
  if (process.env.FAKE_BIN_REPLY_FILE) reply = fs.readFileSync(process.env.FAKE_BIN_REPLY_FILE, 'utf8')
  if (process.env.FAKE_BIN_REPLIES) {
    const replies = JSON.parse(fs.readFileSync(process.env.FAKE_BIN_REPLIES, 'utf8'))
    reply = replies[Math.min(index, replies.length - 1)] ?? ''
  }
  const finish = () => {
    const out = argv[0] === 'exec' ? after('-o') : undefined
    if (out) fs.writeFileSync(out, reply)
    else process.stdout.write(reply)
    process.exitCode = Number(process.env.FAKE_BIN_EXIT ?? 0)
  }
  const sleep = Number(process.env.FAKE_BIN_SLEEP_MS ?? 0)
  if (sleep > 0) setTimeout(finish, sleep)
  else finish()
})
`

export const IS_WINDOWS = process.platform === 'win32'
export const POSIX_ONLY: string | false = IS_WINDOWS ? 'needs a posix shell, signals or posix paths' : false

export function nodeScriptBin(dir: string, name: string, source: string): string {
  if (!IS_WINDOWS) {
    const file = join(dir, name)
    writeFileSync(file, source.startsWith('#!') ? source : `#!${process.execPath}\n${source}`)
    chmodSync(file, 0o755)
    return file
  }
  const script = join(dir, `${name}.cjs`)
  writeFileSync(script, source.startsWith('#!') ? source.slice(source.indexOf('\n') + 1) : source)
  const file = join(dir, `${name}.cmd`)
  writeFileSync(file, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`)
  return file
}

export function createFakeBin(dir: string, name: string): string {
  return nodeScriptBin(dir, name, SCRIPT)
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}

export function readFakeBinCalls(logFile: string): FakeBinCall[] {
  if (!existsSync(logFile)) return []
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeBinCall)
}
