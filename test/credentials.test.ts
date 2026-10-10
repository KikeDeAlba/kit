import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { credentialStore, fileStore, macosKeychain, resolveSecret, secretService, windowsCredentialManager, type Runner } from '../src/credentials.ts'
import { platformContext } from '../src/platform.ts'
import { tempDir } from './helpers.ts'

function fakeRunner(): { runner: Runner; calls: Array<{ command: string; args: readonly string[]; input?: string | undefined }>; values: Map<string, string> } {
  const values = new Map<string, string>()
  const calls: Array<{ command: string; args: readonly string[]; input?: string | undefined }> = []
  const runner: Runner = async (command, args, input) => {
    calls.push({ command, args, input })
    const pick = (...flags: string[]) => {
      for (const flag of flags) if (args.includes(flag)) return args[args.indexOf(flag) + 1]
      return undefined
    }
    const service = pick('-s', 'service')
    const account = pick('-a', 'account')
    const key = `${service}|${account}`
    const verb = args[0]
    if (verb === 'add-generic-password') values.set(key, args[args.indexOf('-w') + 1] ?? '')
    if (verb === 'store') values.set(key, input ?? '')
    if (verb === 'find-generic-password' || verb === 'lookup') {
      const value = values.get(key)
      if (value === undefined) throw Object.assign(new Error('not found'), { code: verb === 'lookup' ? 1 : 44 })
      return `${value}\n`
    }
    if (verb === 'delete-generic-password' || verb === 'clear') {
      if (!values.delete(key)) throw Object.assign(new Error('could not be found'), { code: 44 })
    }
    return ''
  }
  return { runner, calls, values }
}

test('macOS keychain backend round-trips secrets', async () => {
  const { runner } = fakeRunner()
  const store = macosKeychain(runner)
  assert.equal(await store.get('atl', 'me@x'), null)
  await store.set('atl', 'me@x', 's3cret')
  assert.equal(await store.get('atl', 'me@x'), 's3cret')
  assert.equal(await store.delete('atl', 'me@x'), true)
  assert.equal(await store.delete('atl', 'me@x'), false)
})

test('secret service backend passes the secret on stdin', async () => {
  const { runner, calls } = fakeRunner()
  const store = secretService('/usr/bin/secret-tool', runner)
  await store.set('atl', 'me', 'tok')
  assert.equal(calls[0]?.input, 'tok')
  assert.ok(!calls[0]?.args.includes('tok'))
  assert.equal(await store.get('atl', 'me'), 'tok')
  assert.equal(await store.delete('atl', 'me'), true)
  assert.equal(await store.get('atl', 'me'), null)
})

test('windows backend sends the secret on stdin and maps not-found', async () => {
  const seen: Array<{ env: NodeJS.ProcessEnv; input?: string | undefined }> = []
  const store = windowsCredentialManager(async (script, env, input) => {
    seen.push({ env, input })
    if (script.includes('CredReadW($target')) throw Object.assign(new Error('missing'), { code: 3 })
    return ''
  })
  await store.set('atl', 'me', 'tok')
  assert.equal(seen[0]?.input, 'tok')
  assert.equal(seen[0]?.env['KIT_CRED_TARGET'], 'atl:me')
  assert.equal(await store.get('atl', 'me'), null)
})

test('file backend keeps the file private', async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, 'creds', 'credentials.json')
  const store = fileStore(file)
  await store.set('atl', 'me', 'tok')
  assert.equal(await store.get('atl', 'me'), 'tok')
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.equal(await store.delete('atl', 'me'), true)
  assert.equal(await store.get('atl', 'me'), null)
})

test('the environment wins over the store and KIT_CREDENTIALS=file forces the file backend', async (t) => {
  const dir = await tempDir(t)
  const ctx = platformContext({ home: dir, env: { KIT_CREDENTIALS: 'file', XDG_CONFIG_HOME: dir, APPDATA: dir, ATL_TOKEN: 'from-env' } })
  const store = await credentialStore(ctx)
  assert.equal(store.backend, 'file')
  await store.set('atl', 'me', 'stored')
  assert.equal(await resolveSecret('atl', 'me', { envVar: 'ATL_TOKEN', store, ctx }), 'from-env')
  assert.equal(await resolveSecret('atl', 'me', { envVar: 'NOPE', store, ctx }), 'stored')
})
