/**
 * First-run helpers for the dsh-cc launcher. Pure so tests can drive the
 * decision table without spawning dsh.
 */

export const PROFILE = 'tui'
export const BUNDLES = [
  '@jianxx/dsh-cc-bundle-permissions',
  '@jianxx/dsh-cc-bundle-shell',
  '@jianxx/dsh-cc-bundle-tui',
]

/**
 * @param {string | undefined} resumeFlag
 * @param {string[]} rest
 * @returns {{ env: Record<string, string>, args: string[] }}
 */
export function interceptResume(resumeFlag, rest, env = {}) {
  const nextEnv = { ...env }
  const args = []
  if (typeof resumeFlag === 'string' && resumeFlag.length > 0) {
    nextEnv.DSH_CC_RESUME_SESSION = resumeFlag
  }
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]
    if (token === '--resume') {
      const value = rest[i + 1]
      if (value !== undefined && !value.startsWith('-')) {
        nextEnv.DSH_CC_RESUME_SESSION = value
        i += 1
        continue
      }
    }
    if (token.startsWith('--resume=')) {
      nextEnv.DSH_CC_RESUME_SESSION = token.slice('--resume='.length)
      continue
    }
    args.push(token)
  }
  return { env: nextEnv, args }
}

/**
 * @param {boolean} profileExists
 * @param {string} version
 */
export function bootstrapCommand(profileExists, version) {
  if (profileExists) return undefined
  return ['plugin', '--profile', PROFILE, 'add', ...BUNDLES.map(name => `${name}@${version}`)]
}
