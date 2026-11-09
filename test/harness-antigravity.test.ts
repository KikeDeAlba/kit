import './isolate.ts'
import { strict as assert } from 'node:assert'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, test } from 'node:test'

const root = mkdtempSync(join(tmpdir(), 'kit-antigravity-'))
process.env['HOME'] = root
process.env['USERPROFILE'] = root
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

const { antigravityAdapter, antigravityConversationPath, findExitConversation, readAntigravityConversation, readHistoryTail } = await import('../src/harness/antigravity.ts')
const { isConversationId } = await import('../src/harness/antigravity-ids.ts')
const { executableNames, findOnPath, resolveHarnessBin, taskkillPath, withBinOnPath } = await import('../src/harness/process.ts')
const { nodeScriptBin, IS_WINDOWS } = await import('./fake-bin.ts')
const { harnessBinEnvVar } = await import('../src/harness/registry.ts')
const { withoutHarnessSession } = await import('../src/harness/env.ts')

function varint(value: number): number[] {
  const out: number[] = []
  let rest = value
  while (rest > 0x7f) {
    out.push((rest & 0x7f) | 0x80)
    rest = Math.floor(rest / 128)
  }
  out.push(rest)
  return out
}

function field(number: number, payload: Uint8Array | string | number): Uint8Array {
  if (typeof payload === 'number') return Uint8Array.from([...varint(number << 3), ...varint(payload)])
  const bytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload
  return Uint8Array.from([...varint((number << 3) | 2), ...varint(bytes.length), ...bytes])
}

function concat(...parts: Uint8Array[]): Uint8Array {
  return Uint8Array.from(parts.flatMap((part) => [...part]))
}

function conversationDb(file: string, steps: { type: number; payload: Uint8Array }[]): void {
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, step_payload blob, PRIMARY KEY (idx))')
  const insert = db.prepare('INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, 3, ?)')
  steps.forEach((step, index) => insert.run(index, step.type, step.payload))
  db.close()
}

test('reads user and assistant turns from an antigravity conversation database', async () => {
  const file = join(root, 'conv.db')
  conversationDb(file, [
    { type: 14, payload: concat(field(1, 14), field(19, concat(field(2, 'arregla el bug'), field(3, field(1, 'arregla el bug'))))) },
    { type: 15, payload: concat(field(1, 15), field(20, concat(field(3, 'pensando...'), field(7, field(2, 'run_command'))))) },
    { type: 132, payload: field(5, field(4, field(2, 'run_command'))) },
    { type: 15, payload: field(20, concat(field(1, 'Listo, quedó arreglado.'), field(8, 'Listo, quedó arreglado.'))) },
    { type: 15, payload: Uint8Array.from([0xff, 0xff]) },
  ])
  assert.deepEqual(await readAntigravityConversation(file), [
    { role: 'user', text: 'arregla el bug' },
    { role: 'assistant', text: 'Listo, quedó arreglado.' },
  ])
  await assert.rejects(readAntigravityConversation(join(root, 'missing.db')), /cannot open/)
  const empty = join(root, 'empty.db')
  conversationDb(empty, [])
  assert.deepEqual(await readAntigravityConversation(empty), [])
  const broken = join(root, 'broken.db')
  writeFileSync(broken, 'not a database')
  await assert.rejects(readAntigravityConversation(broken), /antigravity conversation|steps/)
  const conversations = join(root, '.gemini', 'antigravity-cli', 'conversations')
  mkdirSync(conversations, { recursive: true })
  copyFileSync(file, join(conversations, 'conv-ok.db'))
  const ref = { harness: 'antigravity' as const, sessionId: null, transcriptPath: join(conversations, 'conv-ok.db'), cwd: root, startedAt: '', endedAt: '', profile: null }
  assert.equal((await antigravityAdapter.extractTranscript(ref)).length, 2)
  assert.equal((await antigravityAdapter.extractTranscript({ ...ref, sessionId: '../bad' })).length, 2)
  assert.equal((await antigravityAdapter.extractTranscript({ ...ref, sessionId: 'conv-ok', transcriptPath: null })).length, 2)
  assert.deepEqual(await antigravityAdapter.extractTranscript({ ...ref, transcriptPath: file }), [])
  assert.deepEqual(await antigravityAdapter.extractTranscript({ ...ref, transcriptPath: join(conversations, '..', 'conv-ok.db') }), [])
  assert.deepEqual(await antigravityAdapter.extractTranscript({ ...ref, transcriptPath: null }), [])
})

test('afterExit picks the last conversation of the workspace since the session started', async () => {
  const home = mkdtempSync(join(root, 'home-'))
  const real = realpathSync.native(mkdtempSync(join(root, 'repo-')))
  const link = join(home, 'repo-link')
  symlinkSync(real, link, 'junction')
  const history = join(home, '.gemini', 'antigravity-cli')
  mkdirSync(history, { recursive: true })
  const started = Date.parse('2026-10-22T10:00:00.000Z')
  const line = (conversationId: string, workspace: string, at: number) => JSON.stringify({ display: 'x', timestamp: at, workspace, conversationId })
  writeFileSync(
    join(history, 'history.jsonl'),
    [
      line('old', real, started - 60_000),
      line('first', real, started - 500),
      line('other-repo', '/somewhere/else', started + 5_000),
      'not json',
      line('second', real, started + 10_000),
      line('later-elsewhere', '/x', started + 20_000),
    ].join('\n'),
  )
  const env = { HOME: home, USERPROFILE: home }
  const ref = { cwd: link, startedAt: new Date(started).toISOString(), endedAt: new Date(started + 60_000).toISOString() }
  assert.deepEqual(await antigravityAdapter.afterExit?.(ref, env), {
    sessionId: 'second',
    transcriptPath: join(history, 'conversations', 'second.db'),
  })
  assert.equal(await findExitConversation({ ...ref, startedAt: new Date(started + 30_000).toISOString() }, env), null)
  assert.equal(await findExitConversation(ref, { HOME: join(root, 'nobody'), USERPROFILE: join(root, 'nobody') }), null)
})

test('summarize asks agy headless in read mode and validates the answer', { skip: IS_WINDOWS && 'a fake agy.cmd cannot take a multi-line argument; the real agy is an .exe' }, async () => {
  const dir = mkdtempSync(join(root, 'agy-'))
  const log = join(dir, 'argv.json')
  const answer = JSON.stringify({ title: 'Arreglar el bug', kind: 'dev', note: { context: 'c', done: 'd', decisions: null, findings: null, verification: null, pending: null } })
  const events = [
    { event: 'init', conversation_id: 'c1', init: { cwd: root, tools: [], permission_mode: 'request-review' } },
    { event: 'step_update', step_update: { conversation_id: 'c1', step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: answer } },
    { event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: answer, num_turns: 1 } },
  ].map((event) => JSON.stringify(event)).join('\n') + '\n'
  const fake = nodeScriptBin(dir, 'agy', `const input = require('node:fs').readFileSync(0, 'utf8')\nrequire('node:fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), input, headless: process.env.KIT_HEADLESS ?? null, wrapper: process.env.BITA_WRAPPER_ID ?? null }))\nprocess.stdout.write(${JSON.stringify(events)})\n`)
  process.env[harnessBinEnvVar('antigravity')] = fake
  process.env['BITA_WRAPPER_ID'] = 'w-1'
  try {
    const result = await antigravityAdapter.summarize({
      turns: [{ role: 'user', text: 'arregla el bug' }],
      meta: { harness: 'antigravity', projectName: 'P', repo: null, branch: null, cwd: root, durationSeconds: 60, touchedFiles: [] },
      kinds: ['dev'],
      model: null,
      timeoutMs: 20_000,
      profile: null,
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    const call = JSON.parse(readFileSync(log, 'utf8')) as { argv: string[]; headless: string | null; wrapper: string | null }
    assert.ok(call.argv.includes('--mode'), call.argv.join(' '))
    assert.ok(!call.argv.includes('--dangerously-skip-permissions'))
    assert.ok(call.argv.includes('gemini-3.8-flash-low'))
    assert.equal(call.headless, '1')
    assert.equal(call.wrapper, null)
  } finally {
    delete process.env[harnessBinEnvVar('antigravity')]
    delete process.env['BITA_WRAPPER_ID']
  }
})

test('children lose the ANTIGRAVITY_ session variables and get the binary dir first on PATH', () => {
  const env = withoutHarnessSession({ PATH: '/usr/bin', ANTIGRAVITY_CONVERSATION_ID: 'c', ANTIGRAVITY_AGENT: '1', ANTIGRAVITY_USER_SETTING: 'x', CLAUDE_CODE_SSE_PORT: '1', HOME: '/h' })
  assert.equal(env['ANTIGRAVITY_CONVERSATION_ID'], undefined)
  assert.equal(env['ANTIGRAVITY_AGENT'], undefined)
  assert.equal(env['ANTIGRAVITY_USER_SETTING'], 'x')
  assert.equal(env['CLAUDE_CODE_SSE_PORT'], '1')
  assert.equal(env['HOME'], '/h')
  assert.equal(withBinOnPath({ PATH: '/usr/bin' }, '/opt/nvm/bin/gemini')['PATH'], `/opt/nvm/bin${delimiter}/usr/bin`)
  assert.equal(withBinOnPath({ PATH: `/usr/bin${delimiter}/opt/nvm/bin${delimiter}/bin` }, '/opt/nvm/bin/gemini')['PATH'], `/usr/bin${delimiter}/opt/nvm/bin${delimiter}/bin`)
  assert.equal(withBinOnPath({}, '/opt/nvm/bin/gemini')['PATH'], '/opt/nvm/bin')
  assert.deepEqual(withBinOnPath({ PATH: '/usr/bin' }, 'gemini'), { PATH: '/usr/bin' })
  assert.equal(taskkillPath({ SystemRoot: 'D:\\Win' }), 'D:\\Win\\System32\\taskkill.exe')
  assert.equal(taskkillPath({}), 'C:\\Windows\\System32\\taskkill.exe')
})

test('conversation ids are validated and stay inside conversations/', async () => {
  for (const id of ['../etc/passwd', '-x', '', 'a/b', 'a\\b', '.hidden', 'x'.repeat(129), 'a b']) {
    assert.equal(isConversationId(id), false, id)
    assert.equal(antigravityConversationPath(id, { HOME: '/h', USERPROFILE: '/h' }), null, id)
  }
  assert.equal(isConversationId('09b9fe5f-b94d-4c30-875e-b51afd912917'), true)
  assert.equal(antigravityConversationPath('abc_1', { HOME: '/h', USERPROFILE: '/h' }), resolve('/h', '.gemini', 'antigravity-cli', 'conversations', 'abc_1.db'))
  const home = mkdtempSync(join(root, 'ids-'))
  mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true })
  const at = Date.parse('2026-10-22T10:00:00.000Z')
  writeFileSync(
    join(home, '.gemini', 'antigravity-cli', 'history.jsonl'),
    [JSON.stringify({ timestamp: at, workspace: home, conversationId: 'good' }), JSON.stringify({ timestamp: at + 1, workspace: home, conversationId: '../../evil' }), JSON.stringify({ timestamp: at + 2, workspace: home, conversationId: '-x' })].join('\n'),
  )
  const found = await findExitConversation({ cwd: home, startedAt: new Date(at).toISOString(), endedAt: new Date(at + 5).toISOString() }, { HOME: home, USERPROFILE: home })
  assert.equal(found?.sessionId, 'good')
})

test('only the tail of a large history is read', async () => {
  const file = join(root, 'big-history.jsonl')
  const lines = Array.from({ length: 200 }, (_, i) => JSON.stringify({ n: i, pad: 'x'.repeat(50) }))
  writeFileSync(file, lines.join('\n'))
  const tail = await readHistoryTail(file, 1_000)
  assert.ok(tail !== null && tail.length <= 1_000)
  const parsed = (tail ?? '').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { n: number })
  assert.equal(parsed.at(-1)?.n, 199)
  assert.equal(await readHistoryTail(join(root, 'none.jsonl')), null)
})

test('overrides must be absolute and PATHEXT names are tried on Windows', () => {
  const dir = mkdtempSync(join(root, 'bins-'))
  const fake = join(dir, 'gemini')
  writeFileSync(fake, '#!/bin/sh\n')
  chmodSync(fake, 0o755)
  assert.equal(resolveHarnessBin('BITA_X', 'gemini', { BITA_X: fake }), fake)
  const original = process.stderr.write.bind(process.stderr)
  let warned = ''
  process.stderr.write = ((chunk: string | Uint8Array) => {
    warned += String(chunk)
    return true
  }) as typeof process.stderr.write
  try {
    assert.equal(resolveHarnessBin('BITA_X', 'gemini', { BITA_X: 'gemini' }), null)
  } finally {
    process.stderr.write = original
  }
  assert.match(warned, /BITA_X must be an absolute path/)
  assert.deepEqual(executableNames('agy', { PATHEXT: '.EXE;.CMD' }, 'win32'), ['agy.exe', 'agy.cmd', 'agy'])
  assert.deepEqual(executableNames('agy.cmd', { PATHEXT: '.EXE;.CMD' }, 'win32'), ['agy.cmd'])
  assert.deepEqual(executableNames('agy', {}, 'linux'), ['agy'])
  assert.equal(findOnPath('gemini', { Path: dir }), fake)
  assert.ok(IS_WINDOWS || executableNames('gemini', {}).length === 1)
})
