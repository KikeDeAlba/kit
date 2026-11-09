import './isolate.ts'
import { strict as assert } from 'node:assert'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { claudeProjectDir } from '../src/harness/claude.ts'
import { getAdapter, harnessBinEnvVar } from '../src/harness/registry.ts'
import type { HarnessId, TranscriptRef } from '../src/harness/types.ts'
import { createFakeBin, readFakeBinCalls } from './fake-bin.ts'

const fixtures = join(import.meta.dirname, 'fixtures', 'harness')
const root = mkdtempSync(join(tmpdir(), 'kit-transcripts-'))
process.env['HOME'] = root
process.env['KIT_NO_EVENTS'] = '1'
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

function ref(harness: HarnessId, overrides: Partial<TranscriptRef> = {}): TranscriptRef {
  return {
    harness,
    sessionId: null,
    transcriptPath: null,
    cwd: '/work/bita-cli',
    startedAt: '2026-10-20T10:00:00.000Z',
    endedAt: '2026-10-20T11:00:00.000Z',
    profile: null,
    ...overrides,
  }
}

test('claude keeps only user and assistant text and drops meta, sidechains, tools and commands', async () => {
  const turns = await getAdapter('claude').extractTranscript(ref('claude', { transcriptPath: join(fixtures, 'claude-session.jsonl') }))
  assert.deepEqual(turns, [
    { role: 'user', text: 'Agrega un comando para exportar entradas a CSV' },
    { role: 'assistant', text: 'Voy a revisar el router.\n\nListo: agregué `bita export --csv`.' },
    { role: 'user', text: 'Gracias, ahora corre las pruebas' },
    { role: 'assistant', text: 'Pruebas en verde.' },
  ])
})

test('claude locates the transcript from the session id under CLAUDE_CONFIG_DIR', async () => {
  const configDir = join(root, 'claude-config')
  process.env['CLAUDE_CONFIG_DIR'] = configDir
  try {
    const cwd = '/Users/me/dev/bita-cli/.claude/worktrees/x'
    const dir = claudeProjectDir(cwd)
    assert.equal(dir, join(configDir, 'projects', '-Users-me-dev-bita-cli--claude-worktrees-x'))
    mkdirSync(dir, { recursive: true })
    copyFileSync(join(fixtures, 'claude-session.jsonl'), join(dir, 'sess-1.jsonl'))
    const turns = await getAdapter('claude').extractTranscript(ref('claude', { cwd, sessionId: 'sess-1' }))
    assert.equal(turns.length, 4)
    assert.deepEqual(await getAdapter('claude').extractTranscript(ref('claude', { cwd, sessionId: 'missing' })), [])
    assert.deepEqual(await getAdapter('claude').extractTranscript(ref('claude', { cwd })), [])
  } finally {
    delete process.env['CLAUDE_CONFIG_DIR']
  }
})

test('codex reads response messages and drops developer and injected context', async () => {
  const turns = await getAdapter('codex').extractTranscript(ref('codex', { transcriptPath: join(fixtures, 'codex-rollout.jsonl') }))
  assert.deepEqual(turns, [
    { role: 'user', text: 'Corrige el cálculo de horas extra' },
    { role: 'assistant', text: 'Corregí el redondeo en overtime.ts.' },
  ])
})

test('codex locates rollouts by session id and by cwd and time window under CODEX_HOME', async () => {
  const codexHome = join(root, 'codex-home')
  const day = join(codexHome, 'sessions', '2026', '10', '20')
  mkdirSync(day, { recursive: true })
  process.env['CODEX_HOME'] = codexHome
  try {
    const sessionId = '019a0000-0000-7000-8000-000000000001'
    const fixture = readFileSync(join(fixtures, 'codex-rollout.jsonl'), 'utf8')
    const target = join(day, `rollout-2026-10-20T10-00-00-${sessionId}.jsonl`)
    writeFileSync(target, fixture)
    const otherCwd = join(day, 'rollout-2026-10-20T10-30-00-019a0000-0000-7000-8000-000000000002.jsonl')
    writeFileSync(otherCwd, fixture.replaceAll('/work/bita-cli', '/work/other'))
    const stale = join(day, 'rollout-2026-10-19T10-00-00-019a0000-0000-7000-8000-000000000003.jsonl')
    writeFileSync(stale, fixture)
    const inWindow = new Date('2026-10-20T10:30:00.000Z')
    utimesSync(target, inWindow, inWindow)
    const later = new Date('2026-10-20T10:45:00.000Z')
    utimesSync(otherCwd, later, later)
    const old = new Date('2026-10-19T10:00:00.000Z')
    utimesSync(stale, old, old)

    const byId = await getAdapter('codex').extractTranscript(ref('codex', { sessionId }))
    assert.equal(byId.length, 2)
    const byWindow = await getAdapter('codex').extractTranscript(ref('codex'))
    assert.equal(byWindow[0]?.text, 'Corrige el cálculo de horas extra')
    utimesSync(target, old, old)
    assert.deepEqual(await getAdapter('codex').extractTranscript(ref('codex')), [])
    assert.deepEqual(await getAdapter('codex').extractTranscript(ref('codex', { sessionId: 'nope' })), [])
  } finally {
    delete process.env['CODEX_HOME']
  }
})

test('gemini applies rewinds and patches and skips thoughts and info records', async () => {
  const turns = await getAdapter('gemini').extractTranscript(ref('gemini', { transcriptPath: join(fixtures, 'gemini-chat.jsonl') }))
  assert.deepEqual(turns, [
    { role: 'user', text: 'Revisa el lector de transcripts' },
    { role: 'assistant', text: 'El lector ya filtra los mensajes meta.' },
  ])
  const legacy = await getAdapter('gemini').extractTranscript(ref('gemini', { transcriptPath: join(fixtures, 'gemini-chat-legacy.json') }))
  assert.deepEqual(legacy, [
    { role: 'user', text: 'Hola desde el formato viejo' },
    { role: 'assistant', text: 'Respuesta en formato viejo' },
  ])
  assert.deepEqual(await getAdapter('gemini').extractTranscript(ref('gemini', { sessionId: 'x' })), [])
})

test('opencode exports the session through the binary and parses both export formats', async () => {
  const dir = mkdtempSync(join(root, 'opencode-'))
  const bin = createFakeBin(dir, 'opencode')
  const log = join(dir, 'calls.log')
  process.env[harnessBinEnvVar('opencode')] = bin
  process.env['FAKE_BIN_LOG'] = log
  process.env['FAKE_BIN_REPLY_FILE'] = join(fixtures, 'opencode-export.json')
  process.env['CLAUDECODE'] = '1'
  try {
    const turns = await getAdapter('opencode').extractTranscript(ref('opencode', { sessionId: 'ses_fixture0001', cwd: dir }))
    assert.deepEqual(turns, [
      { role: 'user', text: 'Documenta el comando session' },
      { role: 'assistant', text: 'Agregué la sección al README.' },
    ])
    const [call] = readFakeBinCalls(log)
    assert.deepEqual(call?.argv, ['session', 'export', '--standalone', 'ses_fixture0001'])
    assert.equal(call?.env['CLAUDECODE'], undefined)
    assert.equal(call?.env['DEN_PROFILE'], undefined)

    process.env['FAKE_BIN_REPLY_FILE'] = join(fixtures, 'opencode-export-legacy.json')
    const legacy = await getAdapter('opencode').extractTranscript(ref('opencode', { sessionId: 'ses_legacy', cwd: dir }))
    assert.deepEqual(legacy, [
      { role: 'user', text: 'Hola legacy' },
      { role: 'assistant', text: 'Respuesta legacy' },
    ])

    assert.deepEqual(await getAdapter('opencode').extractTranscript(ref('opencode', { cwd: dir })), [])
    assert.equal(readFakeBinCalls(log).length, 2)

    process.env['FAKE_BIN_EXIT'] = '1'
    assert.deepEqual(await getAdapter('opencode').extractTranscript(ref('opencode', { sessionId: 'ses_x', cwd: dir })), [])
  } finally {
    for (const key of [harnessBinEnvVar('opencode'), 'FAKE_BIN_LOG', 'FAKE_BIN_REPLY_FILE', 'FAKE_BIN_EXIT', 'CLAUDECODE']) delete process.env[key]
  }
})

test('a missing transcript file yields no turns for every harness', async () => {
  const missing = join(root, 'does-not-exist.jsonl')
  for (const id of ['claude', 'codex', 'gemini'] as const) {
    assert.deepEqual(await getAdapter(id).extractTranscript(ref(id, { transcriptPath: missing })), [])
  }
  const path = process.env['PATH']
  process.env[harnessBinEnvVar('opencode')] = join(root, 'no-bin')
  process.env['PATH'] = ''
  try {
    assert.deepEqual(await getAdapter('opencode').extractTranscript(ref('opencode', { sessionId: 'ses_1' })), [])
  } finally {
    delete process.env[harnessBinEnvVar('opencode')]
    process.env['PATH'] = path
  }
})
