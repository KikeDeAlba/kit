import assert from 'node:assert/strict'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { childEnvironment, configHome, dataHome, openCommand, pathDelimiter, platformContext, searchPath, stateHome, toolDirs, which } from '../src/platform.ts'
import { compareVersions, satisfiesMinimum } from '../src/semver.ts'
import { parseEnvelope, successEnvelope, errorEnvelope, isEnvelope } from '../src/envelope.ts'
import { tempDir } from './helpers.ts'

test('directories follow each platform convention', () => {
  const mac = platformContext({ platform: 'darwin', home: '/Users/a', env: {} })
  assert.equal(configHome(mac), '/Users/a/.config')
  assert.equal(dataHome(mac), '/Users/a/.local/share')
  assert.equal(stateHome(mac), '/Users/a/.local/state')

  const linux = platformContext({ platform: 'linux', home: '/home/a', env: { XDG_CONFIG_HOME: '/cfg', XDG_DATA_HOME: '/data' } })
  assert.equal(configHome(linux), '/cfg')
  assert.deepEqual(toolDirs('bita', linux), { config: '/cfg/bita', data: '/data/bita', state: '/home/a/.local/state/bita' })

  const win = platformContext({ platform: 'win32', home: 'C:\\Users\\a', env: { APPDATA: 'C:\\Users\\a\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' } })
  assert.equal(configHome(win), 'C:\\Users\\a\\AppData\\Roaming')
  assert.equal(toolDirs('atl', win).data, 'C:\\Users\\a\\AppData\\Local\\atl')
  assert.equal(pathDelimiter(win), ';')
  assert.deepEqual(openCommand('x', win).command, 'cmd')
  assert.deepEqual(openCommand('x', linux).command, 'xdg-open')
})

test('search path keeps PATH first and removes duplicates', () => {
  const ctx = platformContext({ platform: 'linux', home: '/home/a', env: { PATH: '/usr/bin:/custom' } })
  const dirs = searchPath(ctx, ['/extra']).split(':')
  assert.deepEqual(dirs.slice(0, 3), ['/extra', '/usr/bin', '/custom'])
  assert.equal(dirs.filter((dir) => dir === '/usr/bin').length, 1)
  assert.equal(childEnvironment(ctx, [], { FOO: '1' })['FOO'], '1')
})

test('which finds executables in extra directories', async (t) => {
  const dir = await tempDir(t)
  const bin = path.join(dir, 'bin')
  await mkdir(bin)
  const file = path.join(bin, 'kit-demo-tool')
  await writeFile(file, '#!/bin/sh\n')
  await chmod(file, 0o755)
  const ctx = platformContext({ home: dir, env: { PATH: '' } })
  assert.equal(await which('kit-demo-tool', ctx, [bin]), file)
  assert.equal(await which('kit-not-there', ctx, [bin]), null)
})

test('versions compare numerically', () => {
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1)
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0)
  assert.equal(satisfiesMinimum('0.16.0', '0.16.0'), true)
  assert.equal(satisfiesMinimum('0.15.9', '0.16.0'), false)
  assert.equal(satisfiesMinimum('0.1.0', undefined), true)
})

test('envelopes round-trip and the last envelope line wins', () => {
  const ok = successEnvelope(3, 'ls', { items: [] })
  const bad = errorEnvelope(3, 'ls', { code: 'X', message: 'y' })
  assert.ok(isEnvelope(ok) && isEnvelope(bad))
  assert.equal(isEnvelope({ ...bad, error: undefined }), false)
  const parsed = parseEnvelope(`noise\n${JSON.stringify(bad)}\n${JSON.stringify(ok)}\n`)
  assert.equal(parsed?.ok, true)
  assert.equal(parseEnvelope('not json'), null)
})

test('child processes get the running node on PATH', async () => {
  const { withRuntimePath } = await import('../src/platform.ts')
  const separator = process.platform === 'win32' ? ';' : ':'
  const env = withRuntimePath({ PATH: ['/usr/bin', '/bin'].join(separator) }, path.join(path.sep, 'opt', 'node', 'bin', 'node'))
  assert.equal(env['PATH']?.split(separator)[0], path.join(path.sep, 'opt', 'node', 'bin'))
  const again = withRuntimePath(env, path.join(path.sep, 'opt', 'node', 'bin', 'node'))
  assert.equal(again['PATH'], env['PATH'])
})
