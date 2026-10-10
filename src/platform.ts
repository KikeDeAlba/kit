import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

export type Platform = 'darwin' | 'win32' | 'linux'

export function currentPlatform(platform: NodeJS.Platform = process.platform): Platform {
  if (platform === 'darwin' || platform === 'win32') return platform
  return 'linux'
}

export interface PlatformContext {
  platform: Platform
  env: NodeJS.ProcessEnv
  home: string
}

export function platformContext(overrides: Partial<PlatformContext> = {}): PlatformContext {
  return {
    platform: overrides.platform ?? currentPlatform(),
    env: overrides.env ?? process.env,
    home: overrides.home ?? homedir(),
  }
}

function pathApi(ctx: PlatformContext): path.PlatformPath {
  return ctx.platform === 'win32' ? path.win32 : path.posix
}

export function configHome(ctx: PlatformContext = platformContext()): string {
  const p = pathApi(ctx)
  if (ctx.platform === 'win32') return ctx.env['APPDATA'] ?? p.join(ctx.home, 'AppData', 'Roaming')
  return ctx.env['XDG_CONFIG_HOME'] ?? p.join(ctx.home, '.config')
}

export function dataHome(ctx: PlatformContext = platformContext()): string {
  const p = pathApi(ctx)
  if (ctx.platform === 'win32') return ctx.env['LOCALAPPDATA'] ?? p.join(ctx.home, 'AppData', 'Local')
  return ctx.env['XDG_DATA_HOME'] ?? p.join(ctx.home, '.local', 'share')
}

export function stateHome(ctx: PlatformContext = platformContext()): string {
  const p = pathApi(ctx)
  if (ctx.platform === 'win32') return p.join(dataHome(ctx), 'state')
  return ctx.env['XDG_STATE_HOME'] ?? p.join(ctx.home, '.local', 'state')
}

export function toolDirs(tool: string, ctx: PlatformContext = platformContext()): { config: string; data: string; state: string } {
  const p = pathApi(ctx)
  return {
    config: p.join(configHome(ctx), tool),
    data: p.join(dataHome(ctx), tool),
    state: p.join(stateHome(ctx), tool),
  }
}

export function pathDelimiter(ctx: PlatformContext = platformContext()): string {
  return ctx.platform === 'win32' ? ';' : ':'
}

export function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
}

export function defaultSearchDirs(ctx: PlatformContext = platformContext()): string[] {
  const p = pathApi(ctx)
  if (ctx.platform === 'win32') {
    const appData = configHome(ctx)
    const local = dataHome(ctx)
    return [p.join(appData, 'npm'), p.join(local, 'pnpm'), p.join(ctx.home, '.local', 'bin'), p.join(local, 'Programs')]
  }
  const dirs = [p.join(ctx.home, '.local', 'bin'), p.join(ctx.home, 'bin')]
  const pnpmHome = ctx.env['PNPM_HOME']
  if (pnpmHome) dirs.unshift(pnpmHome, p.join(pnpmHome, 'bin'))
  if (ctx.platform === 'darwin') dirs.push(p.join(ctx.home, 'Library', 'pnpm'), '/opt/homebrew/bin')
  dirs.push('/usr/local/bin', '/usr/bin', '/bin')
  return dirs
}

export function searchPath(ctx: PlatformContext = platformContext(), extra: readonly string[] = []): string {
  const fromEnv = (ctx.env[pathKey(ctx.env)] ?? '').split(pathDelimiter(ctx)).filter((dir) => dir.length > 0)
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const dir of [...extra, ...fromEnv, ...defaultSearchDirs(ctx)]) {
    if (seen.has(dir)) continue
    seen.add(dir)
    ordered.push(dir)
  }
  return ordered.join(pathDelimiter(ctx))
}

function executableNames(command: string, ctx: PlatformContext): string[] {
  if (ctx.platform !== 'win32') return [command]
  if (path.win32.extname(command) !== '') return [command]
  const extensions = (ctx.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext.length > 0)
  return [...extensions.map((ext) => `${command}${ext.toLowerCase()}`), command]
}

async function isExecutable(file: string, ctx: PlatformContext): Promise<boolean> {
  try {
    const info = await stat(file)
    if (!info.isFile()) return false
    if (ctx.platform === 'win32') return true
    await access(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export async function which(command: string, ctx: PlatformContext = platformContext(), extraDirs: readonly string[] = []): Promise<string | null> {
  const p = pathApi(ctx)
  if (p.isAbsolute(command)) return (await isExecutable(command, ctx)) ? command : null
  for (const dir of searchPath(ctx, extraDirs).split(pathDelimiter(ctx))) {
    for (const name of executableNames(command, ctx)) {
      const candidate = p.join(dir, name)
      if (await isExecutable(candidate, ctx)) return candidate
    }
  }
  return null
}

export function childEnvironment(ctx: PlatformContext = platformContext(), extraDirs: readonly string[] = [], extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...ctx.env }
  const key = pathKey(env)
  env[key] = searchPath(ctx, extraDirs)
  return { ...env, ...extra }
}

export function openCommand(target: string, ctx: PlatformContext = platformContext()): { command: string; args: string[] } {
  if (ctx.platform === 'darwin') return { command: 'open', args: [target] }
  if (ctx.platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '""', target] }
  return { command: 'xdg-open', args: [target] }
}

export async function openTarget(target: string, ctx: PlatformContext = platformContext()): Promise<void> {
  const { command, args } = openCommand(target, ctx)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

export function withRuntimePath(env: NodeJS.ProcessEnv, runtime: string = process.execPath): NodeJS.ProcessEnv {
  const key = pathKey(env)
  const delimiter = process.platform === 'win32' ? ';' : ':'
  const dir = path.dirname(runtime)
  const current = (env[key] ?? '').split(delimiter).filter((entry) => entry.length > 0)
  if (current.includes(dir)) return env
  return { ...env, [key]: [dir, ...current].join(delimiter) }
}

export interface RunResult {
  stdout: string
  stderr: string
}

export async function run(
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string; timeoutMs?: number; input?: string } = {},
): Promise<RunResult> {
  if (options.input === undefined) {
    const { stdout, stderr } = await promisify(execFile)(command, [...args], {
      env: withRuntimePath(options.env ?? process.env),
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 60_000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      shell: needsShell(command),
    })
    return { stdout, stderr }
  }
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      env: withRuntimePath(options.env ?? process.env),
      cwd: options.cwd,
      windowsHide: true,
      shell: needsShell(command),
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 60_000)
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(Object.assign(new Error(`${command} exited with ${code}: ${stderr.trim().split('\n')[0] ?? ''}`), { code, stdout, stderr }))
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(options.input)
  })
}

function needsShell(command: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)
}
