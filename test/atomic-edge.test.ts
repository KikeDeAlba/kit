import assert from 'node:assert/strict'
import { chmodSync, lstatSync, readdirSync, readlinkSync, statSync } from 'node:fs'
import { mkdir, readFile, symlink, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { resolveWriteTarget, withFileLock, writeFileAtomic } from '../src/atomic.ts'
import { tempDir } from './helpers.ts'

const posixOnly = process.platform === 'win32' ? 'symlinks and modes need POSIX' : false

test('concurrent atomic writes to the same file all succeed and leave one complete value', async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, 'settings.json')
  const values = Array.from({ length: 40 }, (_, index) => `${JSON.stringify({ writer: index, pad: 'x'.repeat(2000) })}\n`)
  const results = await Promise.allSettled(values.map((value) => writeFileAtomic(file, value, { mode: 0o600 })))
  assert.equal(results.filter((result) => result.status === 'rejected').length, 0)
  assert.ok(values.includes(await readFile(file, 'utf8')))
  assert.deepEqual(readdirSync(dir), ['settings.json'])
})

test('concurrent atomic writes through a symlink all succeed and keep the link', { skip: posixOnly }, async (t) => {
  const dir = await tempDir(t)
  const real = path.join(dir, 'real.json')
  const link = path.join(dir, 'link.json')
  await writeFile(real, '{}')
  await symlink(real, link)
  const values = Array.from({ length: 40 }, (_, index) => `{"writer":${index}}\n`)
  const results = await Promise.allSettled(values.map((value) => writeFileAtomic(link, value)))
  assert.equal(results.filter((result) => result.status === 'rejected').length, 0)
  assert.ok(lstatSync(link).isSymbolicLink())
  assert.ok(values.includes(await readFile(real, 'utf8')))
  assert.deepEqual(readdirSync(dir).sort(), ['link.json', 'real.json'])
})

test('writeFileAtomic follows relative links, link chains and links into other directories', { skip: posixOnly }, async (t) => {
  const dir = await tempDir(t)
  await mkdir(path.join(dir, 'a'))
  await mkdir(path.join(dir, 'b'))
  const real = path.join(dir, 'b', 'real.txt')
  await writeFile(real, 'old')
  await symlink('../b/real.txt', path.join(dir, 'a', 'hop1'))
  await symlink('hop1', path.join(dir, 'a', 'hop2'))
  const written = await writeFileAtomic(path.join(dir, 'a', 'hop2'), 'new')
  assert.equal(written, await resolveWriteTarget(real))
  assert.equal(await readFile(real, 'utf8'), 'new')
  assert.equal(readlinkSync(path.join(dir, 'a', 'hop1')), '../b/real.txt')
  assert.equal(readlinkSync(path.join(dir, 'a', 'hop2')), 'hop1')
  assert.deepEqual(readdirSync(path.join(dir, 'a')).sort(), ['hop1', 'hop2'])
  assert.deepEqual(readdirSync(path.join(dir, 'b')), ['real.txt'])
})

test('writeFileAtomic applies the mode to the file behind the link, not to the link', { skip: posixOnly }, async (t) => {
  const dir = await tempDir(t)
  const real = path.join(dir, 'real.json')
  await writeFile(real, '{}', { mode: 0o644 })
  chmodSync(real, 0o644)
  await symlink(real, path.join(dir, 'link.json'))
  await writeFileAtomic(path.join(dir, 'link.json'), '{"a":1}', { mode: 0o600 })
  assert.equal(statSync(real).mode & 0o777, 0o600)
  assert.ok(lstatSync(path.join(dir, 'link.json')).isSymbolicLink())
})

test('writeFileAtomic keeps the mode of an existing file when none is requested', { skip: posixOnly }, async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, 'settings.json')
  await writeFile(file, '{}', { mode: 0o600 })
  chmodSync(file, 0o600)
  const previous = process.umask(0o022)
  try {
    await writeFileAtomic(file, '{"a":1}')
  } finally {
    process.umask(previous)
  }
  assert.equal(statSync(file).mode & 0o777, 0o600)
})

test('writeFileAtomic does not replace a dangling symlink with a regular file', { skip: posixOnly }, async (t) => {
  const dir = await tempDir(t)
  const link = path.join(dir, 'link.json')
  const missing = path.join(dir, 'missing.json')
  await symlink(missing, link)
  await writeFileAtomic(link, '{}')
  assert.ok(lstatSync(link).isSymbolicLink())
})

test('writeFileAtomic leaves no temporary file when the rename fails and keeps the original untouched', async (t) => {
  const dir = await tempDir(t)
  const target = path.join(dir, 'target')
  await mkdir(path.join(target, 'inner'), { recursive: true })
  await assert.rejects(writeFileAtomic(target, 'x'))
  assert.deepEqual(readdirSync(dir), ['target'])
  assert.deepEqual(readdirSync(target), ['inner'])
})

test('writeFileAtomic creates missing parents, honours dirMode and writes empty content', { skip: posixOnly }, async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, 'x', 'y', 'z.txt')
  assert.equal(await writeFileAtomic(file, '', { mode: 0o600, dirMode: 0o700 }), file)
  assert.equal(await readFile(file, 'utf8'), '')
  assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700)
  assert.equal(statSync(file).mode & 0o777, 0o600)
})

test('withFileLock serialises writers and replaces a lock left by a dead process or too old', async (t) => {
  const dir = await tempDir(t)
  const file = path.join(dir, 'data.json')
  await writeFile(file, '0')
  await Promise.all(Array.from({ length: 20 }, () => withFileLock(file, async () => {
    const value = Number(await readFile(file, 'utf8'))
    await new Promise((resolve) => setTimeout(resolve, 1))
    await writeFileAtomic(file, String(value + 1))
  })))
  assert.equal(await readFile(file, 'utf8'), '20')
  assert.deepEqual(readdirSync(dir), ['data.json'])

  await writeFile(`${file}.lock`, '999999999\n')
  assert.equal(await withFileLock(file, async () => 'dead owner', { timeoutMs: 500 }), 'dead owner')
  await writeFile(`${file}.lock`, `${process.pid}\n`)
  const old = new Date(Date.now() - 60_000)
  await utimes(`${file}.lock`, old, old)
  assert.equal(await withFileLock(file, async () => 'old lock', { timeoutMs: 500 }), 'old lock')
  await writeFile(`${file}.lock`, `${process.pid}\n`)
  await assert.rejects(withFileLock(file, async () => 'never', { timeoutMs: 100 }), /timed out waiting for the lock/)
  assert.equal(await readFile(`${file}.lock`, 'utf8'), `${process.pid}\n`)
})
