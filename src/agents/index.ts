import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { configHome, dataHome, pathKey, platformContext, run, which, withRuntimePath, type PlatformContext } from '../platform.ts'
import {
  copyInto,
  linkPath,
  mergeHooks,
  readJsonFile,
  removeOwnedLink,
  removeTomlTable,
  stripHooks,
  tomlTableBlock,
  writeJsonFile,
} from './files.ts'
import { commandForCodex, commandToGeminiToml, hasAgentBlocks, renderForAgent, skillToOpenCodeCommand } from './markdown.ts'
import {
  AGENTS,
  type AgentHomes,
  type AgentIntegration,
  type AgentName,
  type ClaudePluginSpec,
  type CommandSource,
  type InstallOptions,
  type McpServer,
  type SkillSource,
  type Step,
} from './types.ts'

export * from './types.ts'
export { commandToGeminiToml, commandForCodex, renderForAgent, hasAgentBlocks, parseFrontmatter, skillToOpenCodeCommand } from './markdown.ts'
export { mergeHooks, stripHooks } from './files.ts'

const BINARIES: Record<AgentName, string | null> = { claude: 'claude', opencode: 'opencode', codex: 'codex', gemini: 'gemini', 'claude-desktop': null }

function claudeDesktopHome(ctx: PlatformContext, join: (...parts: string[]) => string): string | null {
  if (ctx.platform === 'darwin') return join(ctx.home, 'Library', 'Application Support', 'Claude')
  if (ctx.platform === 'win32') return join(configHome(ctx), 'Claude')
  return null
}

export function agentHomes(ctx: PlatformContext = platformContext(), overrides: Partial<AgentHomes> = {}): AgentHomes {
  const join = ctx.platform === 'win32' ? path.win32.join : path.posix.join
  return {
    claude: overrides.claude ?? ctx.env['CLAUDE_CONFIG_DIR'] ?? join(ctx.home, '.claude'),
    opencode: overrides.opencode ?? join(ctx.env['XDG_CONFIG_HOME'] ?? join(ctx.home, '.config'), 'opencode'),
    codex: overrides.codex ?? ctx.env['CODEX_HOME'] ?? join(ctx.home, '.codex'),
    agentsSkills: overrides.agentsSkills ?? join(ctx.env['KIT_AGENTS_HOME'] ?? join(ctx.home, '.agents'), 'skills'),
    gemini: overrides.gemini ?? join(ctx.env['GEMINI_CLI_HOME'] ?? ctx.home, '.gemini'),
    claudeDesktop: overrides.claudeDesktop !== undefined ? overrides.claudeDesktop : claudeDesktopHome(ctx, join),
  }
}

export async function detectAgents(
  ctx: PlatformContext = platformContext(),
  homes: AgentHomes = agentHomes(ctx),
  locate: (command: string) => Promise<string | null> = (command) => which(command, ctx),
): Promise<AgentName[]> {
  const found: AgentName[] = []
  const configDir: Record<AgentName, string | null> = { claude: homes.claude, opencode: homes.opencode, codex: homes.codex, gemini: homes.gemini, 'claude-desktop': homes.claudeDesktop }
  for (const agent of AGENTS) {
    const dir = configDir[agent]
    const binary = BINARIES[agent]
    if ((dir !== null && existsSync(dir)) || (binary !== null && (await locate(binary)) !== null)) found.push(agent)
  }
  return found
}

async function resolveAgents(options: InstallOptions, ctx: PlatformContext, homes: AgentHomes): Promise<AgentName[]> {
  const wanted = options.agents ?? 'detected'
  if (wanted === 'all') return [...AGENTS]
  if (wanted === 'detected') return detectAgents(ctx, homes, options.locate)
  return [...wanted]
}

function renderedRoot(ctx: PlatformContext, tool: string, agent: AgentName): string {
  return path.join(dataHome(ctx), 'kikedealba', 'agents', agent, tool)
}

async function renderTree(source: string, destination: string, agent: AgentName): Promise<void> {
  await copyInto(source, destination)
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name.endsWith('.md')) await writeFile(full, renderForAgent(await readFile(full, 'utf8'), agent))
    }
  }
  await walk(destination)
}

async function skillNeedsRender(skill: SkillSource): Promise<boolean> {
  const file = path.join(skill.dir, 'SKILL.md')
  return existsSync(file) && hasAgentBlocks(await readFile(file, 'utf8'))
}

async function placeSkill(skill: SkillSource, destination: string, agent: AgentName, integration: AgentIntegration, ctx: PlatformContext): Promise<Step> {
  try {
    if (await skillNeedsRender(skill)) {
      const rendered = path.join(renderedRoot(ctx, integration.tool, agent), 'skills', skill.name)
      await renderTree(skill.dir, rendered, agent)
      const state = await linkPath(rendered, destination, ctx.platform)
      return { agent, item: `skill ${skill.name}`, state: state === 'present' ? 'installed' : state, detail: `skill ${skill.name} rendered for ${agent}`, path: destination }
    }
    const state = await linkPath(skill.dir, destination, ctx.platform)
    return { agent, item: `skill ${skill.name}`, state, detail: `skill ${skill.name} linked`, path: destination }
  } catch (error) {
    return { agent, item: `skill ${skill.name}`, state: 'failed', detail: reason(error), path: destination }
  }
}

interface MarkdownCommand extends CommandSource {
  fromSkill: boolean
}

function markdownCommands(integration: AgentIntegration): MarkdownCommand[] {
  return [
    ...(integration.commands ?? []).map((command) => ({ ...command, fromSkill: false })),
    ...(integration.userSkills ?? []).map((skill) => ({ name: skill.name, file: path.join(skill.dir, 'SKILL.md'), fromSkill: true })),
  ]
}

async function placeMarkdownCommand(command: MarkdownCommand, destination: string, agent: AgentName, integration: AgentIntegration, ctx: PlatformContext): Promise<Step> {
  try {
    const text = await readFile(command.file, 'utf8')
    if (command.fromSkill || hasAgentBlocks(text)) {
      const rendered = path.join(renderedRoot(ctx, integration.tool, agent), 'commands', `${command.name}.md`)
      await mkdir(path.dirname(rendered), { recursive: true })
      await writeFile(rendered, command.fromSkill ? skillToOpenCodeCommand(text) : renderForAgent(text, agent))
      await linkPath(rendered, destination, ctx.platform)
      return { agent, item: `command ${command.name}`, state: 'installed', detail: `command ${command.name} rendered for ${agent}`, path: destination }
    }
    const state = await linkPath(command.file, destination, ctx.platform)
    return { agent, item: `command ${command.name}`, state, detail: `command ${command.name} linked`, path: destination }
  } catch (error) {
    return { agent, item: `command ${command.name}`, state: 'failed', detail: reason(error), path: destination }
  }
}

async function defaultExec(command: string, args: readonly string[]): Promise<string> {
  return (await run(command, args, { timeoutMs: 120_000 })).stdout
}

function locator(options: InstallOptions, ctx: PlatformContext): (command: string) => Promise<string | null> {
  return options.locate ?? ((command: string) => which(command, ctx))
}

async function installClaude(integration: AgentIntegration, homes: AgentHomes, options: InstallOptions, ctx: PlatformContext): Promise<Step[]> {
  const steps: Step[] = []
  for (const skill of integration.skills ?? []) steps.push(await placeSkill(skill, path.join(homes.claude, 'skills', skill.name), 'claude', integration, ctx))
  for (const command of integration.commands ?? []) {
    steps.push(await placeMarkdownCommand({ ...command, fromSkill: false }, path.join(homes.claude, 'commands', `${command.name}.md`), 'claude', integration, ctx))
  }
  const settings = integration.claude
  if (settings && (settings.permissions || (settings.hooks && !options.skipHooks))) {
    const file = path.join(homes.claude, 'settings.json')
    const loaded = await readJsonFile(file)
    if ('error' in loaded) {
      steps.push({ agent: 'claude', item: 'settings', state: 'failed', detail: `${loaded.error}; left alone`, path: file })
    } else {
      const value = loaded.value
      const added: string[] = []
      if (settings.permissions) {
        const permissions = (typeof value['permissions'] === 'object' && value['permissions'] !== null ? value['permissions'] : {}) as Record<string, string[]>
        for (const key of ['allow', 'ask'] as const) {
          const current = Array.isArray(permissions[key]) ? permissions[key] : []
          const missing = (settings.permissions[key] ?? []).filter((rule) => !current.includes(rule))
          permissions[key] = [...current, ...missing]
          added.push(...missing)
        }
        value['permissions'] = permissions
      }
      if (settings.hooks && !options.skipHooks) {
        const merged = mergeHooks(value['hooks'], settings.hooks)
        value['hooks'] = merged.hooks
        added.push(...merged.added)
      }
      if (added.length > 0) await writeJsonFile(file, value, loaded.existed)
      steps.push({ agent: 'claude', item: 'settings', state: added.length > 0 ? 'installed' : 'present', detail: added.length > 0 ? `merged ${added.length} settings into ${file}` : 'settings already there', path: file })
    }
  }
  if (!options.skipMcp) {
    for (const server of integration.mcp ?? []) steps.push(await installClaudeMcp(server, options, ctx))
  }
  return steps
}

async function installClaudeMcp(server: McpServer, options: InstallOptions, ctx: PlatformContext): Promise<Step> {
  const claude = await locator(options, ctx)('claude')
  const args = 'url' in server
    ? ['mcp', 'add', '--scope', 'user', '--transport', 'http', server.name, server.url, ...Object.entries(server.headers ?? {}).flatMap(([key, value]) => ['--header', `${key}: ${value}`])]
    : ['mcp', 'add', '--scope', 'user', ...Object.entries(server.env ?? {}).flatMap(([key, value]) => ['--env', `${key}=${value}`]), server.name, '--', ...server.command]
  if (!claude) return { agent: 'claude', item: `mcp ${server.name}`, state: 'unavailable', detail: `claude is not on PATH; run: claude ${args.join(' ')}` }
  const exec = options.exec ?? defaultExec
  try {
    await exec(claude, ['mcp', 'remove', '--scope', 'user', server.name]).catch(() => undefined)
    await exec(claude, args)
    return { agent: 'claude', item: `mcp ${server.name}`, state: 'installed', detail: `MCP server ${server.name} registered in Claude Code` }
  } catch (error) {
    return { agent: 'claude', item: `mcp ${server.name}`, state: 'failed', detail: `claude mcp add failed: ${reason(error)}` }
  }
}

async function findClaudeRelay(homes: AgentHomes): Promise<string | null> {
  for (const folder of ['plugins', 'plugin']) {
    const dir = path.join(homes.opencode, folder)
    const entries = await readdir(dir).catch(() => [] as string[])
    const relay = entries.find((entry) => /claude-compat/i.test(entry))
    if (relay) return path.join(dir, relay)
  }
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    const file = path.join(homes.opencode, name)
    const text = existsSync(file) ? await readFile(file, 'utf8').catch(() => '') : ''
    if (/"plugin"\s*:\s*\[[^\]]*claude-compat/i.test(text)) return file
  }
  return null
}

async function claudeHooksPresent(integration: AgentIntegration, homes: AgentHomes): Promise<boolean> {
  const wanted = integration.claude?.hooks
  if (!wanted) return false
  const loaded = await readJsonFile(path.join(homes.claude, 'settings.json'))
  if ('error' in loaded || !loaded.existed) return false
  return stripHooks(loaded.value['hooks'], wanted).removed > 0
}

interface RelayPlan {
  relay: string
  plugins: boolean
  command: (command: MarkdownCommand) => boolean
}

async function planClaudeRelay(integration: AgentIntegration, homes: AgentHomes, options: InstallOptions): Promise<RelayPlan | null> {
  const mode = options.claudeCompat ?? 'auto'
  if (mode === false) return null
  const relay = await findClaudeRelay(homes)
  if (mode === true) return { relay: relay ?? 'claudeCompat', plugins: true, command: (command) => !command.fromSkill }
  if (!relay) return null
  return {
    relay,
    plugins: await claudeHooksPresent(integration, homes),
    command: (command) => !command.fromSkill && existsSync(path.join(homes.claude, 'commands', `${command.name}.md`)),
  }
}

async function skipRelayed(item: string, destination: string, source: string, relay: string, ctx: PlatformContext, integration: AgentIntegration): Promise<Step> {
  const text = await readFile(source, 'utf8').catch(() => null)
  const copies = text === null ? [] : [text, renderForAgent(text, 'opencode')]
  const removed = await removeLegacyEntry(destination, [source], [renderedRoot(ctx, integration.tool, 'opencode')], copies)
  return {
    agent: 'opencode',
    item,
    state: 'skipped',
    detail: `${relay} already relays it from Claude Code${removed ? '; removed the copy kit installed before' : ''}`,
    path: destination,
  }
}

async function installOpenCode(integration: AgentIntegration, homes: AgentHomes, options: InstallOptions, ctx: PlatformContext): Promise<Step[]> {
  const steps: Step[] = []
  const relay = await planClaudeRelay(integration, homes, options)
  for (const skill of integration.skills ?? []) steps.push(await placeSkill(skill, path.join(homes.opencode, 'skills', skill.name), 'opencode', integration, ctx))
  for (const command of markdownCommands(integration)) {
    const destination = path.join(homes.opencode, 'commands', `${command.name}.md`)
    if (relay?.command(command)) steps.push(await skipRelayed(`command ${command.name}`, destination, command.file, relay.relay, ctx, integration))
    else steps.push(await placeMarkdownCommand(command, destination, 'opencode', integration, ctx))
  }
  for (const plugin of integration.opencode?.plugins ?? []) {
    const destination = path.join(homes.opencode, 'plugins', `${plugin.name}${path.extname(plugin.file)}`)
    if (relay?.plugins) {
      steps.push(await skipRelayed(`plugin ${plugin.name}`, destination, plugin.file, relay.relay, ctx, integration))
      continue
    }
    try {
      const state = await linkPath(plugin.file, destination, ctx.platform)
      steps.push({ agent: 'opencode', item: `plugin ${plugin.name}`, state, detail: `plugin ${plugin.name} linked`, path: destination })
    } catch (error) {
      steps.push({ agent: 'opencode', item: `plugin ${plugin.name}`, state: 'failed', detail: reason(error), path: destination })
    }
  }
  if (!options.skipMcp && (integration.mcp ?? []).length > 0) steps.push(await editOpenCodeMcp(integration.mcp ?? [], homes, 'install'))
  return steps
}

async function editOpenCodeMcp(servers: readonly McpServer[], homes: AgentHomes, mode: 'install' | 'remove'): Promise<Step> {
  const item = `mcp ${servers.map((server) => server.name).join(', ')}`
  const jsonc = path.join(homes.opencode, 'opencode.jsonc')
  const file = existsSync(jsonc) ? jsonc : path.join(homes.opencode, 'opencode.json')
  const loaded = await readJsonFile(file)
  if ('error' in loaded) {
    return file === jsonc
      ? { agent: 'opencode', item, state: 'unavailable', detail: `${file} has comments or is not plain JSON, so it is not edited automatically; add the MCP servers under "mcp" by hand`, path: file }
      : { agent: 'opencode', item, state: 'failed', detail: `${loaded.error}; left alone`, path: file }
  }
  const value = loaded.value
  const mcp = (typeof value['mcp'] === 'object' && value['mcp'] !== null ? { ...(value['mcp'] as Record<string, unknown>) } : {})
  for (const server of servers) {
    if (mode === 'remove') delete mcp[server.name]
    else if ('url' in server) mcp[server.name] = { type: 'remote', url: server.url, enabled: true, ...(server.headers ? { headers: server.headers } : {}) }
    else mcp[server.name] = { type: 'local', command: server.command, enabled: true, ...(server.env ? { environment: server.env } : {}) }
  }
  value['mcp'] = mcp
  if (!value['$schema']) value['$schema'] = 'https://opencode.ai/config.json'
  await writeJsonFile(file, value, loaded.existed)
  return { agent: 'opencode', item, state: mode === 'remove' ? 'removed' : 'installed', detail: `${mode === 'remove' ? 'removed from' : 'registered in'} ${file}`, path: file }
}

async function installCodex(integration: AgentIntegration, homes: AgentHomes, options: InstallOptions, ctx: PlatformContext): Promise<Step[]> {
  const steps: Step[] = []
  for (const skill of integration.skills ?? []) steps.push(await placeSkill(skill, path.join(homes.agentsSkills, skill.name), 'codex', integration, ctx))
  for (const command of markdownCommands(integration)) {
    const destination = path.join(homes.codex, 'prompts', `${command.name}.md`)
    try {
      await mkdir(path.dirname(destination), { recursive: true })
      await writeFile(destination, commandForCodex(await readFile(command.file, 'utf8')))
      steps.push({ agent: 'codex', item: `command ${command.name}`, state: 'installed', detail: `prompt ${command.name} written`, path: destination })
    } catch (error) {
      steps.push({ agent: 'codex', item: `command ${command.name}`, state: 'failed', detail: reason(error), path: destination })
    }
  }
  if (integration.codex?.hooks && !options.skipHooks) {
    const file = path.join(homes.codex, 'hooks.json')
    const loaded = await readJsonFile(file)
    if ('error' in loaded) {
      steps.push({ agent: 'codex', item: 'hooks', state: 'failed', detail: `${loaded.error}; left alone`, path: file })
    } else {
      const merged = mergeHooks(loaded.value['hooks'], integration.codex.hooks)
      if (merged.added.length > 0) await writeJsonFile(file, { ...loaded.value, hooks: merged.hooks }, loaded.existed)
      steps.push({ agent: 'codex', item: 'hooks', state: merged.added.length > 0 ? 'installed' : 'present', detail: merged.added.length > 0 ? `merged ${merged.added.length} hooks into ${file}` : 'hooks already there', path: file })
    }
  }
  if (!options.skipMcp) {
    for (const server of integration.mcp ?? []) steps.push(await editCodexMcp(server, homes, 'install'))
  }
  return steps
}

function codexHeader(name: string): string {
  return `mcp_servers.${/^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name)}`
}

async function editCodexMcp(server: McpServer, homes: AgentHomes, mode: 'install' | 'remove'): Promise<Step> {
  const file = path.join(homes.codex, 'config.toml')
  const item = `mcp ${server.name}`
  const existing = existsSync(file) ? await readFile(file, 'utf8') : ''
  if (/^\s*mcp_servers\s*=/m.test(existing)) {
    return { agent: 'codex', item, state: 'unavailable', detail: `${file} uses an inline mcp_servers table; edit it by hand`, path: file }
  }
  const header = codexHeader(server.name)
  const stripped = removeTomlTable(existing, header)
  if (mode === 'remove') {
    if (stripped.removed) await writeFile(file, stripped.text)
    return { agent: 'codex', item, state: stripped.removed ? 'removed' : 'skipped', detail: stripped.removed ? `removed from ${file}` : 'not configured', path: file }
  }
  const [command, ...args] = 'command' in server ? server.command : []
  const block = 'url' in server
    ? tomlTableBlock(header, { url: server.url, ...(server.headers ? { http_headers: server.headers } : {}) })
    : tomlTableBlock(header, { command: command ?? '', args, ...(server.env ? { env: server.env } : {}) })
  const base = stripped.text.length > 0 && !stripped.text.endsWith('\n') ? `${stripped.text}\n` : stripped.text
  const next = `${base}${base.length > 0 ? '\n' : ''}${block}`
  if (next === existing) return { agent: 'codex', item, state: 'present', detail: 'already configured', path: file }
  await mkdir(homes.codex, { recursive: true })
  if (existing.length > 0) await writeFile(`${file}.backup`, existing)
  await writeFile(file, next)
  return { agent: 'codex', item, state: 'installed', detail: `registered in ${file}`, path: file }
}

function geminiExtensionDir(homes: AgentHomes, tool: string): string {
  return path.join(homes.gemini, 'extensions', tool)
}

async function installGemini(integration: AgentIntegration, homes: AgentHomes, options: InstallOptions, ctx: PlatformContext): Promise<Step[]> {
  const steps: Step[] = []
  const root = geminiExtensionDir(homes, integration.tool)
  await mkdir(root, { recursive: true })
  for (const skill of integration.skills ?? []) steps.push(await placeSkill(skill, path.join(root, 'skills', skill.name), 'gemini', integration, ctx))
  const commands = markdownCommands(integration)
  if (commands.length > 0) {
    const commandsDir = path.join(root, 'commands')
    await rm(commandsDir, { recursive: true, force: true })
    await mkdir(commandsDir, { recursive: true })
    for (const command of commands) {
      const destination = path.join(commandsDir, `${command.name}.toml`)
      try {
        await writeFile(destination, commandToGeminiToml(await readFile(command.file, 'utf8')))
        steps.push({ agent: 'gemini', item: `command ${command.name}`, state: 'installed', detail: `command ${command.name} written`, path: destination })
      } catch (error) {
        steps.push({ agent: 'gemini', item: `command ${command.name}`, state: 'failed', detail: reason(error), path: destination })
      }
    }
  }
  const hooksFile = path.join(root, 'hooks', 'hooks.json')
  if (integration.gemini?.hooks && !options.skipHooks) {
    await writeJsonFile(hooksFile, { hooks: integration.gemini.hooks }, false)
    steps.push({ agent: 'gemini', item: 'hooks', state: 'installed', detail: `hooks written to ${hooksFile}`, path: hooksFile })
  } else {
    await rm(path.join(root, 'hooks'), { recursive: true, force: true })
  }
  let contextFileName: string | undefined
  if (integration.gemini?.contextFile) {
    contextFileName = 'GEMINI.md'
    await writeFile(path.join(root, contextFileName), renderForAgent(await readFile(integration.gemini.contextFile, 'utf8'), 'gemini'))
  }
  const mcpServers: Record<string, unknown> = {}
  if (!options.skipMcp) {
    for (const server of integration.mcp ?? []) {
      if ('url' in server) mcpServers[server.name] = { httpUrl: server.url, ...(server.headers ? { headers: server.headers } : {}) }
      else {
        const [command, ...args] = server.command
        mcpServers[server.name] = { command, args, ...(server.env ? { env: server.env } : {}) }
      }
    }
  }
  const manifestFile = path.join(root, 'gemini-extension.json')
  await writeJsonFile(
    manifestFile,
    {
      name: integration.tool,
      version: integration.version,
      ...(integration.description ? { description: integration.description } : {}),
      ...(contextFileName ? { contextFileName } : {}),
      ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    },
    false,
  )
  steps.push({ agent: 'gemini', item: 'extension', state: 'installed', detail: `extension ${integration.tool} written to ${root}`, path: manifestFile })
  return steps
}

function claudeDesktopEntry(server: McpServer, ctx: PlatformContext): Record<string, unknown> {
  if ('url' in server) return { type: 'http', url: server.url, ...(server.headers ? { headers: server.headers } : {}) }
  const [command, ...args] = server.command
  const runtimePath = withRuntimePath(ctx.env)[pathKey(ctx.env)] ?? ''
  return { command, args, env: { PATH: runtimePath, ...server.env } }
}

async function editClaudeDesktopMcp(integration: AgentIntegration, homes: AgentHomes, options: InstallOptions, ctx: PlatformContext, mode: 'install' | 'remove'): Promise<Step> {
  const servers = integration.claudeDesktop?.mcp ?? []
  const item = servers.length > 0 ? `mcp ${servers.map((server) => server.name).join(', ')}` : 'mcp'
  if (servers.length === 0) return { agent: 'claude-desktop', item, state: 'skipped', detail: `${integration.tool} has no MCP servers for Claude Desktop` }
  if (mode === 'install' && options.skipMcp) return { agent: 'claude-desktop', item, state: 'skipped', detail: 'MCP servers skipped' }
  if (homes.claudeDesktop === null) return { agent: 'claude-desktop', item, state: mode === 'remove' ? 'skipped' : 'unavailable', detail: 'Claude Desktop is not available on this platform' }
  const file = (ctx.platform === 'win32' ? path.win32 : path.posix).join(homes.claudeDesktop, 'claude_desktop_config.json')
  if (!existsSync(homes.claudeDesktop)) {
    return { agent: 'claude-desktop', item, state: mode === 'remove' ? 'skipped' : 'unavailable', detail: `Claude Desktop is not installed (${homes.claudeDesktop} not found)`, path: file }
  }
  const loaded = await readJsonFile(file)
  if ('error' in loaded) return { agent: 'claude-desktop', item, state: 'failed', detail: `${loaded.error}; left alone`, path: file }
  const value = loaded.value
  const current = typeof value['mcpServers'] === 'object' && value['mcpServers'] !== null && !Array.isArray(value['mcpServers']) ? (value['mcpServers'] as Record<string, unknown>) : {}
  const next = { ...current }
  for (const server of servers) {
    if (mode === 'remove') delete next[server.name]
    else next[server.name] = claudeDesktopEntry(server, ctx)
  }
  if (JSON.stringify(next) === JSON.stringify(current)) {
    return mode === 'remove'
      ? { agent: 'claude-desktop', item, state: 'skipped', detail: `not registered in ${file}`, path: file }
      : { agent: 'claude-desktop', item, state: 'present', detail: `already registered in ${file}`, path: file }
  }
  value['mcpServers'] = next
  await writeJsonFile(file, value, loaded.existed)
  return mode === 'remove'
    ? { agent: 'claude-desktop', item, state: 'removed', detail: `removed from ${file}; restart Claude Desktop to apply`, path: file }
    : { agent: 'claude-desktop', item, state: 'installed', detail: `registered in ${file}; restart Claude Desktop to apply`, path: file }
}

export async function installIntegration(integration: AgentIntegration, options: InstallOptions = {}): Promise<Step[]> {
  const ctx = options.ctx ?? platformContext()
  const homes = agentHomes(ctx, options.homes)
  const agents = await resolveAgents(options, ctx, homes)
  const steps: Step[] = []
  for (const agent of agents) {
    try {
      if (agent === 'claude') steps.push(...(await installClaude(integration, homes, options, ctx)))
      else if (agent === 'opencode') steps.push(...(await installOpenCode(integration, homes, options, ctx)))
      else if (agent === 'codex') steps.push(...(await installCodex(integration, homes, options, ctx)))
      else if (agent === 'gemini') steps.push(...(await installGemini(integration, homes, options, ctx)))
      else steps.push(await editClaudeDesktopMcp(integration, homes, options, ctx, 'install'))
    } catch (error) {
      steps.push({ agent, item: 'integration', state: 'failed', detail: reason(error) })
    }
  }
  return steps
}

export async function uninstallIntegration(integration: AgentIntegration, options: InstallOptions = {}): Promise<Step[]> {
  const ctx = options.ctx ?? platformContext()
  const homes = agentHomes(ctx, options.homes)
  const agents = await resolveAgents({ ...options, agents: options.agents ?? 'all' }, ctx, homes)
  const steps: Step[] = []
  const removed = (agent: AgentName, item: string, ok: boolean, where: string): Step => ({
    agent,
    item,
    state: ok ? 'removed' : 'skipped',
    detail: ok ? `removed ${where}` : `nothing at ${where}`,
    path: where,
  })
  for (const agent of agents) {
    if (agent === 'claude' || agent === 'opencode') {
      const base = agent === 'claude' ? homes.claude : homes.opencode
      for (const skill of integration.skills ?? []) {
        const where = path.join(base, 'skills', skill.name)
        steps.push(removed(agent, `skill ${skill.name}`, await removeOwnedLink(where), where))
      }
      for (const command of agent === 'claude' ? integration.commands ?? [] : markdownCommands(integration)) {
        const where = path.join(base, 'commands', `${command.name}.md`)
        steps.push(removed(agent, `command ${command.name}`, await removeOwnedLink(where), where))
      }
    }
    if (agent === 'claude') {
      const file = path.join(homes.claude, 'settings.json')
      const loaded = await readJsonFile(file)
      if (!('error' in loaded) && loaded.existed) {
        stripClaudeSettings(integration, loaded.value)
        await writeJsonFile(file, loaded.value, true)
        steps.push({ agent, item: 'settings', state: 'removed', detail: `cleaned ${file}`, path: file })
      }
      const claude = await locator(options, ctx)('claude')
      for (const server of integration.mcp ?? []) {
        if (!claude) continue
        const ok = await (options.exec ?? defaultExec)(claude, ['mcp', 'remove', '--scope', 'user', server.name]).then(() => true, () => false)
        steps.push({ agent, item: `mcp ${server.name}`, state: ok ? 'removed' : 'skipped', detail: ok ? 'removed from Claude Code' : 'not registered' })
      }
    }
    if (agent === 'opencode') {
      for (const plugin of integration.opencode?.plugins ?? []) {
        const where = path.join(homes.opencode, 'plugins', `${plugin.name}${path.extname(plugin.file)}`)
        steps.push(removed(agent, `plugin ${plugin.name}`, await removeOwnedLink(where), where))
      }
      if ((integration.mcp ?? []).length > 0) steps.push(await editOpenCodeMcp(integration.mcp ?? [], homes, 'remove'))
    }
    if (agent === 'codex') {
      for (const skill of integration.skills ?? []) {
        const where = path.join(homes.agentsSkills, skill.name)
        steps.push(removed(agent, `skill ${skill.name}`, await removeOwnedLink(where), where))
      }
      for (const command of markdownCommands(integration)) {
        const where = path.join(homes.codex, 'prompts', `${command.name}.md`)
        const ok = existsSync(where)
        await rm(where, { force: true })
        steps.push(removed(agent, `command ${command.name}`, ok, where))
      }
      if (integration.codex?.hooks) {
        const file = path.join(homes.codex, 'hooks.json')
        const loaded = await readJsonFile(file)
        if (!('error' in loaded) && loaded.existed) {
          await writeJsonFile(file, { ...loaded.value, hooks: stripHooks(loaded.value['hooks'], integration.codex.hooks).hooks }, true)
          steps.push({ agent, item: 'hooks', state: 'removed', detail: `cleaned ${file}`, path: file })
        }
      }
      for (const server of integration.mcp ?? []) steps.push(await editCodexMcp(server, homes, 'remove'))
    }
    if (agent === 'gemini') {
      const root = geminiExtensionDir(homes, integration.tool)
      const ok = existsSync(root)
      await rm(root, { recursive: true, force: true })
      steps.push(removed(agent, 'extension', ok, root))
    }
    if (agent === 'claude-desktop') steps.push(await editClaudeDesktopMcp(integration, homes, options, ctx, 'remove'))
  }
  for (const agent of AGENTS) await rm(renderedRoot(ctx, integration.tool, agent), { recursive: true, force: true })
  return steps
}

function stripClaudeSettings(integration: AgentIntegration, value: Record<string, unknown>): number {
  let removed = 0
  const permissions = value['permissions'] as Record<string, unknown> | undefined
  const owned = new Set([...(integration.claude?.permissions?.allow ?? []), ...(integration.claude?.permissions?.ask ?? [])])
  if (permissions && typeof permissions === 'object') {
    for (const key of ['allow', 'ask']) {
      const current = permissions[key]
      if (!Array.isArray(current)) continue
      const kept = current.filter((rule) => !owned.has(rule as string))
      removed += current.length - kept.length
      permissions[key] = kept
    }
  }
  if (integration.claude?.hooks && value['hooks'] !== undefined) {
    const stripped = stripHooks(value['hooks'], integration.claude.hooks)
    value['hooks'] = stripped.hooks
    removed += stripped.removed
  }
  return removed
}

function isInside(target: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function inToolPackage(target: string): boolean {
  return target.split(/[\\/]/).some((segment) => segment === '@kikedealba' || segment.startsWith('@kikedealba+'))
}

async function removeLegacyEntry(where: string, owners: readonly string[], roots: readonly string[], copies: readonly string[] = []): Promise<boolean> {
  const info = await lstat(where).catch(() => null)
  if (!info) return false
  let owned = false
  if (info.isSymbolicLink()) {
    const target = path.resolve(path.dirname(where), await readlink(where))
    owned = owners.some((owner) => path.resolve(owner) === target) || roots.some((root) => isInside(target, root)) || inToolPackage(target)
  } else if (info.isFile() && copies.length > 0) {
    const text = await readFile(where, 'utf8').catch(() => null)
    owned = text !== null && copies.includes(text)
  }
  if (owned) await rm(where, { recursive: true, force: true })
  return owned
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const extra = error as Error & { stdout?: unknown; stderr?: unknown }
  return [error.message, extra.stderr, extra.stdout].filter((part) => typeof part === 'string').join('\n')
}

async function readJsonOutput(exec: NonNullable<InstallOptions['exec']>, claude: string, args: readonly string[]): Promise<unknown[] | null> {
  try {
    const output = await exec(claude, args)
    if (typeof output !== 'string') return null
    const parsed: unknown = JSON.parse(output)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function pluginId(spec: ClaudePluginSpec): string {
  return `${spec.plugin}@${spec.marketplaceName}`
}

async function pluginInstalled(exec: NonNullable<InstallOptions['exec']>, claude: string, spec: ClaudePluginSpec): Promise<boolean | null> {
  const listed = await readJsonOutput(exec, claude, ['plugin', 'list', '--json'])
  if (!listed) return null
  const scope = spec.scope ?? 'user'
  return listed.some((entry) => {
    const record = entry as { id?: unknown; scope?: unknown }
    return record.id === pluginId(spec) && (record.scope === undefined || record.scope === scope)
  })
}

export async function installClaudePlugin(spec: ClaudePluginSpec, options: InstallOptions = {}): Promise<Step[]> {
  const ctx = options.ctx ?? platformContext()
  const id = pluginId(spec)
  const scope = spec.scope ?? 'user'
  const scopeArgs = scope === 'user' ? [] : ['--scope', scope]
  const marketplaceItem = `marketplace ${spec.marketplaceName}`
  const item = `plugin ${id}`
  const claude = await locator(options, ctx)('claude')
  if (!claude) {
    const manual = [
      `claude plugin marketplace add ${spec.marketplace}${scopeArgs.length > 0 ? ` --scope ${scope}` : ''}`,
      `claude plugin marketplace update ${spec.marketplaceName}`,
      `claude plugin install ${id} --scope ${scope}`,
    ]
    return [{ agent: 'claude', item, state: 'unavailable', detail: `claude is not on PATH; run: ${manual.join(' && ')}` }]
  }
  const exec = options.exec ?? defaultExec
  const steps: Step[] = []
  const marketplaces = await readJsonOutput(exec, claude, ['plugin', 'marketplace', 'list', '--json'])
  if (marketplaces?.some((entry) => (entry as { name?: unknown }).name === spec.marketplaceName)) {
    steps.push({ agent: 'claude', item: marketplaceItem, state: 'present', detail: `marketplace ${spec.marketplaceName} already added` })
  } else {
    try {
      await exec(claude, ['plugin', 'marketplace', 'add', spec.marketplace, ...scopeArgs])
      steps.push({ agent: 'claude', item: marketplaceItem, state: 'installed', detail: `marketplace ${spec.marketplace} added` })
    } catch (error) {
      if (!/already/i.test(errorText(error))) {
        steps.push({ agent: 'claude', item: marketplaceItem, state: 'failed', detail: `claude plugin marketplace add failed: ${reason(error)}` })
        return steps
      }
      steps.push({ agent: 'claude', item: marketplaceItem, state: 'present', detail: `marketplace ${spec.marketplaceName} already added` })
    }
  }
  let stale = ''
  try {
    await exec(claude, ['plugin', 'marketplace', 'update', spec.marketplaceName])
  } catch (error) {
    stale = ' from the cached catalog, which may be out of date'
    steps.push({ agent: 'claude', item: marketplaceItem, state: 'failed', detail: `claude plugin marketplace update failed: ${reason(error)}` })
  }
  const update = (): Promise<unknown> => exec(claude, ['plugin', 'update', id, '--scope', scope])
  const updated: Step = { agent: 'claude', item, state: 'installed', detail: `plugin ${id} updated${stale}; restart Claude Code to apply` }
  const installed: Step = { agent: 'claude', item, state: 'installed', detail: `plugin ${id} installed (scope ${scope})${stale}; restart Claude Code to apply` }
  const known = await pluginInstalled(exec, claude, spec)
  if (known === true) {
    try {
      await update()
      steps.push(updated)
    } catch (error) {
      steps.push({ agent: 'claude', item, state: 'failed', detail: `claude plugin update failed: ${reason(error)}` })
    }
    return steps
  }
  try {
    await exec(claude, ['plugin', 'install', id, '--scope', scope])
    if (known === null) await update().catch(() => undefined)
    steps.push(installed)
  } catch (error) {
    if (!/already/i.test(errorText(error))) {
      steps.push({ agent: 'claude', item, state: 'failed', detail: `claude plugin install failed: ${reason(error)}` })
      return steps
    }
    try {
      await update()
      steps.push(updated)
    } catch (updateError) {
      steps.push({ agent: 'claude', item, state: 'failed', detail: `claude plugin install failed: ${reason(error)}; update failed: ${reason(updateError)}` })
    }
  }
  return steps
}

export async function uninstallClaudePlugin(spec: ClaudePluginSpec, options: InstallOptions = {}): Promise<Step[]> {
  const ctx = options.ctx ?? platformContext()
  const id = pluginId(spec)
  const scope = spec.scope ?? 'user'
  const item = `plugin ${id}`
  const claude = await locator(options, ctx)('claude')
  if (!claude) return [{ agent: 'claude', item, state: 'unavailable', detail: `claude is not on PATH; run: claude plugin uninstall ${id} --scope ${scope}` }]
  const exec = options.exec ?? defaultExec
  const known = await pluginInstalled(exec, claude, spec)
  if (known === false) return [{ agent: 'claude', item, state: 'skipped', detail: `plugin ${id} is not installed` }]
  try {
    await exec(claude, ['plugin', 'uninstall', id, '--scope', scope])
    return [{ agent: 'claude', item, state: 'removed', detail: `plugin ${id} uninstalled from Claude Code` }]
  } catch (error) {
    if (known === null && /not (?:installed|found)/i.test(errorText(error))) return [{ agent: 'claude', item, state: 'skipped', detail: `plugin ${id} is not installed` }]
    return [{ agent: 'claude', item, state: 'failed', detail: `claude plugin uninstall failed: ${reason(error)}` }]
  }
}

export async function removeLegacyClaude(integration: AgentIntegration, options: InstallOptions = {}): Promise<Step[]> {
  const ctx = options.ctx ?? platformContext()
  const homes = agentHomes(ctx, options.homes)
  const rendered = renderedRoot(ctx, integration.tool, 'claude')
  const steps: Step[] = []
  const result = (item: string, ok: boolean, where: string): Step => ({
    agent: 'claude',
    item,
    state: ok ? 'removed' : 'skipped',
    detail: ok ? `removed legacy ${where}` : `nothing kit owns at ${where}`,
    path: where,
  })
  for (const skill of integration.skills ?? []) {
    const where = path.join(homes.claude, 'skills', skill.name)
    steps.push(result(`skill ${skill.name}`, await removeLegacyEntry(where, [skill.dir], [rendered]), where))
  }
  for (const command of integration.commands ?? []) {
    const where = path.join(homes.claude, 'commands', `${command.name}.md`)
    const source = await readFile(command.file, 'utf8').catch(() => null)
    const copies = source === null ? [] : [source, renderForAgent(source, 'claude')]
    steps.push(result(`command ${command.name}`, await removeLegacyEntry(where, [command.file], [rendered], copies), where))
  }
  if (integration.claude?.permissions || integration.claude?.hooks) {
    const file = path.join(homes.claude, 'settings.json')
    const loaded = await readJsonFile(file)
    if ('error' in loaded) {
      steps.push({ agent: 'claude', item: 'settings', state: 'failed', detail: `${loaded.error}; left alone`, path: file })
    } else if (loaded.existed) {
      const removed = stripClaudeSettings(integration, loaded.value)
      if (removed > 0) await writeJsonFile(file, loaded.value, true)
      steps.push({ agent: 'claude', item: 'settings', state: removed > 0 ? 'removed' : 'skipped', detail: removed > 0 ? `removed ${removed} legacy settings from ${file}` : 'no legacy settings', path: file })
    }
  }
  if (!options.skipMcp && (integration.mcp ?? []).length > 0) {
    const claude = await locator(options, ctx)('claude')
    const exec = options.exec ?? defaultExec
    for (const server of integration.mcp ?? []) {
      if (!claude) {
        steps.push({ agent: 'claude', item: `mcp ${server.name}`, state: 'unavailable', detail: `claude is not on PATH; run: claude mcp remove --scope user ${server.name}` })
        continue
      }
      const ok = await exec(claude, ['mcp', 'remove', '--scope', 'user', server.name]).then(() => true, () => false)
      steps.push({ agent: 'claude', item: `mcp ${server.name}`, state: ok ? 'removed' : 'skipped', detail: ok ? 'removed legacy MCP server from Claude Code' : 'not registered' })
    }
  }
  await rm(rendered, { recursive: true, force: true })
  return steps
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] ?? 'failed' : String(error)
}
