import assert from 'node:assert/strict'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { childEnvironment, configHome, dataHome, notify, notifyCommand, openCommand, pathDelimiter, platformContext, run, searchPath, spawnSpec, stateHome, toolDirs, which, whichSync } from '../src/platform.ts'
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
  assert.equal(whichSync('kit-demo-tool', ctx, [bin]), file)
  assert.equal(whichSync('kit-demo-tool', ctx, [], [bin]), file)
  assert.equal(whichSync(file, ctx), file)
  assert.equal(await which('kit-demo-tool', ctx, [], [bin]), file)
})

test('spawnSpec wraps batch files in cmd.exe with escaped arguments', () => {
  const win = platformContext({ platform: 'win32', home: 'C:\\Users\\a', env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' } })
  const spec = spawnSpec('C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd', ['-p', 'a b', 'x"y&z', 'trail\\'], win)
  assert.equal(spec.command, 'C:\\Windows\\system32\\cmd.exe')
  assert.equal(spec.windowsVerbatimArguments, true)
  assert.deepEqual(spec.args.slice(0, 3), ['/d', '/s', '/c'])
  assert.equal(spec.args[3], '"C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd ^^^"-p^^^" ^^^"a^^^ b^^^" ^^^"x\\^^^"y^^^&z^^^" ^^^"trail\\\\^^^""')
  assert.equal(spawnSpec('C:\\Program Files\\tool\\x.BAT', [], win).args[3], '"C:\\Program^ Files\\tool\\x.BAT"')
  assert.equal(spawnSpec('x.cmd', [], platformContext({ platform: 'win32', home: 'C:\\Users\\a', env: {} })).command, 'cmd.exe')
  assert.deepEqual(spawnSpec('C:\\bin\\agy.exe', ['a b'], win), { command: 'C:\\bin\\agy.exe', args: ['a b'], windowsVerbatimArguments: false })
  assert.deepEqual(spawnSpec('/usr/bin/x.cmd', ['a'], platformContext({ platform: 'linux', home: '/h', env: {} })), { command: '/usr/bin/x.cmd', args: ['a'], windowsVerbatimArguments: false })
})

test('run still executes plain commands after adopting spawnSpec', { skip: process.platform === 'win32' }, async () => {
  assert.equal((await run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', 'a "b" & c'])).stdout, 'a "b" & c')
  assert.equal((await run(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'piped' })).stdout, 'piped')
})

test('notifications use the native tool of each platform and never throw', async (t) => {
  const mac = notifyCommand('Ti"tle', 'Bo$dy', platformContext({ platform: 'darwin', home: '/h', env: {} }))
  assert.equal(mac.command, 'osascript')
  assert.deepEqual(mac.args.slice(-2), ['Ti"tle', 'Bo$dy'])
  assert.ok(mac.args.includes('on run argv'))
  assert.deepEqual(notifyCommand('T', '-B', platformContext({ platform: 'linux', home: '/h', env: {} })), { command: 'notify-send', args: ['--', 'T', '-B'] })
  const win = notifyCommand("it's", 'ü & <x>', platformContext({ platform: 'win32', home: 'C:\\h', env: {} }))
  assert.equal(win.command, 'powershell.exe')
  assert.equal(win.args.at(-2), '-EncodedCommand')
  const script = Buffer.from(win.args.at(-1) ?? '', 'base64').toString('utf16le')
  assert.match(script, /ToastNotificationManager/)
  assert.ok(script.includes(Buffer.from("it's").toString('base64')))
  assert.ok(script.includes(Buffer.from('ü & <x>').toString('base64')))
  assert.ok(!script.includes("it's"))
  const home = await tempDir(t)
  assert.equal(await notify('t', 'b', { ctx: platformContext({ platform: 'win32', home, env: { PATH: '' } }) }), false)
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
