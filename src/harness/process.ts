import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { accessSync, closeSync, constants, openSync, readFileSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, win32 } from 'node:path'
import { findAgentBinarySync } from '../agents/binaries.ts'
import type { AgentName } from '../agents/types.ts'
import { currentPlatform, platformContext, spawnSpec, type PlatformContext } from '../platform.ts'

export interface RunOptions {
  input?: string
  env: NodeJS.ProcessEnv
  cwd: string
  timeoutMs: number
  stdoutPath?: string
}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

const KILL_GRACE_MS = 2_000
const EXIT_GRACE_MS = 2_000

export function isExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false
    if (process.platform === 'win32') return true
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function executableNames(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') return [name]
  const extensions = (env[Object.keys(env).find((key) => key.toUpperCase() === 'PATHEXT') ?? 'PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter((extension) => extension.length > 0)
  if (extensions.some((extension) => name.toLowerCase().endsWith(extension.toLowerCase()))) return [name]
  return [...extensions.map((extension) => `${name}${extension.toLowerCase()}`), name]
}

export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  if (isAbsolute(name)) return isExecutable(name) ? name : null
  const separator = platform === 'win32' ? ';' : delimiter
  for (const dir of (env[pathKeyOf(env)] ?? '').split(separator)) {
    if (!dir) continue
    for (const candidateName of executableNames(name, env, platform)) {
      const candidate = join(dir, candidateName)
      if (isExecutable(candidate)) return candidate
    }
  }
  return null
}

export function homeOf(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  const fromEnv = platform === 'win32' ? env['USERPROFILE'] || env['HOME'] : env['HOME']
  return fromEnv || homedir()
}

export function contextFor(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): PlatformContext {
  return platformContext({ platform: currentPlatform(platform), env, home: homeOf(env, platform) })
}

export function resolveHarnessBin(envVars: string | readonly string[], name: string, env: NodeJS.ProcessEnv = process.env, agent?: AgentName): string | null {
  for (const envVar of typeof envVars === 'string' ? [envVars] : envVars) {
    const override = env[envVar]
    if (!override) continue
    if (!isAbsolute(override)) {
      process.stderr.write(`kit: ${envVar} must be an absolute path; ignoring "${override}".\n`)
      return null
    }
    return isExecutable(override) ? override : null
  }
  if (agent) return findAgentBinarySync(agent, { ctx: contextFor(env) })
  return findOnPath(name, env)
}

export function pathKeyOf(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
}

export function withBinOnPath(env: NodeJS.ProcessEnv, bin: string): NodeJS.ProcessEnv {
  if (!isAbsolute(bin) && !win32.isAbsolute(bin)) return env
  const dir = process.platform === 'win32' ? win32.dirname(bin) : dirname(bin)
  const key = pathKeyOf(env)
  const current = env[key] ?? ''
  const parts = current.split(delimiter)
  if (parts.includes(dir)) return env
  return { ...env, [key]: current ? `${dir}${delimiter}${current}` : dir }
}

export interface SpawnCommand {
  command: string
  args: string[]
  windowsVerbatimArguments: boolean
}

export function spawnCommand(bin: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): SpawnCommand {
  return spawnSpec(bin, args, contextFor(env))
}

export function taskkillPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env['SystemRoot'] ?? env['SYSTEMROOT'] ?? env['windir'] ?? env['WINDIR'] ?? 'C:\\Windows'
  return win32.join(root, 'System32', 'taskkill.exe')
}

export function killTree(child: ChildProcess, signal: NodeJS.Signals, platform: NodeJS.Platform = process.platform): void {
  if (child.pid === undefined) return
  if (platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return
    try {
      spawnSync(taskkillPath(), ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch {
      try {
        child.kill(signal)
      } catch {}
    }
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {}
  }
}

export function runProcess(bin: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdoutFd: number | null = null
    try {
      if (options.stdoutPath) stdoutFd = openSync(options.stdoutPath, 'w')
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: errorMessage(error), timedOut: false })
      return
    }
    const closeFd = () => {
      if (stdoutFd === null) return
      try {
        closeSync(stdoutFd)
      } catch {}
      stdoutFd = null
    }
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let timedOut = false
    let settled = false
    let killer: NodeJS.Timeout | undefined
    let drain: NodeJS.Timeout | undefined
    let spec: SpawnCommand
    try {
      spec = spawnCommand(bin, args, options.env)
    } catch (error) {
      closeFd()
      resolve({ code: null, stdout: '', stderr: errorMessage(error), timedOut: false })
      return
    }
    const child = spawn(spec.command, spec.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', stdoutFd ?? 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    })
    const killGroup = (signal: NodeJS.Signals) => killTree(child, signal)
    const finish = (code: number | null, extra?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killer)
      clearTimeout(drain)
      closeFd()
      let out = Buffer.concat(stdout).toString('utf8')
      if (options.stdoutPath) {
        try {
          out = readFileSync(options.stdoutPath, 'utf8')
        } catch {}
      }
      const err = Buffer.concat(stderr).toString('utf8')
      resolve({ code, stdout: out, stderr: extra ? `${err}${err ? '\n' : ''}${extra}` : err, timedOut })
    }
    const timer = setTimeout(() => {
      timedOut = true
      killGroup('SIGTERM')
      killer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS)
      killer.unref()
    }, options.timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', (error) => finish(null, errorMessage(error)))
    child.once('close', (code) => finish(code))
    child.once('exit', (code) => {
      drain = setTimeout(() => {
        killGroup('SIGKILL')
        child.stdout?.destroy()
        child.stderr?.destroy()
        finish(code)
      }, EXIT_GRACE_MS)
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(options.input ?? '')
  })
}

export function describeFailure(label: string, result: RunResult): string {
  if (result.timedOut) return `${label} timed out`
  const lines = result.stderr.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('at '))
  const detail = (lines.find((line) => /error/i.test(line)) ?? lines.at(-1) ?? '').slice(0, 400)
  return `${label} exited with code ${result.code ?? 'unknown'}${detail ? `: ${detail}` : ''}`
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function withTempDir<T>(prefix: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  try {
    return await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

export function remainingMs(deadline: number): number {
  return Math.max(1, deadline - Date.now())
}
