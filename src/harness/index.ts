import { platformContext, type PlatformContext } from '../platform.ts'
import { getSetting } from '../settings.ts'
import { DEFAULT_LAUNCH_OPTIONS, type HarnessId, type LaunchOptions } from './types.ts'

export * from './types.ts'
export * from './env.ts'
export * from './registry.ts'
export * from './process.ts'
export * from './args.ts'
export * from './summary.ts'
export * from './transcript.ts'
export * from './protobuf.ts'
export * from './antigravity-ids.ts'
export * from './profile-env.ts'
export * from './claude.ts'
export * from './codex.ts'
export * from './gemini.ts'
export * from './opencode.ts'
export * from './antigravity.ts'

export async function launchOptionsFor(id: HarnessId, ctx: PlatformContext = platformContext()): Promise<LaunchOptions> {
  const skipPermissions = await getSetting<boolean>(`harness.${id}.skipPermissions`, ctx)
  const extraArgs = await getSetting<string[]>(`harness.${id}.extraArgs`, ctx)
  return {
    skipPermissions: skipPermissions ?? DEFAULT_LAUNCH_OPTIONS.skipPermissions,
    extraArgs: extraArgs ?? DEFAULT_LAUNCH_OPTIONS.extraArgs,
  }
}
