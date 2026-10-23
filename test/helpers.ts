import { chmod, cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { platformContext, type PlatformContext } from '../src/platform.ts'

export async function tempDir(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'kit-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

export function sandbox(home: string, extraEnv: NodeJS.ProcessEnv = {}): PlatformContext {
  return platformContext({
    home,
    env: {
      PATH: process.env['PATH'] ?? '',
      KIT_REGISTRY_DIR: path.join(home, 'registry'),
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
      ...extraEnv,
    },
  })
}

export async function fakeTool(dir: string, name: string, body: string): Promise<string> {
  const file = path.join(dir, `${name}.mjs`)
  await writeFile(file, body)
  await chmod(file, 0o755)
  return file
}

export const CONFORMING_TOOL = `
const args = process.argv.slice(2)
const json = args.includes('--json')
const command = args.find((arg) => arg !== '--json')
const envelope = (ok, cmd, payload) => JSON.stringify({ schemaVersion: 1, ok, command: cmd, generatedAt: new Date().toISOString(), ...payload })
if (command === 'capabilities') {
  console.log(envelope(true, 'capabilities', { data: { name: 'demo', version: '1.2.3', envelope: 1, capabilities: ['demo.read', 'demo.write'], emits: ['changed'] } }))
  process.exit(0)
}
if (json) console.log(envelope(false, command ?? '', { error: { code: 'UNKNOWN_COMMAND', message: 'unknown' } }))
process.exit(2)
`

export interface FakeAgy {
  calls: string[]
  exec: (command: string, args: readonly string[]) => Promise<string | void>
  locate: (command: string) => Promise<string | null>
}

export function fakeAgy(homes: { antigravity: string }, options: { validate?: Error } = {}): FakeAgy {
  const calls: string[] = []
  const plugins = path.join(homes.antigravity, 'plugins')
  return {
    calls,
    locate: async (command) => (command === 'agy' ? '/bin/agy' : null),
    exec: async (command, args) => {
      if (command !== '/bin/agy') throw new Error(`unexpected command ${command}`)
      calls.push(args.join(' '))
      const [verb, action, target] = args
      if (verb !== 'plugin') throw new Error(`unknown agy command ${args.join(' ')}`)
      if (action === 'list') {
        const names = await readdir(plugins).catch(() => [] as string[])
        return JSON.stringify(names.map((name) => ({ name, enabled: true, version: '0.0.0', source: 'local', path: path.join(plugins, name), skills: [], agents: [], rules: [] })))
      }
      if (action === 'validate') {
        if (options.validate) throw options.validate
        return JSON.stringify({ ok: true })
      }
      if (action === 'install' && target) {
        const manifest = JSON.parse(await readFile(path.join(target, 'plugin.json'), 'utf8')) as { name: string }
        const destination = path.join(plugins, manifest.name)
        await rm(destination, { recursive: true, force: true })
        await cp(target, destination, { recursive: true })
        return ''
      }
      if (action === 'uninstall' && target) {
        await rm(path.join(plugins, target), { recursive: true, force: true })
        return ''
      }
      throw new Error(`unknown agy command ${args.join(' ')}`)
    },
  }
}
