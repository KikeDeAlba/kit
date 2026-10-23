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

const ARGS_ECHO = `
let input = ''
process.stdin.setEncoding('utf8').on('data', (chunk) => (input += chunk)).on('end', () => {
  console.log(JSON.stringify({ type: 'result', is_error: false, session_id: 's', result: JSON.stringify({ input, args: process.argv.slice(2), headless: process.env.KIT_HEADLESS, trust: process.env.GEMINI_CLI_TRUST_WORKSPACE, marker: process.env.KIT_MARKER }) }))
})
`

const AWKWARD_PROMPTS = ['-p', '--help', '- leading dash', 'say "hi" and \'bye\'', '100% ^ & | < > ( ) ; $HOME `id` $(id)', 'line one\nline two\r\nline three', '', 'ünïcödé 🚀']

const CHANNEL_ECHO = `
let input = ''
process.stdin.setEncoding('utf8').on('data', (chunk) => (input += chunk)).on('end', () => {
  const seen = JSON.stringify({ input, args: process.argv.slice(2) })
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 't' }))
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: seen } }))
  console.log(JSON.stringify({ type: 'text', sessionID: 'o', part: { id: 'p', messageID: 'm', text: seen } }))
  console.log(JSON.stringify({ type: 'result', is_error: false, session_id: 's', result: seen, response: seen, conversation_id: 'c' }))
})
`

test('prompts with dashes, quotes, shell characters and line breaks arrive untouched on every channel', { skip: process.platform === 'win32' }, async (t) => {
  const home = await tempDir(t)
  const ctx = sandbox(home)
  const echo = await fakeHarness(home, 'echo.cjs', CHANNEL_ECHO)
  for (const prompt of AWKWARD_PROMPTS) {
    for (const agent of ['claude', 'codex', 'gemini'] as HeadlessAgent[]) {
      const seen = JSON.parse((await runHeadless({ agent, prompt, cwd: home, bin: echo, ctx })).text) as { input: string; args: string[] }
      assert.equal(seen.input, prompt)
      assert.ok(!seen.args.includes(prompt) || prompt === '-p' || prompt === '--help' || prompt === '')
    }
    for (const agent of ['antigravity', 'opencode'] as HeadlessAgent[]) {
      const seen = JSON.parse((await runHeadless({ agent, prompt, cwd: home, bin: echo, ctx })).text) as { input: string; args: string[] }
      assert.equal(seen.input, '')
      assert.equal(agent === 'antigravity' ? seen.args[1] : seen.args.at(-1), prompt)
    }
  }
})

test('KIT_HEADLESS reaches the child even when the caller env says otherwise', { skip: process.platform === 'win32' }, async (t) => {
  const home = await tempDir(t)
  const echo = await fakeHarness(home, 'echo.cjs', ARGS_ECHO)
  const read = async (env: NodeJS.ProcessEnv | undefined, ctxEnv: NodeJS.ProcessEnv = {}) => {
    const result = await runHeadless({ agent: 'claude', prompt: 'p', cwd: home, bin: echo, ctx: sandbox(home, ctxEnv), ...(env ? { env } : {}) })
    return JSON.parse(result.text) as { headless: string; marker?: string }
  }
  assert.equal((await read(undefined)).headless, '1')
  assert.equal((await read(undefined, { KIT_HEADLESS: '0' })).headless, '1')
  const custom = await read({ PATH: process.env['PATH'] ?? '', KIT_HEADLESS: '0', KIT_MARKER: 'm' })
  assert.equal(custom.headless, '1')
  assert.equal(custom.marker, 'm')
})

test('gemini gets its trust variable and the child never sees the harness-specific env of other agents', { skip: process.platform === 'win32' }, async (t) => {
  const home = await tempDir(t)
  const echo = await fakeHarness(home, 'echo.cjs', `console.log(JSON.stringify({ response: JSON.stringify({ trust: process.env.GEMINI_CLI_TRUST_WORKSPACE, headless: process.env.KIT_HEADLESS }) }))`)
  const gemini = JSON.parse((await runHeadless({ agent: 'gemini', prompt: 'p', cwd: home, bin: echo, ctx: sandbox(home) })).text) as { trust?: string; headless: string }
  assert.deepEqual(gemini, { trust: 'true', headless: '1' })
})

test('a timeout kills the whole child and reports partial output', { skip: process.platform === 'win32' }, async (t) => {
  const home = await tempDir(t)
  const ctx = sandbox(home)
  const stubborn = await fakeHarness(home, 'stubborn.cjs', `process.stdout.write('partial'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`)
  const pids: number[] = []
  const started = Date.now()
  await assert.rejects(runHeadless({ agent: 'claude', prompt: 'x', cwd: home, bin: stubborn, ctx, timeoutMs: 1500, onSpawn: (pid) => pids.push(pid) }), (error: unknown) => {
    assert.ok(error instanceof HeadlessError)
    assert.equal(error.code, 'TIMEOUT')
    assert.equal(error.stdout, 'partial')
    assert.match(error.message, /1500 ms/)
    return true
  })
  assert.ok(Date.now() - started < 10_000)
  assert.throws(() => process.kill(pids[0] ?? 0, 0))
})

test('an already aborted signal never spawns, and a late abort does nothing after success', { skip: process.platform === 'win32' }, async (t) => {
  const home = await tempDir(t)
  const ctx = sandbox(home)
  const echo = await fakeHarness(home, 'echo.cjs', ARGS_ECHO)
  const spawned: number[] = []
  const aborted = AbortSignal.abort()
  await assert.rejects(runHeadless({ agent: 'claude', prompt: 'x', cwd: home, bin: echo, ctx, signal: aborted, onSpawn: (pid) => spawned.push(pid) }), failure('FAILED', /aborted/))
  assert.equal(spawned.length, 0)
  const controller = new AbortController()
  const result = await runHeadless({ agent: 'claude', prompt: 'x', cwd: home, bin: echo, ctx, signal: controller.signal })
  controller.abort()
  assert.equal(result.sessionId, 's')
})

test('pickHeadlessAgent follows the default order, skips the preferred one once and finds nothing without binaries', { skip: process.platform === 'win32' }, async (t) => {
  const home = await tempDir(t)
  const bin = path.join(home, 'bin')
  await mkdir(bin)
  for (const name of ['codex', 'agy']) await fakeHarness(bin, name, '')
  const ctx = sandbox(home, { PATH: bin })
  assert.deepEqual(await pickHeadlessAgent(undefined, { ctx }), { agent: 'codex', bin: path.join(bin, 'codex'), fallback: false })
  assert.deepEqual(await pickHeadlessAgent('claude', { ctx }), { agent: 'codex', bin: path.join(bin, 'codex'), fallback: true })
  assert.deepEqual(await pickHeadlessAgent('codex', { ctx }), { agent: 'codex', bin: path.join(bin, 'codex'), fallback: false })
  assert.deepEqual(await pickHeadlessAgent('antigravity', { ctx }), { agent: 'antigravity', bin: path.join(bin, 'agy'), fallback: false })
  assert.equal(await pickHeadlessAgent(null, { ctx, order: [] }), null)
  assert.equal(await pickHeadlessAgent('claude', { ctx, order: ['claude'] }), null)
})
