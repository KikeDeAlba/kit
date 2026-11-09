import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { CATALOG, CATALOG_TOOL_NAMES, DEN_APP, catalogDocument, catalogTool, isCatalogToolName } from '../src/catalog.ts'

test('the catalog lists the eight tools in install order', () => {
  assert.deepEqual(CATALOG.map((tool) => tool.name), ['kit', 'nursery', 'bita', 'gaze', 'inkwell', 'recap', 'tally', 'atl'])
  assert.deepEqual([...CATALOG_TOOL_NAMES], CATALOG.map((tool) => tool.name))
  for (const tool of CATALOG) {
    assert.equal(tool.package, `@kikedealba/${tool.name}`)
    assert.match(tool.homepage, /^https:\/\/github\.com\/KikeDeAlba\//)
    assert.ok(tool.description.length > 0)
  }
  assert.equal(catalogTool('kit')?.optional, false)
  assert.ok(CATALOG.filter((tool) => tool.name !== 'kit').every((tool) => tool.optional))
  assert.equal(catalogTool('kit')?.agentsFlag, false)
  assert.deepEqual(catalogTool('nursery')?.setup, ['setup'])
  assert.equal(catalogTool('nope'), null)
  assert.equal(isCatalogToolName('gaze'), true)
  assert.equal(isCatalogToolName('den'), false)
  assert.equal(DEN_APP.releases, 'https://github.com/KikeDeAlba/den/releases/latest')
})

test('schemas/catalog.v1.json is the packaged copy of the catalog', async () => {
  const file = path.join(import.meta.dirname, '..', 'schemas', 'catalog.v1.json')
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), JSON.parse(JSON.stringify(catalogDocument())))
})
