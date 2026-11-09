import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import * as kit from '../src/index.ts'

test('package.json ships the schemas and exports the new modules', async () => {
  const pkg = JSON.parse(await readFile(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { files: string[]; exports: Record<string, unknown> }
  assert.ok(pkg.files.includes('schemas'))
  for (const entry of ['./profiles', './settings', './harness', './catalog', './schemas/catalog.v1.json', './schemas/profiles.v1.json']) assert.ok(entry in pkg.exports, entry)
})

test('the root entry exposes the new modules as namespaces', () => {
  assert.equal(typeof kit.profiles.envFor, 'function')
  assert.equal(typeof kit.settings.getSetting, 'function')
  assert.equal(typeof kit.harness.getAdapter, 'function')
  assert.equal(kit.catalog.CATALOG.length, 8)
  assert.equal(typeof kit.kitConfigRoot, 'function')
})
