import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { eventsSuppressed, filterMatches, fireEvents, registryListeners } from '../src/events.ts'
import { defineManifest, registerTool } from '../src/registry.ts'
import { fakeTool, sandbox, tempDir } from './helpers.ts'

async function waitFor(file: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(file)) {
      const text = await readFile(file, 'utf8')
      if (text.length > 0) return text
    }
    await sleep(50)
  }
  throw new Error(`${file} never appeared`)
}

test('filters match any attribute value', () => {
  assert.equal(filterMatches(undefined, {}), true)
  assert.equal(filterMatches({ kind: ['remote-meeting'] }, { kind: ['work', 'remote-meeting'] }), true)
  assert.equal(filterMatches({ kind: ['remote-meeting'] }, { kind: ['work', null] }), false)
  assert.equal(filterMatches({ kind: ['a'], project: ['x'] }, { kind: ['a'], project: ['y'] }), false)
})

test('suppression honours KIT_NO_EVENTS and legacy variables', () => {
  assert.equal(eventsSuppressed({}), false)
  assert.equal(eventsSuppressed({ KIT_NO_EVENTS: '1' }), true)
  assert.equal(eventsSuppressed({ KIT_NO_EVENTS: '0' }), false)
  assert.equal(eventsSuppressed({ BITA_NO_HOOKS: '1' }, ['BITA_NO_HOOKS']), true)
})

test('delivers events to registry subscribers with the document on stdin', async (t) => {
  const home = await tempDir(t)
  const ctx = sandbox(home)
  const out = path.join(home, 'received.json')
  const listener = await fakeTool(
    home,
    'listener',
    `import { writeFileSync } from 'node:fs'
let body = ''
process.stdin.on('data', (chunk) => (body += chunk))
process.stdin.on('end', () => writeFileSync(${JSON.stringify(out)}, JSON.stringify({ body: JSON.parse(body), env: process.env.KIT_EVENT })))`,
  )
  await registerTool(
    defineManifest({
      name: 'recap',
      version: '1.0.0',
      bin: [process.execPath, listener],
      capabilities: [],
      subscribes: [{ tool: 'bita', events: ['start'], filter: { kind: ['remote-meeting'] }, command: [process.execPath, listener] }],
    }),
    ctx,
  )
  assert.equal((await registryListeners('bita', ctx)).length, 1)

  const skipped = await fireEvents(
    [{ tool: 'bita', event: 'start', attributes: { kind: ['work'] }, document: { entry: { id: 1 } } }],
    { logPath: path.join(home, 'events.log'), ctx },
  )
  assert.equal(skipped.launched, 0)

  const fired = await fireEvents(
    [{ tool: 'bita', event: 'start', attributes: { kind: ['remote-meeting'] }, document: { entry: { id: 7 }, databasePath: '/db' } }],
    { logPath: path.join(home, 'events.log'), ctx },
  )
  assert.equal(fired.launched, 1)
  const received = JSON.parse(await waitFor(out)) as { body: Record<string, unknown>; env: string }
  assert.equal(received.env, 'start')
  assert.equal(received.body['event'], 'start')
  assert.equal(received.body['source'], 'bita')
  assert.deepEqual(received.body['entry'], { id: 7 })
  assert.equal(received.body['databasePath'], '/db')
  assert.match(await readFile(path.join(home, 'events.log'), 'utf8'), /bita:start ->/)
})

test('extra listeners and registry listeners are deduplicated', async (t) => {
  const home = await tempDir(t)
  const ctx = sandbox(home, { KIT_NO_EVENTS: '1' })
  const result = await fireEvents(
    [{ tool: 'bita', event: 'start', attributes: {}, document: {} }],
    { logPath: path.join(home, 'events.log'), ctx, extraListeners: [{ source: 'config', owner: 'user', events: ['start'], command: ['true'] }] },
  )
  assert.equal(result.launched, 0)
})
