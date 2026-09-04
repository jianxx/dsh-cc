export const DSH_PROFILE_ENV = 'DSH_CC_PROFILE'
export const DEFAULT_DSH_PROFILE = 'tui'

export function resolveDshProfile(env: NodeJS.Dict<string | undefined> = process.env): string {
  const value = env[DSH_PROFILE_ENV]
  return typeof value === 'string' && value.length > 0 ? value : DEFAULT_DSH_PROFILE
}
