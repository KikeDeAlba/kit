import './isolate.ts'
import { strict as assert } from 'node:assert'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, beforeEach, test } from 'node:test'
import { getAdapter, harnessBinEnvVar } from '../src/harness/registry.ts'
import { SESSION_SUMMARY_SCHEMA } from '../src/harness/summary.ts'
import type { HarnessId, SummaryInput } from '../src/harness/types.ts'
import { createFakeBin, readFakeBinCalls, type FakeBinCall, nodeScriptBin } from './fake-bin.ts'

const root = mkdtempSync(join(tmpdir(), 'kit-summarize-'))
process.env['HOME'] = root
process.env['KIT_NO_EVENTS'] = '1'
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

const summary = {
  title: 'Agregar export CSV',
  kind: 'dev',
  note: { context: 'Hacía falta exportar', done: '- Comando nuevo', decisions: null, findings: 'Nada raro', verification: null, pending: '' },
}
const expected = {
  ok: true,
  summary: { ...summary, note: { ...summary.note, pending: null } },
}
const FAKE_KEYS = ['FAKE_BIN_LOG', 'FAKE_BIN_REPLY', 'FAKE_BIN_REPLIES', 'FAKE_BIN_SLEEP_MS', 'FAKE_BIN_EXIT', 'FAKE_BIN_REPLY_FILE']

let dir = ''
let log = ''

beforeEach(() => {
  dir = mkdtempSync(join(root, 'case-'))
  log = join(dir, 'calls.log')
  process.env['FAKE_BIN_LOG'] = log
  process.env['BITA_WRAPPER_ID'] = 'wrapper-1'
  process.env['BITA_HARNESS'] = 'claude'
  process.env['BITA_SESSION_PROJECT'] = '3'
  process.env['CLAUDECODE'] = '1'
})

afterEach(() => {
  for (const key of [...FAKE_KEYS, 'BITA_WRAPPER_ID', 'BITA_HARNESS', 'BITA_SESSION_PROJECT', 'CLAUDECODE']) delete process.env[key]
  for (const id of ['claude', 'codex', 'gemini', 'opencode'] as const) delete process.env[harnessBinEnvVar(id)]
})

function useFake(id: HarnessId): void {
  process.env[harnessBinEnvVar(id)] = createFakeBin(dir, id)
}

function replies(values: string[]): void {
  const file = join(dir, 'replies.json')
  writeFileSync(file, JSON.stringify(values))
  process.env['FAKE_BIN_REPLIES'] = file
}

function callerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, BITA_CHILD: '1' }
  for (const key of ['BITA_WRAPPER_ID', 'BITA_HARNESS', 'BITA_SESSION_PROJECT']) delete env[key]
  return env
}

function input(overrides: Partial<SummaryInput> = {}): SummaryInput {
  return {
    turns: [{ role: 'user', text: 'Agrega export CSV' }, { role: 'assistant', text: 'Hecho' }],
    meta: { harness: 'claude', projectName: 'Bita', repo: 'KikeDeAlba/bita-cli', branch: 'main', cwd: '/work/bita-cli', durationSeconds: 600, touchedFiles: [] },
    kinds: ['dev'],
    model: null,
    timeoutMs: 20_000,
    profile: null,
    baseEnv: callerEnv(),
    ...overrides,
  }
}

function assertIsolated(call: FakeBinCall | undefined): void {
  assert.ok(call)
  assert.equal(call.env['BITA_CHILD'], '1')
  for (const key of ['BITA_WRAPPER_ID', 'BITA_HARNESS', 'BITA_SESSION_PROJECT', 'CLAUDECODE']) assert.equal(call.env[key], undefined, key)
  assert.ok(call.cwd.startsWith(realpathSync(tmpdir())), call.cwd)
}

const opencodeEvents = (sessionID: string, text: string) =>
  [
    { type: 'step_start', sessionID, part: { type: 'step-start' } },
    { type: 'text', sessionID, part: { type: 'text', text: 'borrador' } },
    { type: 'text', sessionID, part: { type: 'text', text } },
    { type: 'step_finish', sessionID, part: { type: 'step-finish' } },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n')

test('claude summarizes with the verified isolated command and reads structured_output', async () => {
  useFake('claude')
  process.env['FAKE_BIN_REPLY'] = JSON.stringify({ type: 'result', is_error: false, result: '', structured_output: summary })
  const result = await getAdapter('claude').summarize(input())
  assert.deepEqual(result, expected)
  const [call] = readFakeBinCalls(log)
  assertIsolated(call)
  assert.deepEqual(call?.argv, [
    '-p',
    '--model',
    'haiku',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(SESSION_SUMMARY_SCHEMA),
    '--tools',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--max-turns',
    '2',
    '--settings',
    '{"disableAllHooks":true}',
  ])
  assert.match(call?.stdin ?? '', /### Usuario\nAgrega export CSV/)
  assert.ok(!existsSync(call?.cwd ?? ''))
})

test('claude honors the configured model and reports errors and missing output', async () => {
  useFake('claude')
  process.env['FAKE_BIN_REPLY'] = JSON.stringify({ type: 'result', is_error: false, structured_output: summary })
  await getAdapter('claude').summarize(input({ model: 'sonnet' }))
  assert.equal(readFakeBinCalls(log)[0]?.argv[2], 'sonnet')
  process.env['FAKE_BIN_REPLY'] = JSON.stringify({ type: 'result', is_error: true, result: 'quota exceeded' })
  assert.deepEqual(await getAdapter('claude').summarize(input()), { ok: false, error: 'claude failed: quota exceeded' })
  process.env['FAKE_BIN_REPLY'] = JSON.stringify({ type: 'result', is_error: false, result: 'texto' })
  assert.deepEqual(await getAdapter('claude').summarize(input()), { ok: false, error: 'claude returned no structured_output' })
  process.env['FAKE_BIN_REPLY'] = 'not json'
  process.env['FAKE_BIN_EXIT'] = '2'
  const failed = await getAdapter('claude').summarize(input())
  assert.equal(failed.ok, false)
  assert.match(failed.ok ? '' : failed.error, /exited with code 2/)
})

test('codex runs exec with the schema file and reads the -o output', async () => {
  useFake('codex')
  process.env['FAKE_BIN_REPLY'] = JSON.stringify(summary)
  const result = await getAdapter('codex').summarize(input())
  assert.deepEqual(result, expected)
  const [call] = readFakeBinCalls(log)
  assertIsolated(call)
  const argv = call?.argv ?? []
  const schemaPath = argv[argv.indexOf('--output-schema') + 1] ?? ''
  const outputPath = argv[argv.indexOf('-o') + 1] ?? ''
  assert.deepEqual(argv, [
    'exec',
    '--ephemeral',
    '-s',
    'read-only',
    '--skip-git-repo-check',
    '--disable',
    'hooks',
    '-m',
    'gpt-5.6-luna',
    '-c',
    'model_reasoning_effort=low',
    '--output-schema',
    schemaPath,
    '-o',
    outputPath,
    '-',
  ])
  assert.deepEqual(JSON.parse(call?.files['--output-schema'] as string), SESSION_SUMMARY_SCHEMA)
  assert.match(call?.stdin ?? '', /Agrega export CSV/)
  assert.ok(!existsSync(schemaPath))
})

test('codex reports a failing exit and invalid output', async () => {
  useFake('codex')
  process.env['FAKE_BIN_REPLY'] = '{"title":"x"}'
  const invalid = await getAdapter('codex').summarize(input())
  assert.equal(invalid.ok, false)
  process.env['FAKE_BIN_EXIT'] = '1'
  const failed = await getAdapter('codex').summarize(input())
  assert.match(failed.ok ? '' : failed.error, /codex exited with code 1/)
})

test('gemini runs headless in a trusted workspace without hooks or tools and retries once', async () => {
  useFake('gemini')
  replies([
    JSON.stringify({ session_id: 's', response: 'no es json' }),
    JSON.stringify({ session_id: 's', response: `\`\`\`json\n${JSON.stringify(summary)}\n\`\`\`` }),
  ])
  const result = await getAdapter('gemini').summarize(input())
  assert.deepEqual(result, expected)
  const calls = readFakeBinCalls(log)
  assert.equal(calls.length, 2)
  for (const call of calls) {
    assertIsolated(call)
    assert.equal(call.env['GEMINI_CLI_TRUST_WORKSPACE'], 'true')
    assert.deepEqual(JSON.parse(call.files['.gemini/settings.json'] as string), { hooksConfig: { enabled: false }, tools: { core: [] } })
    assert.deepEqual(call.argv.slice(0, -1), ['-m', 'flash-lite', '--approval-mode', 'plan', '-e', 'none', '-o', 'json', '-p'])
    assert.match(call.stdin, /### Usuario\nAgrega export CSV/)
  }
  const instructionsOf = (call: FakeBinCall | undefined): string => (process.platform === 'win32' ? (call?.stdin ?? '') : (call?.argv.at(-1) ?? ''))
  assert.doesNotMatch(instructionsOf(calls[0]), /no pasó la validación/)
  assert.match(instructionsOf(calls[1]), /no pasó la validación \(summary is not a JSON object\)/)
})

test('gemini gives up after the second invalid answer and surfaces API errors', async () => {
  useFake('gemini')
  replies([JSON.stringify({ response: '{"title":"ok?"}' })])
  const result = await getAdapter('gemini').summarize(input())
  assert.equal(result.ok, false)
  assert.equal(readFakeBinCalls(log).length, 2)
  process.env['FAKE_BIN_REPLIES'] = ''
  delete process.env['FAKE_BIN_REPLIES']
  process.env['FAKE_BIN_REPLY'] = JSON.stringify({ error: { type: 'Error', message: 'IneligibleTierError' } })
  process.env['FAKE_BIN_EXIT'] = '55'
  assert.deepEqual(await getAdapter('gemini').summarize(input()), { ok: false, error: 'gemini failed: IneligibleTierError' })
})

const REGISTERING_GEMINI = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
process.stdin.resume()
process.stdin.on('end', () => {
  const home = path.join(process.env.GEMINI_CLI_HOME, '.gemini')
  const cwd = process.cwd()
  const slug = path.basename(cwd).toLowerCase().replace(/[^a-z0-9]/g, '-')
  const registry = path.join(home, 'projects.json')
  const data = JSON.parse(fs.readFileSync(registry, 'utf8'))
  data.projects[cwd] = slug
  fs.writeFileSync(registry, JSON.stringify(data))
  for (const base of ['tmp', 'history']) {
    fs.mkdirSync(path.join(home, base, slug, 'chats'), { recursive: true })
    fs.writeFileSync(path.join(home, base, slug, '.project_root'), cwd)
  }
  fs.appendFileSync(process.env.FAKE_BIN_LOG, cwd + '\\n')
  process.stdout.write(process.env.FAKE_BIN_REPLY)
})
`

test('gemini runs each summary in its own workspace and removes what it registered, keeping the user projects', async () => {
  const geminiHome = mkdtempSync(join(root, 'gemini-home-'))
  const home = join(geminiHome, '.gemini')
  mkdirSync(join(home, 'tmp', 'mine'), { recursive: true })
  writeFileSync(join(home, 'tmp', 'mine', '.project_root'), '/work/mine')
  writeFileSync(join(home, 'projects.json'), JSON.stringify({ projects: { '/work/mine': 'mine' } }))
  const fake = nodeScriptBin(dir, 'gemini', REGISTERING_GEMINI)
  process.env[harnessBinEnvVar('gemini')] = fake
  process.env['GEMINI_CLI_HOME'] = geminiHome
  process.env['FAKE_BIN_REPLY'] = JSON.stringify({ response: JSON.stringify(summary) })
  try {
    assert.deepEqual(await getAdapter('gemini').summarize(input()), expected)
    assert.deepEqual(await getAdapter('gemini').summarize(input()), expected)
    const workspaces = readFileSync(log, 'utf8').split('\n').filter(Boolean)
    assert.equal(workspaces.length, 2)
    assert.notEqual(workspaces[0], workspaces[1])
    for (const workspace of workspaces) assert.equal(existsSync(workspace), false, workspace)
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8')), { projects: { '/work/mine': 'mine' } })
    assert.equal(existsSync(join(home, 'tmp', 'mine', '.project_root')), true)
    for (const base of ['tmp', 'history']) {
      const left = existsSync(join(home, base)) ? readdirSync(join(home, base)) : []
      assert.deepEqual(left.filter((name) => name.startsWith('bita-gemini-summary')), [], base)
    }
    assert.equal(existsSync(join(home, 'projects.json.lock')), false)
  } finally {
    delete process.env['GEMINI_CLI_HOME']
  }
})

test('opencode runs standalone with an empty config dir, retries once and deletes its sessions', async () => {
  useFake('opencode')
  replies([opencodeEvents('ses_a', 'sin json'), opencodeEvents('ses_b', JSON.stringify(summary)), ''])
  const result = await getAdapter('opencode').summarize(input())
  assert.deepEqual(result, expected)
  const calls = readFakeBinCalls(log)
  assert.equal(calls.length, 4)
  const [first, second, ...deletes] = calls
  for (const call of [first, second]) {
    assertIsolated(call)
    const argv = call?.argv ?? []
    const transcript = argv[argv.indexOf('-f') + 1] ?? ''
    assert.deepEqual(argv, ['run', '--standalone', '--format', 'json', '-m', 'openai/gpt-5.6-luna', '-f', transcript])
    assert.match(call?.files['-f'] as string, /### Usuario\nAgrega export CSV/)
    assert.deepEqual(call?.files['OPENCODE_CONFIG_DIR'], [])
    assert.match(call?.stdin ?? '', /Devuelve SOLO un objeto JSON|devuelve SOLO un objeto JSON/)
  }
  assert.match(second?.stdin ?? '', /no pasó la validación/)
  assert.deepEqual(deletes.map((call) => call.argv), [
    ['session', 'delete', '--standalone', 'ses_a'],
    ['session', 'delete', '--standalone', 'ses_b'],
  ])
  for (const call of deletes) assertIsolated(call)
})

test('opencode deletes the session even when the run fails', async () => {
  useFake('opencode')
  replies([opencodeEvents('ses_z', 'x'), ''])
  process.env['FAKE_BIN_EXIT'] = '1'
  const result = await getAdapter('opencode').summarize(input())
  assert.equal(result.ok, false)
  assert.deepEqual(readFakeBinCalls(log).at(-1)?.argv, ['session', 'delete', '--standalone', 'ses_z'])
})

test('a timeout yields ok:false for every harness', async () => {
  process.env['FAKE_BIN_SLEEP_MS'] = '5000'
  process.env['FAKE_BIN_REPLY'] = '{}'
  for (const id of ['claude', 'codex', 'gemini', 'opencode'] as const) {
    useFake(id)
    const started = Date.now()
    const result = await getAdapter(id).summarize(input({ timeoutMs: 300 }))
    assert.deepEqual(result, { ok: false, error: `${id} timed out` })
    assert.ok(Date.now() - started < 4_000, id)
  }
})

test('a missing binary yields ok:false without spawning', async () => {
  const path = process.env['PATH']
  process.env['PATH'] = ''
  try {
    for (const id of ['claude', 'codex', 'gemini', 'opencode'] as const) {
      process.env[harnessBinEnvVar(id)] = join(dir, 'missing')
      assert.deepEqual(await getAdapter(id).summarize(input()), { ok: false, error: `${id} not found` })
    }
  } finally {
    process.env['PATH'] = path
  }
})
