import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { HeadlessError, headlessInvocation, parseHeadlessOutput, pickHeadlessAgent, runHeadless, type HeadlessAgent } from '../src/agents/index.ts'
import { platformContext } from '../src/platform.ts'
import { sandbox, tempDir } from './helpers.ts'

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'headless')

const fixture = (name: string) => readFile(path.join(FIXTURES, name), 'utf8')

function failure(code: HeadlessError['code'], pattern?: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof HeadlessError, String(error))
    assert.equal(error.code, code)
    if (pattern) assert.match(error.message, pattern)
    return true
  }
}

test('parses the JSON output of every harness', async () => {
  assert.deepEqual(parseHeadlessOutput('claude', await fixture('claude.json')), { text: 'Resumen listo.', sessionId: '6f1c2a5e-1111-4a2b-9c3d-000000000001' })
  assert.deepEqual(parseHeadlessOutput('codex', await fixture('codex.jsonl')), { text: 'Final answer.', sessionId: '0199a213-81c0-7800-8aa1-bbab2a035a53' })
  assert.deepEqual(parseHeadlessOutput('gemini', await fixture('gemini.json')), { text: 'Hola {desde} gemini.\n{no es json}', sessionId: 'b3c1d2e4-2222-4f00-8000-000000000003' })
  assert.deepEqual(parseHeadlessOutput('antigravity', await fixture('antigravity.json')), { text: 'Listo desde agy.', sessionId: 'c0ffee00-3333-4000-8000-000000000005' })
  assert.deepEqual(parseHeadlessOutput('opencode', await fixture('opencode.jsonl')), { text: 'OK\n\nSecond message.', sessionId: 'ses_e99277354ffeVY91vRD90IQUTu' })
})

test('harness errors and garbage are reported with a code', async () => {
  assert.throws(() => parseHeadlessOutput('claude', 'not json'), failure('PARSE'))
  assert.throws(() => parseHeadlessOutput('claude', '{"type":"result"}'), failure('PARSE', /"result"/))
  const claudeError = await fixture('claude-error.json')
  assert.throws(() => parseHeadlessOutput('claude', claudeError), failure('FAILED', /Credit balance/))
  assert.throws(() => parseHeadlessOutput('codex', '{"type":"turn.started"}\n'), failure('PARSE'))
  assert.throws(() => parseHeadlessOutput('codex', '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit."}}\n'), failure('FAILED', /usage limit/))
  const gemini = await fixture('gemini-error.json')
  assert.throws(() => parseHeadlessOutput('gemini', gemini), failure('FAILED', /Auth method/))
  const opencodeError = await fixture('opencode-error.jsonl')
  assert.throws(() => parseHeadlessOutput('opencode', opencodeError), failure('FAILED', /No API key/))
  assert.throws(() => parseHeadlessOutput('opencode', ''), failure('PARSE'))
  assert.throws(() => parseHeadlessOutput('antigravity', '{"conversation_id":"x"}'), failure('PARSE'))
  const codexFailed = await fixture('codex-failed.jsonl')
  assert.throws(() => parseHeadlessOutput('codex', codexFailed), failure('FAILED', /usage limit/))
})

test('each harness gets its own flags, sandbox and prompt channel', () => {
  const base = { prompt: 'hello', cwd: '/work' }
  assert.deepEqual(headlessInvocation('claude', { ...base, model: 'sonnet' }), { args: ['-p', '--output-format', 'json', '--model', 'sonnet'], stdin: 'hello', env: {} })
  assert.deepEqual(headlessInvocation('codex', base).args, ['exec', '--json', '-C', '/work', '--skip-git-repo-check', '--sandbox', 'read-only', '-'])
  assert.deepEqual(headlessInvocation('codex', { ...base, access: 'write', model: 'o3' }).args, ['exec', '--json', '-C', '/work', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-m', 'o3', '-'])
  const gemini = headlessInvocation('gemini', base)
  assert.deepEqual(gemini.args, ['-o', 'json', '--approval-mode', 'plan'])
  assert.equal(gemini.stdin, 'hello')
  assert.equal(gemini.env['GEMINI_CLI_TRUST_WORKSPACE'], 'true')
  assert.deepEqual(headlessInvocation('gemini', { ...base, access: 'write' }).args, ['-o', 'json', '--approval-mode', 'yolo'])
  const agy = headlessInvocation('antigravity', base)
  assert.deepEqual(agy.args, ['-p', 'hello', '--output-format', 'json'])
  assert.equal(agy.stdin, undefined)
  assert.deepEqual(headlessInvocation('antigravity', { ...base, access: 'write', model: 'm' }).args, ['-p', 'hello', '--output-format', 'json', '--model', 'm', '--dangerously-skip-permissions'])
  assert.deepEqual(headlessInvocation('opencode', { ...base, model: 'anthropic/claude', extraArgs: ['--agent', 'plan'] }).args, ['run', '--format', 'json', '-m', 'anthropic/claude', '--agent', 'plan', 'hello'])
})

async function fakeHarness(dir: string, name: string, body: string): Promise<string> {
  const file = path.join(dir, name)
  await writeFile(file, `#!/usr/bin/env node\n${body}`)
  await chmod(file, 0o755)
  return file
}

const ECHO = `
let input = ''
process.stdin.setEncoding('utf8').on('data', (chunk) => (input += chunk)).on('end', () => {
  const path = (process.env.PATH || '').split(require('node:path').delimiter)[0]
  console.log(JSON.stringify({ type: 'result', is_error: false, session_id: 's-1', result: JSON.stringify({ input, args: process.argv.slice(2), headless: process.env.KIT_HEADLESS, path, cwd: process.cwd() }) }))
})
`

test('runHeadless spawns the harness with the prompt on stdin and KIT_HEADLESS set', { skip: process.platform === 'win32' }, async (t) => {
  const home = await tempDir(t)
  const bin = path.join(home, 'bin')
  await mkdir(bin)
  const claude = await fakeHarness(bin, 'claude.cjs', ECHO)
  const pids: number[] = []
  const result = await runHeadless({ agent: 'claude', prompt: 'summarize this', cwd: home, bin: claude, model: 'haiku', ctx: sandbox(home), onSpawn: (pid) => pids.push(pid) })
  const seen = JSON.parse(result.text) as { input: string; args: string[]; headless: string; path: string; cwd: string }
  assert.equal(seen.input, 'summarize this')
  assert.deepEqual(seen.args, ['-p', '--output-format', 'json', '--model', 'haiku'])
  assert.equal(seen.headless, '1')
  assert.equal(seen.path, bin)
  assert.equal(await realpath(seen.cwd), await realpath(home))
  assert.equal(result.sessionId, 's-1')
  assert.equal(result.agent, 'claude')
  assert.equal(pids.length, 1)
  assert.ok(result.durationMs >= 0)
  assert.match(result.raw, /"session_id":"s-1"/)
})

test('runHeadless maps exits, timeouts, aborts and missing binaries to error codes', { skip: process.platform === 'win32' }, async (t) => {
  const home = await tempDir(t)
  const ctx = sandbox(home)
  const crash = await fakeHarness(home, 'crash.cjs', `process.stderr.write('boom happened\\n'); process.exit(3)`)
  await assert.rejects(runHeadless({ agent: 'claude', prompt: 'x', cwd: home, bin: crash, ctx }), (error: unknown) => {
    assert.ok(error instanceof HeadlessError)
    assert.equal(error.code, 'FAILED')
    assert.equal(error.exitCode, 3)
    assert.match(error.message, /boom happened/)
    assert.match(error.stderr, /boom/)
    return true
  })
  const garbage = await fakeHarness(home, 'garbage.cjs', `console.log('hello there')`)
  await assert.rejects(runHeadless({ agent: 'gemini', prompt: 'x', cwd: home, bin: garbage, ctx }), failure('PARSE'))
  const slow = await fakeHarness(home, 'slow.cjs', `setTimeout(() => {}, 60000)`)
  await assert.rejects(runHeadless({ agent: 'codex', prompt: 'x', cwd: home, bin: slow, ctx, timeoutMs: 200 }), failure('TIMEOUT'))
  const controller = new AbortController()
  const pending = runHeadless({ agent: 'codex', prompt: 'x', cwd: home, bin: slow, ctx, signal: controller.signal })
  setTimeout(() => controller.abort(), 100)
  await assert.rejects(pending, failure('FAILED', /aborted/))
  await assert.rejects(runHeadless({ agent: 'claude', prompt: 'x', cwd: home, bin: path.join(home, 'missing'), ctx }), failure('UNAVAILABLE'))
})

test('long prompts passed as arguments through cmd.exe are refused on Windows', async () => {
  const ctx = platformContext({ platform: 'win32', home: 'C:\\Users\\a', env: {} })
  const prompt = 'x'.repeat(8001)
  for (const agent of ['antigravity', 'opencode'] as HeadlessAgent[]) {
    await assert.rejects(runHeadless({ agent, prompt, cwd: 'C:\\work', bin: `C:\\Users\\a\\AppData\\Roaming\\npm\\${agent}.cmd`, ctx }), failure('PROMPT_TOO_LONG'))
  }
})

test('pickHeadlessAgent honors the preference and reports a fallback', { skip: process.platform === 'win32' }, async (t) => {
  const home = await tempDir(t)
  const bin = path.join(home, 'bin')
  await mkdir(bin)
  for (const name of ['gemini', 'opencode']) await fakeHarness(bin, name, '')
  const ctx = sandbox(home, { PATH: bin })
  assert.deepEqual(await pickHeadlessAgent('gemini', { ctx }), { agent: 'gemini', bin: path.join(bin, 'gemini'), fallback: false })
  assert.deepEqual(await pickHeadlessAgent('antigravity', { ctx, order: ['antigravity', 'opencode', 'gemini'] }), { agent: 'opencode', bin: path.join(bin, 'opencode'), fallback: true })
  assert.deepEqual(await pickHeadlessAgent(null, { ctx, order: ['gemini'] }), { agent: 'gemini', bin: path.join(bin, 'gemini'), fallback: false })
  assert.equal(await pickHeadlessAgent('antigravity', { ctx, order: ['antigravity'] }), null)
})
