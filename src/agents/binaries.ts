import { readdirSync } from 'node:fs'
import path from 'node:path'
import { configHome, dataHome, platformContext, which, whichSync, type PlatformContext } from '../platform.ts'
import { compareVersions, parseVersion } from '../semver.ts'
import type { AgentName } from './types.ts'

export const AGENT_BINARIES: Record<AgentName, string | null> = {
  claude: 'claude',
  opencode: 'opencode',
  codex: 'codex',
  gemini: 'gemini',
  antigravity: 'agy',
  'claude-desktop': null,
}

function nvmVersionDirs(root: string, join: (...parts: string[]) => string): string[] {
  try {
    return readdirSync(join(root, 'versions', 'node'))
      .filter((name) => parseVersion(name) !== null)
      .sort((left, right) => compareVersions(right, left))
      .map((name) => join(root, 'versions', 'node', name, 'bin'))
  } catch {
    return []
  }
}

function fnmRoot(ctx: PlatformContext, join: (...parts: string[]) => string): string {
  const explicit = ctx.env['FNM_DIR']
  if (explicit) return explicit
  if (ctx.platform === 'win32') return join(dataHome(ctx), 'fnm')
  if (ctx.platform === 'darwin') return join(ctx.home, 'Library', 'Application Support', 'fnm')
  return join(dataHome(ctx), 'fnm')
}

function unique(dirs: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    ordered.push(dir)
  }
  return ordered
}

export function toolchainSearchDirs(ctx: PlatformContext = platformContext()): string[] {
  const join = ctx.platform === 'win32' ? path.win32.join : path.posix.join
  const env = ctx.env
  const windows = ctx.platform === 'win32'
  const bin = (dir: string | undefined) => (dir ? (windows ? dir : join(dir, 'bin')) : undefined)
  const nvmDir = env['NVM_DIR'] ?? join(ctx.home, '.nvm')
  const pnpmDirs = env['PNPM_HOME']
    ? [env['PNPM_HOME']]
    : windows
      ? [join(dataHome(ctx), 'pnpm')]
      : ctx.platform === 'darwin'
        ? [join(ctx.home, 'Library', 'pnpm')]
        : [join(ctx.home, '.local', 'share', 'pnpm')]
  return unique([
    env['NVM_BIN'],
    windows ? env['NVM_SYMLINK'] : undefined,
    ...(windows ? [] : nvmVersionDirs(nvmDir, join)),
    windows ? join(fnmRoot(ctx, join), 'aliases', 'default') : join(fnmRoot(ctx, join), 'aliases', 'default', 'bin'),
    join(env['VOLTA_HOME'] ?? join(ctx.home, '.volta'), 'bin'),
    bin(env['NPM_CONFIG_PREFIX'] ?? env['npm_config_prefix']),
    windows ? undefined : join(ctx.home, '.npm-global', 'bin'),
    ...pnpmDirs,
    join(env['BUN_INSTALL'] ?? join(ctx.home, '.bun'), 'bin'),
    join(ctx.home, '.local', 'bin'),
    windows ? join(configHome(ctx), 'npm') : undefined,
    windows ? join(dataHome(ctx), 'Volta', 'bin') : undefined,
  ])
}

export function agentSearchDirs(agent: AgentName, ctx: PlatformContext = platformContext()): string[] {
  const join = ctx.platform === 'win32' ? path.win32.join : path.posix.join
  if (agent === 'antigravity') return [join(ctx.home, '.gemini', 'antigravity-cli', 'bin')]
  if (agent === 'opencode') return [join(ctx.home, '.opencode', 'bin')]
  if (agent === 'claude') return [join(ctx.home, '.claude', 'local')]
  return []
}

function trailingDirs(agent: AgentName, ctx: PlatformContext): string[] {
  return [...toolchainSearchDirs(ctx), ...agentSearchDirs(agent, ctx)]
}

export async function findAgentBinary(agent: AgentName, options: { ctx?: PlatformContext; override?: string } = {}): Promise<string | null> {
  const ctx = options.ctx ?? platformContext()
  if (options.override) return which(options.override, ctx)
  const binary = AGENT_BINARIES[agent]
  if (binary == null) return null
  return which(binary, ctx, [], trailingDirs(agent, ctx))
}

export function findAgentBinarySync(agent: AgentName, options: { ctx?: PlatformContext; override?: string } = {}): string | null {
  const ctx = options.ctx ?? platformContext()
  if (options.override) return whichSync(options.override, ctx)
  const binary = AGENT_BINARIES[agent]
  if (binary == null) return null
  return whichSync(binary, ctx, [], trailingDirs(agent, ctx))
}

export function agentForBinary(command: string): AgentName | null {
  const entry = Object.entries(AGENT_BINARIES).find(([, binary]) => binary === command)
  return entry ? (entry[0] as AgentName) : null
}
