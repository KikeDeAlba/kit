import assert from 'node:assert/strict'
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { HeadlessError, liveHeadlessGroups, headlessEnv, headlessEnvironment, headlessInvocation, isHeadlessAgent, parseHeadlessOutput, pickHeadlessAgent, runHeadless, type HeadlessAgent } from '../src/agents/index.ts'
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
  assert.deepEqual(parseHeadlessOutput('antigravity', await fixture('antigravity.json')), { text: 'OK\n', sessionId: '49156f6b-9013-4da5-96c9-92efe16b0285' })
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
  const denied = await fixture('antigravity-denied.json')
  assert.throws(() => parseHeadlessOutput('antigravity', denied), failure('FAILED', /permission denied for write_file/))
  const agyError = await fixture('antigravity-error.json')
  assert.throws(() => parseHeadlessOutput('antigravity', agyError), failure('FAILED', /empty prompt/))
  assert.deepEqual(parseHeadlessOutput('antigravity', '{"response":"done","conversation_id":"c","denied_actions":[{"action":"run_command"}]}'), { text: 'done', sessionId: 'c' })
  assert.throws(() => parseHeadlessOutput('nope' as HeadlessAgent, '{}'), failure('UNAVAILABLE'))
  const codexFailed = await fixture('codex-failed.jsonl')
  assert.throws(() => parseHeadlessOutput('codex', codexFailed), failure('FAILED', /usage limit/))
})

test('each harness gets its own flags, sandbox and prompt channel', () => {
  const base = { prompt: '- hello', cwd: '/work' }
  const claudeRead = headlessInvocation('claude', { ...base, model: 'sonnet', extraArgs: ['--verbose'] })
  assert.deepEqual(claudeRead, {
    args: ['-p', '--output-format', 'json', '--tools', 'Read,Grep,Glob', '--permission-mode', 'plan', '--setting-sources', 'user', '--model', 'sonnet', '--verbose'],
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
  assert.deepEqual(agy.args, ['--print=- hello', '--output-format', 'json', '--mode', 'plan'])
  assert.equal(agy.stdin, undefined)
  assert.deepEqual(headlessInvocation('antigravity', { ...base, access: 'write', model: 'm' }).args, ['--print=- hello', '--output-format', 'json', '--model', 'm', '--dangerously-skip-permissions'])
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
  assert.deepEqual(seen.args, ['-p', '--output-format', 'json', '--tools', 'Read,Grep,Glob', '--permission-mode', 'plan', '--setting-sources', 'user', '--model', 'haiku'])
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

test('prompts passed as arguments through cmd.exe are refused on Windows when they cannot survive', async (t) => {
  const home = await tempDir(t)
  const ctx = platformContext({ platform: 'win32', home: 'C:\\Users\\a', env: {} })
  const bin = 'C:\\Users\\a\\AppData\\Roaming\\npm\\agy.cmd'
  await assert.rejects(runHeadless({ agent: 'antigravity', prompt: 'x'.repeat(8200), cwd: home, bin, ctx }), failure('PROMPT_TOO_LONG', /8191/))
  await assert.rejects(runHeadless({ agent: 'antigravity', prompt: '&'.repeat(2500), cwd: home, bin, ctx }), failure('PROMPT_TOO_LONG'))
  await assert.rejects(runHeadless({ agent: 'antigravity', prompt: 'one\ntwo', cwd: home, bin, ctx }), failure('FAILED', /line break/))
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
    assert.equal(seen.input, '')
    assert.equal(seen.args[0], `--print=${prompt}`)
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
