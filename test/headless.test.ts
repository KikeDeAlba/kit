import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { HEADLESS_AGENTS, HeadlessError, WINDOWS_COMMAND_LINE_LIMIT, liveHeadlessGroups, headlessEnv, headlessEnvironment, headlessInvocation, isHeadlessAgent, parseHeadlessOutput, pickHeadlessAgent, runHeadless, type HeadlessAgent } from '../src/agents/index.ts'
import { platformContext, spawnSpec } from '../src/platform.ts'
import { sandbox, tempDir } from './helpers.ts'

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'headless')

const fixture = (name: string) => readFile(path.join(FIXTURES, name), 'utf8')

const agyResult = (result: Record<string, unknown>) => `${JSON.stringify({ event: 'result', result })}\n`

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
  assert.deepEqual(parseHeadlessOutput('antigravity', await fixture('antigravity.jsonl')), { text: 'OK\n', sessionId: 'f8a5cf1c-3acb-4c72-8e12-0f761124f385' })
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
  assert.throws(() => parseHeadlessOutput('antigravity', '{"event":"init","conversation_id":"x"}'), failure('PARSE', /no result event/))
  assert.throws(() => parseHeadlessOutput('antigravity', '{"conversation_id":"x","response":"legacy"}'), failure('PARSE'))
  assert.throws(() => parseHeadlessOutput('antigravity', '{"event":"result","result":{"conversation_id":"x","status":"SUCCESS"}}'), failure('PARSE', /no "response"/))
  const denied = await fixture('antigravity-denied.jsonl')
  assert.throws(() => parseHeadlessOutput('antigravity', denied), failure('FAILED', /permission denied for command/))
  const agyError = await fixture('antigravity-error.jsonl')
  assert.throws(() => parseHeadlessOutput('antigravity', agyError), failure('FAILED', /empty prompt/))
  assert.deepEqual(parseHeadlessOutput('antigravity', agyResult({ response: 'done', conversation_id: 'c', denied_actions: [{ action: 'run_command' }] })), { text: 'done', sessionId: 'c' })
  assert.deepEqual(parseHeadlessOutput('antigravity', `{"event":"init","conversation_id":"i"}\n${agyResult({ response: 'r', conversation_id: '' })}`), { text: 'r', sessionId: 'i' })
  assert.throws(() => parseHeadlessOutput('nope' as HeadlessAgent, '{}'), failure('UNAVAILABLE'))
  const codexFailed = await fixture('codex-failed.jsonl')
  assert.throws(() => parseHeadlessOutput('codex', codexFailed), failure('FAILED', /usage limit/))
})

test('each harness gets its own flags, sandbox and prompt channel', () => {
  const base = { prompt: '- hello', cwd: '/work' }
  const claudeRead = headlessInvocation('claude', { ...base, model: 'sonnet', extraArgs: ['--verbose'] })
  assert.deepEqual(claudeRead, {
    args: ['-p', '--output-format', 'json', '--strict-mcp-config', '--tools', 'Read,Grep,Glob', '--permission-mode', 'plan', '--setting-sources', 'user', '--model', 'sonnet', '--verbose'],
    stdin: '- hello',
    env: {},
  })
  assert.deepEqual(headlessInvocation('claude', { ...base, access: 'write', extraArgs: ['--verbose'] }).args, ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--verbose'])
  assert.deepEqual(headlessInvocation('codex', base).args, ['exec', '--json', '-C', '/work', '--skip-git-repo-check', '--sandbox', 'read-only', '-'])
  assert.deepEqual(headlessInvocation('codex', { ...base, access: 'write', model: 'o3' }).args, ['exec', '--json', '-C', '/work', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-m', 'o3', '-'])
  const gemini = headlessInvocation('gemini', base)
  assert.deepEqual(gemini.args, ['-o', 'json', '--approval-mode', 'plan'])
  assert.equal(gemini.stdin, '- hello')
  assert.equal(gemini.env['GEMINI_CLI_TRUST_WORKSPACE'], undefined)
  const geminiWrite = headlessInvocation('gemini', { ...base, access: 'write' })
  assert.deepEqual(geminiWrite.args, ['-o', 'json', '--approval-mode', 'auto_edit'])
  assert.equal(geminiWrite.env['GEMINI_CLI_TRUST_WORKSPACE'], 'true')
  const agy = headlessInvocation('antigravity', base)
  assert.deepEqual(agy.args, ['--input-format', 'stream-json', '--output-format', 'stream-json', '--mode', 'plan', '-p='])
  assert.equal(agy.stdin, '{"event":"user","message":{"content":"- hello"}}\n')
  assert.deepEqual(headlessInvocation('antigravity', { ...base, access: 'write', model: 'm', extraArgs: ['--x'] }).args, ['--input-format', 'stream-json', '--output-format', 'stream-json', '--model', 'm', '--dangerously-skip-permissions', '--x', '-p='])
  const opencode = headlessInvocation('opencode', { ...base, model: 'anthropic/claude' })
  assert.deepEqual(opencode.args, ['run', '--format', 'json', '--agent', 'plan', '-m', 'anthropic/claude'])
  assert.equal(opencode.stdin, '- hello')
  assert.deepEqual(headlessInvocation('opencode', { ...base, access: 'write' }).args, ['run', '--format', 'json'])
})

test('the child environment is an allowlist plus the agent prefixes', () => {
  const base = { PATH: '/bin', HOME: '/h', LC_ALL: 'C', XDG_CONFIG_HOME: '/x', NVM_DIR: '/n', SECRET_TOKEN: 's', AWS_SECRET_ACCESS_KEY: 'a', ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'o', GEMINI_API_KEY: 'g', Path: '/win' }
  assert.deepEqual(Object.keys(headlessEnvironment('claude', base)).sort(), ['ANTHROPIC_API_KEY', 'HOME', 'LC_ALL', 'NVM_DIR', 'PATH', 'Path', 'XDG_CONFIG_HOME'])
  assert.ok(!('ANTHROPIC_API_KEY' in headlessEnvironment('codex', base)))
  assert.ok('OPENAI_API_KEY' in headlessEnvironment('codex', base))
  assert.ok('GEMINI_API_KEY' in headlessEnvironment('antigravity', base))
  assert.ok(!('OPENAI_API_KEY' in headlessEnvironment('claude', base)))
  assert.ok('CLAUDE_CODE_USE_BEDROCK' in headlessEnvironment('claude', { CLAUDE_CODE_USE_BEDROCK: '1' }))
  assert.ok(!('GOOGLE_API_KEY' in headlessEnvironment('antigravity', { GOOGLE_API_KEY: 'g' })))
  const gemini = headlessEnvironment('gemini', { GOOGLE_API_KEY: 'g', GOOGLE_APPLICATION_CREDENTIALS: '/sa.json' })
  assert.deepEqual(gemini, { GOOGLE_API_KEY: 'g' })
  assert.equal(headlessEnvironment('gemini', { GOOGLE_APPLICATION_CREDENTIALS: '/sa.json' }, { GOOGLE_APPLICATION_CREDENTIALS: '/explicit.json' })['GOOGLE_APPLICATION_CREDENTIALS'], '/explicit.json')
  const opencode = headlessEnvironment('opencode', { ...base, OPENCODE_CONFIG: '/c' }, { EXTRA: '1', ANTHROPIC_API_KEY: 'explicit' })
  assert.deepEqual(Object.keys(opencode).filter((key) => /_API_KEY$|^OPENCODE_|^EXTRA$/.test(key)).sort(), ['ANTHROPIC_API_KEY', 'EXTRA', 'OPENCODE_CONFIG'])
  assert.equal(opencode['ANTHROPIC_API_KEY'], 'explicit')
  assert.ok(!('SECRET_TOKEN' in opencode) && !('AWS_SECRET_ACCESS_KEY' in opencode))
  assert.equal(isHeadlessAgent('claude'), true)
  assert.equal(isHeadlessAgent('claude-desktop'), false)
  assert.equal(isHeadlessAgent(undefined), false)
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
  assert.deepEqual(seen.args, ['-p', '--output-format', 'json', '--strict-mcp-config', '--tools', 'Read,Grep,Glob', '--permission-mode', 'plan', '--setting-sources', 'user', '--model', 'haiku'])
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

test('long multi-line prompts stay off the command line, even for agy.cmd on Windows', async (t) => {
  const home = await tempDir(t)
  const ctx = platformContext({ platform: 'win32', home: 'C:\\Users\\a', env: {} })
  const bin = 'C:\\Users\\a\\AppData\\Roaming\\npm\\agy.cmd'
  const prompt = Array.from({ length: 6000 }, (_, index) => `line ${index}: ${'&%^"'.repeat(12)}`).join('\r\n')
  assert.ok(prompt.length > 300_000)
  for (const agent of HEADLESS_AGENTS) {
    const invocation = headlessInvocation(agent, { prompt, cwd: home })
    assert.ok(invocation.args.every((arg) => !arg.includes('line 1:')), agent)
    assert.ok((spawnSpec(bin, invocation.args, ctx).args.at(-1) ?? '').length < WINDOWS_COMMAND_LINE_LIMIT, agent)
    assert.ok(invocation.stdin?.includes('line 5999:'), agent)
  }
  assert.deepEqual(JSON.parse(headlessInvocation('antigravity', { prompt, cwd: home }).stdin ?? ''), { event: 'user', message: { content: prompt } })
  await assert.rejects(runHeadless({ agent: 'nope' as HeadlessAgent, prompt: 'x', cwd: home, bin, ctx }), failure('UNAVAILABLE'))
  await assert.rejects(runHeadless({ agent: 'claude', prompt: 'x', cwd: path.join(home, 'missing'), bin: process.execPath, ctx: sandbox(home) }), failure('FAILED', /does not exist/))
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
  console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'c', status: 'SUCCESS', response: seen } }))
  console.log(JSON.stringify({ type: 'result', is_error: false, session_id: 's', result: seen, response: seen, conversation_id: 'c' }))
})
`

test('prompts with dashes, quotes, shell characters and line breaks arrive untouched on every channel', { skip: process.platform === 'win32' }, async (t) => {
  const home = await tempDir(t)
  const ctx = sandbox(home)
  const echo = await fakeHarness(home, 'echo.cjs', CHANNEL_ECHO)
  for (const prompt of AWKWARD_PROMPTS) {
    for (const agent of ['claude', 'codex', 'gemini', 'opencode'] as HeadlessAgent[]) {
      const seen = JSON.parse((await runHeadless({ agent, prompt, cwd: home, bin: echo, ctx })).text) as { input: string; args: string[] }
      assert.equal(seen.input, prompt)
      assert.ok(!seen.args.includes(prompt) || prompt === '-p' || prompt === '--help' || prompt === '')
    }
    const seen = JSON.parse((await runHeadless({ agent: 'antigravity', prompt, cwd: home, bin: echo, ctx })).text) as { input: string; args: string[] }
    assert.deepEqual(JSON.parse(seen.input), { event: 'user', message: { content: prompt } })
    assert.ok(seen.input.endsWith('}\n') && !seen.input.slice(0, -1).includes('\n'))
    assert.equal(seen.args.at(-1), '-p=')
    assert.ok(!seen.args.some((arg) => arg.includes(prompt) && prompt.length > 3))
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

test('gemini trusts the workspace only for writes and the child never sees the env of other agents', { skip: process.platform === 'win32' }, async (t) => {
  const home = await tempDir(t)
  const echo = await fakeHarness(home, 'echo.cjs', `console.log(JSON.stringify({ response: JSON.stringify({ trust: process.env.GEMINI_CLI_TRUST_WORKSPACE, headless: process.env.KIT_HEADLESS, openai: process.env.OPENAI_API_KEY, secret: process.env.SECRET_TOKEN, google: process.env.GOOGLE_API_KEY }) }))`)
  const ctx = sandbox(home, { GEMINI_CLI_TRUST_WORKSPACE: 'true', OPENAI_API_KEY: 'o', SECRET_TOKEN: 's', GOOGLE_API_KEY: 'g' })
  const read = JSON.parse((await runHeadless({ agent: 'gemini', prompt: 'p', cwd: home, bin: echo, ctx })).text) as Record<string, string | undefined>
  assert.deepEqual(read, { headless: '1', google: 'g' })
  const write = JSON.parse((await runHeadless({ agent: 'gemini', prompt: 'p', cwd: home, bin: echo, ctx, access: 'write' })).text) as Record<string, string | undefined>
  assert.deepEqual(write, { trust: 'true', headless: '1', google: 'g' })
  const explicit = JSON.parse((await runHeadless({ agent: 'gemini', prompt: 'p', cwd: home, bin: echo, ctx, env: { SECRET_TOKEN: 'mine' } })).text) as Record<string, string | undefined>
  assert.equal(explicit['secret'], 'mine')
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

test('a real child of claude never receives the keys of other providers', { skip: process.platform === 'win32' }, async (t) => {
  const home = await tempDir(t)
  const echo = await fakeHarness(home, 'echo.cjs', `process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ result: JSON.stringify({ openai: process.env.OPENAI_API_KEY ?? null, anthropic: process.env.ANTHROPIC_API_KEY ?? null, gac: process.env.GOOGLE_APPLICATION_CREDENTIALS ?? null }) })))`)
  const ctx = sandbox(home, { OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: 'a', GOOGLE_APPLICATION_CREDENTIALS: '/sa.json' })
  assert.deepEqual(JSON.parse((await runHeadless({ agent: 'claude', prompt: 'p', cwd: home, bin: echo, ctx })).text), { openai: null, anthropic: 'a', gac: null })
})

test('headlessEnv keeps proxies and CAs and opens cloud credentials only when the agent is told to use them', () => {
  const base = {
    PATH: '/bin',
    HTTPS_PROXY: 'http://proxy:3128',
    https_proxy: 'http://proxy:3128',
    no_proxy: 'localhost',
    ALL_PROXY: 'socks5://p',
    NODE_EXTRA_CA_CERTS: '/ca.pem',
    SSL_CERT_FILE: '/cert.pem',
    SSL_CERT_DIR: '/certs',
    REQUESTS_CA_BUNDLE: '/bundle.pem',
    OPENAI_API_KEY: 'o',
    AWS_ACCESS_KEY_ID: 'aws',
    GOOGLE_APPLICATION_CREDENTIALS: '/sa.json',
    CLOUD_ML_REGION: 'us-east5',
    ANTHROPIC_VERTEX_PROJECT_ID: 'p',
  }
  const claude = headlessEnv('claude', base)
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'no_proxy', 'ALL_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE']) assert.ok(key in claude, key)
  assert.ok(!('OPENAI_API_KEY' in claude))
  assert.ok(!('AWS_ACCESS_KEY_ID' in claude))
  assert.ok(!('GOOGLE_APPLICATION_CREDENTIALS' in claude) && !('CLOUD_ML_REGION' in claude))
  assert.ok('AWS_ACCESS_KEY_ID' in headlessEnv('claude', { ...base, CLAUDE_CODE_USE_BEDROCK: '1' }))
  const vertex = headlessEnv('claude', { ...base, CLAUDE_CODE_USE_VERTEX: '1' })
  assert.ok(['GOOGLE_APPLICATION_CREDENTIALS', 'CLOUD_ML_REGION', 'ANTHROPIC_VERTEX_PROJECT_ID'].every((key) => key in vertex))
  assert.ok(!('AWS_ACCESS_KEY_ID' in vertex))
  assert.ok(!('GOOGLE_APPLICATION_CREDENTIALS' in headlessEnv('gemini', base)))
  assert.ok('GOOGLE_APPLICATION_CREDENTIALS' in headlessEnv('gemini', { ...base, GOOGLE_GENAI_USE_VERTEXAI: 'true' }))
  assert.ok(!('GOOGLE_APPLICATION_CREDENTIALS' in headlessEnv('gemini', { ...base, GOOGLE_GENAI_USE_VERTEXAI: 'false' })))
  assert.ok('HTTPS_PROXY' in headlessEnv('opencode', base) && !('OPENAI_API_KEY' in headlessEnv('opencode', base)))
})

test('live child groups are tracked for the exit handler and released when the child ends', { skip: process.platform === 'win32' }, async (t) => {
  const home = await tempDir(t)
  const ctx = sandbox(home)
  const slow = await fakeHarness(home, 'slow.cjs', `setTimeout(() => console.log(JSON.stringify({ result: 'ok' })), 300)`)
  const listeners = process.listenerCount('exit')
  const pids: number[] = []
  const pending = runHeadless({ agent: 'claude', prompt: 'x', cwd: home, bin: slow, ctx, onSpawn: (pid) => pids.push(pid) })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(liveHeadlessGroups(), pids)
  assert.equal(process.listenerCount('exit'), listeners + 1)
  assert.equal((await pending).text, 'ok')
  assert.deepEqual(liveHeadlessGroups(), [])
  assert.equal(process.listenerCount('exit'), listeners)
})

test('a parent that exits takes its headless children with it', { skip: process.platform === 'win32' }, async (t) => {
  const home = await tempDir(t)
  const slow = await fakeHarness(home, 'slow.cjs', `setInterval(() => {}, 1000)`)
  const pidFile = path.join(home, 'pid')
  const parent = path.join(home, 'parent.mts')
  const source = path.join(import.meta.dirname, '..', 'src', 'agents', 'index.ts')
  await writeFile(parent, `import { writeFileSync } from 'node:fs'\nimport { runHeadless } from ${JSON.stringify(source)}\nrunHeadless({ agent: 'claude', prompt: 'x', cwd: ${JSON.stringify(home)}, bin: ${JSON.stringify(slow)}, onSpawn: (pid) => { writeFileSync(${JSON.stringify(pidFile)}, String(pid)); setTimeout(() => process.exit(0), 200) } }).catch(() => {})\n`)
  const { execFile } = await import('node:child_process')
  await new Promise<void>((resolve, reject) => execFile(process.execPath, [parent], (error) => (error ? reject(error) : resolve())))
  const pid = Number(await readFile(pidFile, 'utf8'))
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.throws(() => process.kill(pid, 0))
})

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  test(`${signal} to the parent kills the headless child group and still ends the parent`, { skip: process.platform === 'win32' }, async (t) => {
    const home = await tempDir(t)
    const sleeper = path.join(home, 'fake-claude')
    await writeFile(sleeper, '#!/bin/sh\nexec sleep 300\n')
    await chmod(sleeper, 0o755)
    const pidFile = path.join(home, 'pid')
    const parent = path.join(home, 'parent.mts')
    const source = path.join(import.meta.dirname, '..', 'src', 'agents', 'index.ts')
    await writeFile(parent, `import { writeFileSync } from 'node:fs'\nimport { runHeadless } from ${JSON.stringify(source)}\nrunHeadless({ agent: 'claude', prompt: 'x', cwd: ${JSON.stringify(home)}, bin: ${JSON.stringify(sleeper)}, onSpawn: (pid) => writeFileSync(${JSON.stringify(pidFile)}, String(pid)) }).catch(() => {})\n`)
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, [parent], { stdio: 'ignore' })
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.once('exit', (_code, sig) => resolve(sig)))
    let pid = 0
    for (let attempt = 0; attempt < 100 && pid === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      pid = Number(await readFile(pidFile, 'utf8').catch(() => '0'))
    }
    assert.ok(pid > 0)
    process.kill(pid, 0)
    child.kill(signal)
    assert.equal(await exited, signal)
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.throws(() => process.kill(pid, 0))
  })
}

test('signal handlers are registered only while children are alive', { skip: process.platform === 'win32' }, async (t) => {
  const home = await tempDir(t)
  const slow = await fakeHarness(home, 'slow.cjs', `setTimeout(() => console.log(JSON.stringify({ result: 'ok' })), 300)`)
  const before = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => process.listenerCount(signal))
  const pending = runHeadless({ agent: 'claude', prompt: 'x', cwd: home, bin: slow, ctx: sandbox(home) })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => process.listenerCount(signal)), before.map((count) => count + 1))
  await pending
  assert.deepEqual(['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => process.listenerCount(signal)), before)
})

test('antigravity keeps a useful response even when it also reports an error', () => {
  assert.deepEqual(parseHeadlessOutput('antigravity', agyResult({ status: 'SUCCESS', response: 'Done.', error: 'tool timeout', conversation_id: 'c' })), { text: 'Done.', sessionId: 'c' })
  assert.throws(() => parseHeadlessOutput('antigravity', agyResult({ status: 'SUCCESS', response: '  ', error: 'tool timeout' })), failure('FAILED', /tool timeout/))
  assert.throws(() => parseHeadlessOutput('antigravity', agyResult({ status: 'ERROR', response: 'partial', error: 'quota' })), failure('FAILED', /quota/))
})

test('unset removes variables without regard to case on Windows', async (t) => {
  const home = await tempDir(t)
  const echo = await fakeHarness(home, 'echo.cjs', `console.log(JSON.stringify({ response: String(Object.keys(process.env).some((key) => key.toUpperCase() === 'GEMINI_CLI_TRUST_WORKSPACE')) }))`)
  const env = { ...sandbox(home).env, gemini_cli_trust_workspace: 'true', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\x86', NUMBER_OF_PROCESSORS: '8' }
  const kept = headlessEnv('gemini', env)
  assert.ok(['ProgramFiles', 'ProgramFiles(x86)', 'NUMBER_OF_PROCESSORS'].every((key) => key in kept))
  if (process.platform !== 'win32') {
    const unix = await runHeadless({ agent: 'gemini', prompt: 'p', cwd: home, bin: echo, ctx: platformContext({ ...sandbox(home), env }) })
    assert.equal(unix.text, 'true')
    const direct = path.join(home, 'direct.cjs')
    await writeFile(direct, `#!${process.execPath}\nconsole.log(JSON.stringify({ response: String(Object.keys(process.env).some((key) => key.toUpperCase() === 'GEMINI_CLI_TRUST_WORKSPACE')) }))\n`)
    await chmod(direct, 0o755)
    const windows = await runHeadless({ agent: 'gemini', prompt: 'p', cwd: home, bin: direct, ctx: platformContext({ platform: 'win32', home, env }) })
    assert.equal(windows.text, 'false')
  }
})

test('claude tools replace the default read set and an empty list leaves no tools at all', () => {
  const base = { prompt: 'p', cwd: '/work' }
  const strictEmpty = ['--strict-mcp-config', '--tools', 'Read,Grep,Glob', '--disallowedTools', 'Read,Grep,Glob']
  assert.deepEqual(headlessInvocation('claude', { ...base, tools: [] }).args, ['-p', '--output-format', 'json', ...strictEmpty, '--permission-mode', 'plan', '--setting-sources', 'user'])
  assert.deepEqual(headlessInvocation('claude', { ...base, tools: [' ', ''], access: 'write' }).args, ['-p', '--output-format', 'json', ...strictEmpty, '--permission-mode', 'acceptEdits'])
  const read = headlessInvocation('claude', { ...base, tools: ['Read'] }).args
  assert.deepEqual(read, ['-p', '--output-format', 'json', '--strict-mcp-config', '--tools', 'Read', '--permission-mode', 'plan', '--setting-sources', 'user'])
  assert.equal(read.filter((arg) => arg === '--tools').length, 1)
  assert.deepEqual(headlessInvocation('claude', { ...base, tools: ['Read', 'Write'], access: 'write' }).args, ['-p', '--output-format', 'json', '--strict-mcp-config', '--tools', 'Read,Write', '--permission-mode', 'acceptEdits'])
  assert.deepEqual(headlessInvocation('claude', { ...base, access: 'write' }).args, ['-p', '--output-format', 'json', '--permission-mode', 'acceptEdits'])
  for (const agent of ['codex', 'gemini', 'antigravity', 'opencode'] as HeadlessAgent[]) {
    assert.deepEqual(headlessInvocation(agent, { ...base, tools: ['Read'] }), headlessInvocation(agent, base), agent)
  }
})

test('runHeadless stops a harness that prints more than maxOutputBytes', { skip: process.platform === 'win32' }, async (t) => {
  const home = await tempDir(t)
  const ctx = sandbox(home)
  const flood = await fakeHarness(home, 'flood.cjs', `const line = 'x'.repeat(65536) + '\\n'\nconst write = () => { while (process.stdout.write(line)) {} process.stdout.once('drain', write) }\nwrite()\nsetTimeout(() => {}, 60000)`)
  const started = Date.now()
  await assert.rejects(runHeadless({ agent: 'claude', prompt: 'x', cwd: home, bin: flood, ctx, maxOutputBytes: 1024 * 1024, timeoutMs: 30000 }), failure('FAILED', /more than 1048576 bytes on stdout/))
  assert.ok(Date.now() - started < 20000)
  assert.deepEqual(liveHeadlessGroups(), [])
  const small = await fakeHarness(home, 'small.cjs', `console.log(JSON.stringify({ type: 'result', is_error: false, session_id: 's', result: 'ok' }))`)
  assert.equal((await runHeadless({ agent: 'claude', prompt: 'x', cwd: home, bin: small, ctx, maxOutputBytes: 200 })).text, 'ok')
  await assert.rejects(runHeadless({ agent: 'claude', prompt: 'x', cwd: home, bin: small, ctx, maxOutputBytes: 10 }), failure('FAILED', /more than 10 bytes/))
})

test('runHeadless keeps only the tail of stderr past maxOutputBytes and still succeeds', { skip: process.platform === 'win32' }, async (t) => {
  const home = await tempDir(t)
  const noisy = await fakeHarness(home, 'noisy.cjs', `for (let i = 0; i < 400; i++) process.stderr.write('ñ'.repeat(1000) + '\\n')\nprocess.stderr.write('LAST LINE\\n')\nconsole.log(JSON.stringify({ type: 'result', is_error: false, session_id: 's', result: 'ok' }))`)
  const result = await runHeadless({ agent: 'claude', prompt: 'x', cwd: home, bin: noisy, ctx: sandbox(home), maxOutputBytes: 4096 })
  assert.equal(result.text, 'ok')
  assert.ok(Buffer.byteLength(result.stderr) <= 4096)
  assert.ok(result.stderr.endsWith('LAST LINE\n'))
  assert.ok(!result.stderr.includes('\uFFFD'))
})

const agyDelta = (step: number, delta: string) => `${JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'c', step_index: step, state: 'ACTIVE', step_type: 'agent_response', text_delta: delta } })}\n`

test('antigravity streams: several results, ids from init, text deltas and error events', () => {
  const init = '{"event":"init","conversation_id":"from-init","init":{}}\n'
  assert.deepEqual(parseHeadlessOutput('antigravity', init + agyResult({ conversation_id: 'a', status: 'SUCCESS', response: 'first' }) + agyResult({ conversation_id: 'b', status: 'SUCCESS', response: 'second' })), { text: 'second', sessionId: 'b' })
  assert.deepEqual(parseHeadlessOutput('antigravity', init + agyResult({ conversation_id: '', status: 'SUCCESS', response: 'r' })), { text: 'r', sessionId: 'from-init' })
  assert.deepEqual(parseHeadlessOutput('antigravity', init + agyDelta(1, 'Hel') + agyDelta(1, 'lo') + agyDelta(3, 'again') + agyResult({ conversation_id: '', status: 'SUCCESS', response: '' })), { text: 'Hello\n\nagain', sessionId: 'from-init' })
  assert.deepEqual(parseHeadlessOutput('antigravity', agyDelta(1, 'old') + agyResult({ status: 'SUCCESS', response: 'one' }) + agyDelta(1, 'two') + agyResult({ status: 'SUCCESS', response: '' })), { text: 'two' })
  assert.deepEqual(parseHeadlessOutput('antigravity', init + agyDelta(1, 'partial ') + agyDelta(1, 'answer')), { text: 'partial answer', sessionId: 'from-init' })
  assert.throws(() => parseHeadlessOutput('antigravity', init + agyDelta(1, 'partial') + '{"event":"error","error":{"message":"stream broke"}}\n'), failure('FAILED', /stream broke/))
  assert.throws(() => parseHeadlessOutput('antigravity', '{"event":"error","message":"quota exceeded"}\n'), failure('FAILED', /quota exceeded/))
  assert.throws(() => parseHeadlessOutput('antigravity', '{"event":"error","message":"late"}\n' + agyResult({ status: 'SUCCESS', response: '' })), failure('FAILED', /late/))
  assert.deepEqual(parseHeadlessOutput('antigravity', '{"event":"error","message":"tool hiccup"}\n' + agyResult({ status: 'SUCCESS', response: 'fine', conversation_id: 'c' })), { text: 'fine', sessionId: 'c' })
})

test('runHeadless returns partial agy deltas only when the process exits cleanly', { skip: process.platform === 'win32' }, async (t) => {
  const home = await tempDir(t)
  const ctx = sandbox(home)
  const lines = JSON.stringify(agyDelta(1, 'partial') + agyDelta(1, ' text'))
  const clean = await fakeHarness(home, 'clean.cjs', `process.stdin.resume().on('end', () => process.stdout.write(${lines}))`)
  assert.equal((await runHeadless({ agent: 'antigravity', prompt: 'x', cwd: home, bin: clean, ctx })).text, 'partial text')
  const crash = await fakeHarness(home, 'crash.cjs', `process.stdin.resume().on('end', () => { process.stdout.write(${lines}); process.exitCode = 3 })`)
  await assert.rejects(runHeadless({ agent: 'antigravity', prompt: 'x', cwd: home, bin: crash, ctx }), failure('FAILED', /exited with 3/))
})

test('maxOutputBytes counts UTF-8 bytes, not characters, on stdout and stderr', { skip: process.platform === 'win32' }, async (t) => {
  const home = await tempDir(t)
  const ctx = sandbox(home)
  const answer = '€'.repeat(100)
  const emoji = await fakeHarness(home, 'emoji.cjs', `process.stderr.write('🚀'.repeat(5000))\nconsole.log(JSON.stringify({ type: 'result', is_error: false, session_id: 's', result: ${JSON.stringify(answer)} }))`)
  const fits = await runHeadless({ agent: 'claude', prompt: 'x', cwd: home, bin: emoji, ctx, maxOutputBytes: 400 })
  assert.equal(fits.text, answer)
  assert.ok(Buffer.byteLength(fits.stderr) <= 400 && fits.stderr.length > 0)
  assert.match(fits.stderr, /^(🚀)+$/u)
  await assert.rejects(runHeadless({ agent: 'claude', prompt: 'x', cwd: home, bin: emoji, ctx, maxOutputBytes: 250 }), failure('FAILED', /more than 250 bytes on stdout/))
})

test('a timeout is reported as TIMEOUT even when output keeps flowing past maxOutputBytes', { skip: process.platform === 'win32' }, async (t) => {
  const home = await tempDir(t)
  const stubborn = await fakeHarness(home, 'stubborn.cjs', `process.on('SIGTERM', () => { process.stdout.write('y'.repeat(200000)); setTimeout(() => process.exit(0), 50) })\nprocess.stdout.write('x')\nsetInterval(() => {}, 1000)`)
  await assert.rejects(runHeadless({ agent: 'claude', prompt: 'x', cwd: home, bin: stubborn, ctx: sandbox(home), timeoutMs: 300, maxOutputBytes: 1000 }), failure('TIMEOUT'))
})
