import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises'
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
