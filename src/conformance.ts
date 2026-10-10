import { isEnvelope, parseEnvelope } from './envelope.ts'
import { run, type PlatformContext, platformContext } from './platform.ts'
import { readCapabilities, validateManifest, type ToolManifest } from './registry.ts'

export interface ConformanceReport {
  ok: boolean
  problems: string[]
}

export async function checkConformance(bin: readonly string[], manifest?: ToolManifest, ctx: PlatformContext = platformContext()): Promise<ConformanceReport> {
  const problems: string[] = []
  if (manifest) problems.push(...validateManifest(manifest).map((problem) => `manifest: ${problem}`))
  const [command, ...prefix] = bin
  if (!command) return { ok: false, problems: [...problems, 'bin is empty'] }

  let stdout = ''
  try {
    stdout = (await run(command, [...prefix, 'capabilities', '--json'], { env: ctx.env, timeoutMs: 20_000 })).stdout
  } catch (error) {
    problems.push(`capabilities --json failed: ${error instanceof Error ? error.message : String(error)}`)
    return { ok: false, problems }
  }
  const lines = stdout.trim().split('\n').filter((line) => line.length > 0)
  if (lines.length !== 1) problems.push(`capabilities --json must print exactly one line, printed ${lines.length}`)
  const envelope = parseEnvelope(stdout)
  if (!envelope) {
    problems.push('capabilities --json did not print a valid envelope')
    return { ok: false, problems }
  }
  if (envelope.command !== 'capabilities') problems.push(`envelope.command must be "capabilities", got "${envelope.command}"`)
  if (!envelope.ok) problems.push('capabilities --json answered ok: false')
  const capabilities = readCapabilities(envelope)
  if (!capabilities) problems.push('capabilities data must carry name, version and a capabilities array')
  if (capabilities && manifest) {
    if (capabilities.name !== manifest.name) problems.push(`name differs: manifest ${manifest.name}, binary ${capabilities.name}`)
    if (capabilities.version !== manifest.version) problems.push(`version differs: manifest ${manifest.version}, binary ${capabilities.version}`)
    const missing = manifest.capabilities.filter((capability) => !capabilities.capabilities.includes(capability))
    if (missing.length > 0) problems.push(`binary does not report: ${missing.join(', ')}`)
  }

  try {
    const failing = await run(command, [...prefix, '__kit_conformance_unknown__', '--json'], { env: ctx.env, timeoutMs: 20_000 }).then(
      (result) => ({ stdout: result.stdout, code: 0 }),
      (error: { stdout?: string; code?: number }) => ({ stdout: error.stdout ?? '', code: error.code ?? 1 }),
    )
    if (failing.code === 0) problems.push('an unknown command must exit with a non-zero code')
    const errorEnvelope = parseEnvelope(failing.stdout)
    if (!errorEnvelope || !isEnvelope(errorEnvelope) || errorEnvelope.ok) problems.push('an unknown command with --json must print an error envelope')
  } catch (error) {
    problems.push(`unknown command check failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  return { ok: problems.length === 0, problems }
}

export async function assertConformance(bin: readonly string[], manifest?: ToolManifest, ctx?: PlatformContext): Promise<void> {
  const report = await checkConformance(bin, manifest, ctx)
  if (!report.ok) throw new Error(`kit conformance failed:\n- ${report.problems.join('\n- ')}`)
}
