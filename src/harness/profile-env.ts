import { envFor, resolveProfile } from '../profiles.ts'
import { withoutHarnessSession } from './env.ts'
import { contextFor } from './process.ts'
import type { HarnessId } from './types.ts'

export async function harnessEnv(id: HarnessId, profile: string | null, baseEnv?: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const base = withoutHarnessSession(baseEnv ?? process.env)
  if (profile === null) return base
  const resolved = await resolveProfile({ explicit: profile }, contextFor(base))
  return envFor(resolved.profile, id, base)
}
