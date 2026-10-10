import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { dataHome, platformContext, run, which, type PlatformContext } from '../platform.ts'
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
import { commandForCodex, commandToGeminiToml, hasAgentBlocks, renderForAgent } from './markdown.ts'
import {
  AGENTS,
  type AgentHomes,
  type AgentIntegration,
  type AgentName,
  type CommandSource,
  type InstallOptions,
  type McpServer,
  type SkillSource,
  type Step,
} from './types.ts'

export * from './types.ts'
export { commandToGeminiToml, commandForCodex, renderForAgent, hasAgentBlocks, parseFrontmatter } from './markdown.ts'
export { mergeHooks, stripHooks } from './files.ts'

const BINARIES: Record<AgentName, string> = { claude: 'claude', opencode: 'opencode', codex: 'codex', gemini: 'gemini' }

export function agentHomes(ctx: PlatformContext = platformContext(), overrides: Partial<AgentHomes> = {}): AgentHomes {
  const join = ctx.platform === 'win32' ? path.win32.join : path.posix.join
  return {
    claude: overrides.claude ?? ctx.env['CLAUDE_CONFIG_DIR'] ?? join(ctx.home, '.claude'),
    opencode: overrides.opencode ?? join(ctx.env['XDG_CONFIG_HOME'] ?? join(ctx.home, '.config'), 'opencode'),
    codex: overrides.codex ?? ctx.env['CODEX_HOME'] ?? join(ctx.home, '.codex'),
    agentsSkills: overrides.agentsSkills ?? join(ctx.env['KIT_AGENTS_HOME'] ?? join(ctx.home, '.agents'), 'skills'),
    gemini: overrides.gemini ?? join(ctx.env['GEMINI_CLI_HOME'] ?? ctx.home, '.gemini'),
  }
}

export async function detectAgents(
  ctx: PlatformContext = platformContext(),
  homes: AgentHomes = agentHomes(ctx),
  locate: (command: string) => Promise<string | null> = (command) => which(command, ctx),
): Promise<AgentName[]> {
  const found: AgentName[] = []
  const configDir: Record<AgentName, string> = { claude: homes.claude, opencode: homes.opencode, codex: homes.codex, gemini: homes.gemini }
  for (const agent of AGENTS) {
    if (existsSync(configDir[agent]) || (await locate(BINARIES[agent])) !== null) found.push(agent)
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

async function placeMarkdownCommand(command: CommandSource, destination: string, agent: AgentName, integration: AgentIntegration, ctx: PlatformContext): Promise<Step> {
  try {
    const text = await readFile(command.file, 'utf8')
    if (hasAgentBlocks(text)) {
      const rendered = path.join(renderedRoot(ctx, integration.tool, agent), 'commands', `${command.name}.md`)
      await mkdir(path.dirname(rendered), { recursive: true })
      await writeFile(rendered, renderForAgent(text, agent))
      await linkPath(rendered, destination, ctx.platform)
      return { agent, item: `command ${command.name}`, state: 'installed', detail: `command ${command.name} rendered for ${agent}`, path: destination }
    }
    const state = await linkPath(command.file, destination, ctx.platform)
    return { agent, item: `command ${command.name}`, state, detail: `command ${command.name} linked`, path: destination }
  } catch (error) {
    return { agent, item: `command ${command.name}`, state: 'failed', detail: reason(error), path: destination }
  }
}

async function defaultExec(command: string, args: readonly string[]): Promise<void> {
  await run(command, args, { timeoutMs: 60_000 })
}

async function installClaude(integration: AgentIntegration, homes: AgentHomes, options: InstallOptions, ctx: PlatformContext): Promise<Step[]> {
  const steps: Step[] = []
  for (const skill of integration.skills ?? []) steps.push(await placeSkill(skill, path.join(homes.claude, 'skills', skill.name), 'claude', integration, ctx))
  for (const command of integration.commands ?? []) {
    steps.push(await placeMarkdownCommand(command, path.join(homes.claude, 'commands', `${command.name}.md`), 'claude', integration, ctx))
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
  const claude = await (options.locate ?? ((command: string) => which(command, ctx)))('claude')
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

async function installOpenCode(integration: AgentIntegration, homes: AgentHomes, options: InstallOptions, ctx: PlatformContext): Promise<Step[]> {
  const steps: Step[] = []
  for (const skill of integration.skills ?? []) steps.push(await placeSkill(skill, path.join(homes.opencode, 'skills', skill.name), 'opencode', integration, ctx))
  for (const command of integration.commands ?? []) {
    steps.push(await placeMarkdownCommand(command, path.join(homes.opencode, 'commands', `${command.name}.md`), 'opencode', integration, ctx))
  }
  for (const plugin of integration.opencode?.plugins ?? []) {
    const destination = path.join(homes.opencode, 'plugins', `${plugin.name}${path.extname(plugin.file)}`)
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
  for (const command of integration.commands ?? []) {
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
  if ((integration.commands ?? []).length > 0) {
    const commandsDir = path.join(root, 'commands')
    await rm(commandsDir, { recursive: true, force: true })
    await mkdir(commandsDir, { recursive: true })
    for (const command of integration.commands ?? []) {
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
      else steps.push(...(await installGemini(integration, homes, options, ctx)))
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
      for (const command of integration.commands ?? []) {
        const where = path.join(base, 'commands', `${command.name}.md`)
        steps.push(removed(agent, `command ${command.name}`, await removeOwnedLink(where), where))
      }
    }
    if (agent === 'claude') {
      const file = path.join(homes.claude, 'settings.json')
      const loaded = await readJsonFile(file)
      if (!('error' in loaded) && loaded.existed) {
        const value = loaded.value
        const permissions = value['permissions'] as Record<string, string[]> | undefined
        const owned = new Set([...(integration.claude?.permissions?.allow ?? []), ...(integration.claude?.permissions?.ask ?? [])])
        if (permissions) for (const key of ['allow', 'ask']) if (Array.isArray(permissions[key])) permissions[key] = permissions[key].filter((rule) => !owned.has(rule))
        if (integration.claude?.hooks) value['hooks'] = stripHooks(value['hooks'], integration.claude.hooks).hooks
        await writeJsonFile(file, value, true)
        steps.push({ agent, item: 'settings', state: 'removed', detail: `cleaned ${file}`, path: file })
      }
      const claude = await (options.locate ?? ((command: string) => which(command, ctx)))('claude')
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
      for (const command of integration.commands ?? []) {
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
  }
  for (const agent of AGENTS) await rm(renderedRoot(ctx, integration.tool, agent), { recursive: true, force: true })
  return steps
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] ?? 'failed' : String(error)
}
