import { PROFILE_ENV, PROFILE_HOME_ENV, ProfileError, envFor, resolveProfile } from '../profiles.ts'
import { withoutHarnessSession } from './env.ts'
import { contextFor } from './process.ts'
import type { HarnessId } from './types.ts'

function withoutProfileEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const names = new Set([...Object.values(PROFILE_HOME_ENV), PROFILE_ENV])
  for (const key of Object.keys(env)) if (names.has(key.toUpperCase())) delete env[key]
  return env
}

export async function harnessEnv(id: HarnessId, profile: string | null | undefined, baseEnv?: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const base = withoutHarnessSession(baseEnv ?? process.env)
  if (profile == null) return withoutProfileEnv(base)
  if (profile === '') throw new ProfileError('PROFILE_INVALID_NAME', 'the session profile name is empty')
  const resolved = await resolveProfile({ explicit: profile }, contextFor(base))
  return envFor(resolved.profile, id, base)
}
