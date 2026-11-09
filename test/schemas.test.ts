import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { CATALOG, CATALOG_TOOL_NAMES, CATALOG_VERSION, DEN_APP, catalogDocument, catalogTool, isCatalogToolName } from '../src/catalog.ts'
import { PROFILES_SCHEMA_URL, parseProfiles, serializeProfiles } from '../src/profiles.ts'
import { platformContext } from '../src/platform.ts'

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Schema = { [key: string]: Json }

const schemasDir = path.join(import.meta.dirname, '..', 'schemas')

async function load(name: string): Promise<Schema> {
  return JSON.parse(await readFile(path.join(schemasDir, name), 'utf8')) as Schema
}

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

function validate(schema: Schema, value: unknown): string[] {
  const errors: string[] = []
  const known = new Set(['$schema', '$id', 'title', 'description', 'type', 'const', 'enum', 'pattern', 'minLength', 'minProperties', 'required', 'properties', 'additionalProperties', 'propertyNames', 'items', 'oneOf', 'minItems'])
  for (const key of Object.keys(schema)) if (!known.has(key)) throw new Error(`validator does not support "${key}"`)
  if ('type' in schema) {
    const wanted = (Array.isArray(schema['type']) ? schema['type'] : [schema['type']]) as string[]
    const actual = typeOf(value)
    if (!wanted.some((type) => type === actual || (type === 'number' && actual === 'integer'))) return [`expected ${wanted.join('|')}, got ${actual}`]
  }
  if ('const' in schema && JSON.stringify(schema['const']) !== JSON.stringify(value)) errors.push(`expected const ${JSON.stringify(schema['const'])}`)
  if ('enum' in schema && !(schema['enum'] as Json[]).some((item) => JSON.stringify(item) === JSON.stringify(value))) errors.push('not in enum')
  if (typeof value === 'string') {
    if ('pattern' in schema && !new RegExp(schema['pattern'] as string).test(value)) errors.push(`"${value}" does not match ${schema['pattern']}`)
    if ('minLength' in schema && value.length < (schema['minLength'] as number)) errors.push('too short')
  }
  if (Array.isArray(value)) {
    if ('minItems' in schema && value.length < (schema['minItems'] as number)) errors.push('too few items')
    if ('items' in schema) value.forEach((item, index) => errors.push(...validate(schema['items'] as Schema, item).map((error) => `[${index}] ${error}`)))
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    if ('minProperties' in schema && Object.keys(record).length < (schema['minProperties'] as number)) errors.push('too few properties')
    for (const name of (schema['required'] ?? []) as string[]) if (!(name in record)) errors.push(`missing ${name}`)
    const properties = (schema['properties'] ?? {}) as Record<string, Schema>
    for (const [key, item] of Object.entries(record)) {
      if ('propertyNames' in schema) errors.push(...validate(schema['propertyNames'] as Schema, key).map((error) => `name ${key}: ${error}`))
      if (key in properties) errors.push(...validate(properties[key] as Schema, item).map((error) => `${key}: ${error}`))
      else if (schema['additionalProperties'] === false) errors.push(`unexpected ${key}`)
      else if (typeof schema['additionalProperties'] === 'object') errors.push(...validate(schema['additionalProperties'] as Schema, item).map((error) => `${key}: ${error}`))
    }
  }
  if ('oneOf' in schema) {
    const matches = (schema['oneOf'] as Schema[]).filter((option) => validate(option, value).length === 0).length
    if (matches !== 1) errors.push(`matched ${matches} oneOf branches`)
  }
  return errors
}

const ctx = platformContext({ platform: 'linux', home: '/home/me', env: {} })

test('profiles.v1.json is well-formed and agrees with the constants of the code', async () => {
  const schema = await load('profiles.v1.json')
  assert.equal(schema['$schema'], 'https://json-schema.org/draft/2020-12/schema')
  assert.equal(schema['$id'], PROFILES_SCHEMA_URL)
  assert.deepEqual(schema['required'], ['version', 'default', 'profiles'])
  assert.equal(schema['additionalProperties'], false)
  const properties = schema['properties'] as Record<string, Schema>
  assert.deepEqual(Object.keys(properties).sort(), ['$schema', 'default', 'dirs', 'profiles', 'version'])
  assert.equal(properties['version']?.['const'], 1)
  const pattern = properties['default']?.['pattern'] as string
  assert.equal(pattern, '^[a-z][a-z0-9-]{0,31}$')
  assert.equal((properties['profiles']?.['propertyNames'] as Schema)['pattern'], pattern)
  assert.equal(((properties['dirs']?.['items'] as Schema)['properties'] as Record<string, Schema>)['profile']?.['pattern'], pattern)
  assert.doesNotThrow(() => validate(schema, {}))
})

test('files written by serializeProfiles validate against profiles.v1.json', async () => {
  const schema = await load('profiles.v1.json')
  const samples: unknown[] = [
    { version: 1, default: 'default', profiles: { default: { builtin: true } } },
    { version: 1, default: 'personal', profiles: { personal: { builtin: true, createdAt: null }, trabajo: { claude: '~/c', codex: '~/x', createdAt: '2026-11-08T17:00:00.000Z' } }, dirs: [{ path: '~/dev/empresa', profile: 'trabajo' }] },
    { version: 1, default: 'a', profiles: { a: { builtin: true }, ['b'.repeat(32)]: { builtin: false, claude: '/c', codex: '/x' } }, dirs: [] },
  ]
  for (const sample of samples) {
    assert.deepEqual(validate(schema, sample), [], JSON.stringify(sample))
    const out = serializeProfiles(parseProfiles(sample, ctx), ctx)
    assert.deepEqual(validate(schema, JSON.parse(JSON.stringify(out))), [], JSON.stringify(out))
    assert.equal(out['$schema'], PROFILES_SCHEMA_URL)
  }
})

test('profiles.v1.json rejects what parseProfiles rejects at the structural level', async () => {
  const schema = await load('profiles.v1.json')
  const ok = { version: 1, default: 'a', profiles: { a: { builtin: true } } }
  const bad: [string, unknown][] = [
    ['no version', { default: 'a', profiles: { a: { builtin: true } } }],
    ['version 2', { ...ok, version: 2 }],
    ['no default', { version: 1, profiles: ok.profiles }],
    ['no profiles', { version: 1, default: 'a' }],
    ['empty profiles', { ...ok, profiles: {} }],
    ['uppercase name', { ...ok, profiles: { A: { builtin: true } } }],
    ['name too long', { ...ok, profiles: { a: { builtin: true }, ['b'.repeat(33)]: { claude: '/c', codex: '/x' } } }],
    ['missing codex', { ...ok, profiles: { a: { builtin: true }, b: { claude: '/c' } } }],
    ['empty claude', { ...ok, profiles: { a: { builtin: true }, b: { claude: '', codex: '/x' } } }],
    ['builtin with claude', { ...ok, profiles: { a: { builtin: true, claude: '/c' } } }],
    ['dirs without profile', { ...ok, dirs: [{ path: '/x' }] }],
    ['dirs empty path', { ...ok, dirs: [{ path: '', profile: 'a' }] }],
    ['dirs bad profile', { ...ok, dirs: [{ path: '/x', profile: 'A' }] }],
  ]
  for (const [label, value] of bad) {
    assert.notDeepEqual(validate(schema, value), [], label)
    assert.throws(() => parseProfiles(value, ctx), (error: unknown) => error instanceof Error, label)
  }
})

test('profiles.v1.json forbids unknown keys that parseProfiles ignores', async () => {
  const schema = await load('profiles.v1.json')
  const ok = { version: 1, default: 'a', profiles: { a: { builtin: true } } }
  for (const value of [{ ...ok, extra: 1 }, { ...ok, profiles: { a: { builtin: true, extra: 1 } } }, { ...ok, dirs: [{ path: '/x', profile: 'a', extra: 1 }] }]) {
    assert.notDeepEqual(validate(schema, value), [])
    assert.doesNotThrow(() => parseProfiles(value, ctx))
  }
})

test('the catalog schema document is a faithful, secret-free copy of the catalog', async () => {
  const document = await load('catalog.v1.json')
  assert.equal(document['version'], CATALOG_VERSION)
  assert.deepEqual(Object.keys(document).sort(), ['denApp', 'tools', 'version'])
  assert.deepEqual(document['denApp'], DEN_APP)
  const tools = document['tools'] as Record<string, Json>[]
  assert.deepEqual(tools, JSON.parse(JSON.stringify(CATALOG)))
  const raw = await readFile(path.join(schemasDir, 'catalog.v1.json'), 'utf8')
  assert.ok(raw.endsWith('\n'))
  assert.doesNotMatch(raw, /token|secret|password|api[_-]?key/i)
  assert.deepEqual(JSON.parse(JSON.stringify(catalogDocument())), document)
})

test('catalog entries are unique, consistent and ordered for installation', () => {
  assert.equal(CATALOG[0]?.name, 'kit')
  assert.equal(CATALOG[1]?.name, 'nursery')
  for (const field of ['name', 'package', 'bin', 'homepage'] as const) assert.equal(new Set(CATALOG.map((tool) => tool[field])).size, CATALOG.length, field)
  for (const tool of CATALOG) {
    assert.deepEqual(Object.keys(tool).sort(), ['agentsFlag', 'bin', 'description', 'homepage', 'name', 'optional', 'package', 'setup', 'uninstall'], tool.name)
    assert.match(tool.package, /^@kikedealba\/[a-z]+$/, tool.name)
    assert.match(tool.bin, /^[a-z][a-z0-9-]*$/, tool.name)
    assert.ok(tool.setup.every((arg) => typeof arg === 'string' && arg.length > 0), tool.name)
    assert.ok(tool.uninstall.every((arg) => typeof arg === 'string' && arg.length > 0), tool.name)
    assert.equal(tool.agentsFlag, tool.setup.length > 0, `${tool.name}: agentsFlag only makes sense for tools with a setup command`)
    assert.equal(tool.description.trim(), tool.description, tool.name)
    assert.equal(isCatalogToolName(tool.name), true)
    assert.equal(catalogTool(tool.name), tool)
  }
  assert.equal(CATALOG.length, CATALOG_TOOL_NAMES.length)
  for (const value of ['', 'KIT', 'den', 'constructor', 'toString', null, undefined, 3]) assert.equal(isCatalogToolName(value), false, String(value))
  for (const value of ['', 'KIT', 'den', 'constructor', 'toString']) assert.equal(catalogTool(value), null, value)
  assert.match(DEN_APP.releases, /^https:\/\/github\.com\/KikeDeAlba\/den\/releases\/latest$/)
})

test('the catalog document is a copy: mutating it does not change the catalog', () => {
  const first = catalogDocument()
  const snapshot = JSON.stringify(CATALOG)
  const mutable = JSON.parse(JSON.stringify(first)) as { tools: { name: string }[] }
  mutable.tools[0]!.name = 'hacked'
  assert.equal(JSON.stringify(CATALOG), snapshot)
})
