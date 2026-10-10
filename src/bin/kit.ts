#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { errorEnvelope, successEnvelope, writeJson } from '../envelope.ts'
import { registryListeners } from '../events.ts'
import { isInstalled, listTools, probeCapabilities, registryDir } from '../registry.ts'
import { agentHomes, detectAgents } from '../agents/index.ts'

const SCHEMA_VERSION = 1

function version(): string {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  return (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }).version
}

const HELP = `kit ${version()}

Usage:
  kit ls                 list the tools registered on this machine
  kit doctor             check that every registered tool answers
  kit events <tool>      list who listens to a tool's events
  kit agents             list the coding agents found on this machine
  kit capabilities       describe kit itself

Every command accepts --json.`

async function main(argv: string[]): Promise<number> {
  const json = argv.includes('--json')
  const [command, ...rest] = argv.filter((arg) => arg !== '--json')

  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(`${HELP}\n`)
    return 0
  }
  if (command === '--version' || command === '-v') {
    process.stdout.write(`${version()}\n`)
    return 0
  }

  if (command === 'capabilities') {
    const data = { name: 'kit', version: version(), envelope: 1, capabilities: ['registry.read'], emits: [] }
    if (json) writeJson(successEnvelope(SCHEMA_VERSION, 'capabilities', data))
    else process.stdout.write(`kit ${data.version}: ${data.capabilities.join(', ')}\n`)
    return 0
  }

  if (command === 'ls') {
    const tools = (await listTools()).map((manifest) => ({ ...manifest, installed: isInstalled(manifest) }))
    if (json) {
      writeJson(successEnvelope(SCHEMA_VERSION, 'ls', { registry: registryDir(), tools }))
      return 0
    }
    if (tools.length === 0) process.stdout.write(`No tools registered in ${registryDir()}\n`)
    for (const tool of tools) {
      process.stdout.write(`${tool.name.padEnd(10)} ${tool.version.padEnd(9)} ${tool.installed ? '' : '(binary missing) '}${tool.capabilities.join(', ')}\n`)
    }
    return 0
  }

  if (command === 'doctor') {
    const results = []
    for (const manifest of await listTools()) {
      const live = isInstalled(manifest) ? await probeCapabilities(manifest.bin) : null
      results.push({
        name: manifest.name,
        registered: manifest.version,
        running: live?.version ?? null,
        ok: live !== null && live.version === manifest.version,
        detail: live === null ? 'does not answer capabilities --json' : live.version === manifest.version ? 'ok' : 'registry is stale; run its setup again',
      })
    }
    if (json) writeJson(successEnvelope(SCHEMA_VERSION, 'doctor', { tools: results }))
    else for (const result of results) process.stdout.write(`${result.ok ? '-' : '!'} ${result.name}: ${result.detail}\n`)
    return results.every((result) => result.ok) ? 0 : 1
  }

  if (command === 'events') {
    const tool = rest[0]
    if (!tool) return fail(json, 'events', 'USAGE', 'Usage: kit events <tool>')
    const listeners = await registryListeners(tool)
    if (json) writeJson(successEnvelope(SCHEMA_VERSION, 'events', { tool, listeners }))
    else for (const listener of listeners) process.stdout.write(`${listener.owner}: ${listener.events.join(',')} -> ${listener.command.join(' ')}\n`)
    return 0
  }

  if (command === 'agents') {
    const homes = agentHomes()
    const agents = await detectAgents()
    if (json) writeJson(successEnvelope(SCHEMA_VERSION, 'agents', { agents, homes }))
    else process.stdout.write(`${agents.length > 0 ? agents.join(', ') : 'no coding agents found'}\n`)
    return 0
  }

  return fail(json, command, 'UNKNOWN_COMMAND', `Unknown command "${command}". Run kit help.`)
}

function fail(json: boolean, command: string, code: string, message: string): number {
  if (json) writeJson(errorEnvelope(SCHEMA_VERSION, command, { code, message }))
  else process.stderr.write(`${message}\n`)
  return 2
}

process.exitCode = await main(process.argv.slice(2))
