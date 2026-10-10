import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import {
  defineManifest,
  findByCapability,
  findTool,
  invokeTool,
  listTools,
  manifestPath,
  registerTool,
  requireTool,
  ToolMissingError,
  unregisterTool,
  validateManifest,
} from '../src/registry.ts'
import { checkConformance } from '../src/conformance.ts'
import { CONFORMING_TOOL, fakeTool, sandbox, tempDir } from './helpers.ts'

test('registers, lists and finds a tool by capability and version', async (t) => {
  const home = await tempDir(t)
  const ctx = sandbox(home)
  const script = await fakeTool(home, 'demo', CONFORMING_TOOL)
  const manifest = defineManifest({ name: 'demo', version: '1.2.3', bin: [process.execPath, script], capabilities: ['demo.read', 'demo.write'], emits: ['changed'] })

  const file = await registerTool(manifest, ctx)
  assert.equal(file, manifestPath('demo', ctx))
  assert.equal(JSON.parse(await readFile(file, 'utf8')).name, 'demo')

  assert.deepEqual((await listTools(ctx)).map((tool) => tool.name), ['demo'])
  assert.ok(await findTool('demo', { capability: 'demo.read', minVersion: '1.0.0' }, ctx))
  assert.equal(await findTool('demo', { minVersion: '2.0.0' }, ctx), null)
  assert.equal(await findTool('demo', { capability: 'demo.delete' }, ctx), null)
  assert.equal(await findTool('ghost', {}, ctx), null)
  assert.equal((await findByCapability('demo.write', ctx)).length, 1)

  const verified = await findTool('demo', { verify: true, capability: 'demo.write' }, ctx)
  assert.equal(verified?.manifest.version, '1.2.3')

  const result = await invokeTool(verified!, ['capabilities'])
  assert.equal(result.envelope.ok, true)

  assert.equal(await unregisterTool('demo', ctx), true)
  assert.equal(await unregisterTool('demo', ctx), false)
  assert.deepEqual(await listTools(ctx), [])
})

test('a tool whose binary disappeared is not found', async (t) => {
  const home = await tempDir(t)
  const ctx = sandbox(home)
  await registerTool(defineManifest({ name: 'gone', version: '1.0.0', bin: [path.join(home, 'missing.js')], capabilities: [] }), ctx)
  assert.equal(await findTool('gone', {}, ctx), null)
  await assert.rejects(requireTool('gone', 'npm i -g @kikedealba/gone', {}, ctx), (error: unknown) => {
    assert.ok(error instanceof ToolMissingError)
    assert.equal(error.code, 'GONE_MISSING')
    assert.equal(error.hint, 'npm i -g @kikedealba/gone')
    return true
  })
})

test('rejects invalid manifests', async (t) => {
  const home = await tempDir(t)
  assert.ok(validateManifest({}).length > 0)
  assert.ok(validateManifest(defineManifest({ name: 'Bad Name', version: '1', bin: [], capabilities: [] })).length >= 3)
  const bad = { ...defineManifest({ name: 'x', version: '1.0.0', bin: ['x'], capabilities: [] }), subscribes: [{ tool: 'bita', events: [], command: [] }] }
  assert.ok(validateManifest(bad).some((problem) => problem.includes('subscribes[0].events')))
  await assert.rejects(registerTool(bad, sandbox(home)))
})

test('conformance passes for a well-behaved tool and reports a broken one', async (t) => {
  const home = await tempDir(t)
  const good = await fakeTool(home, 'good', CONFORMING_TOOL)
  const manifest = defineManifest({ name: 'demo', version: '1.2.3', bin: [process.execPath, good], capabilities: ['demo.read'] })
  const report = await checkConformance([process.execPath, good], manifest, sandbox(home))
  assert.deepEqual(report.problems, [])

  const bad = await fakeTool(home, 'bad', `console.log('hello'); process.exit(0)`)
  const broken = await checkConformance([process.execPath, bad], undefined, sandbox(home))
  assert.equal(broken.ok, false)
  assert.ok(broken.problems.some((problem) => problem.includes('valid envelope')))

  const mismatch = await checkConformance([process.execPath, good], { ...manifest, version: '9.9.9', capabilities: ['demo.fly'] }, sandbox(home))
  assert.ok(mismatch.problems.some((problem) => problem.includes('version differs')))
  assert.ok(mismatch.problems.some((problem) => problem.includes('demo.fly')))
})
