import { ProfileError, envFor, resolveProfile } from '../profiles.ts'
import { withoutHarnessSession } from './env.ts'
import { contextFor } from './process.ts'
import type { HarnessId } from './types.ts'

export async function harnessEnv(id: HarnessId, profile: string | null | undefined, baseEnv?: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const base = withoutHarnessSession(baseEnv ?? process.env)
  if (profile == null) return base
  if (profile === '') throw new ProfileError('PROFILE_INVALID_NAME', 'the session profile name is empty')
  const resolved = await resolveProfile({ explicit: profile }, contextFor(base))
  return envFor(resolved.profile, id, base)
}
