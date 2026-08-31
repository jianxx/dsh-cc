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
 * Scan dsh-cc args for resume-mode flags. Collection is order-independent:
 * all flags are gathered during the scan, then applied once afterwards with
 * fixed precedence `--resume <id>` / `--resume=<id>` > `--new` > `-c` >
 * default marker. Every resume-mode flag is stripped from the forwarded
 * args; combined shorts (e.g. -cn) are not recognized — each flag must be
 * its own token.
 *
 * @param {string | undefined} resumeFlag
 * @param {string[]} rest
 * @param {Record<string, string>} env
 * @returns {{ env: Record<string, string>, args: string[], continueRequested: boolean }}
 */
export function interceptResume(resumeFlag, rest, env = {}) {
  const nextEnv = { ...env }
  const args = []
  if (typeof resumeFlag === 'string' && resumeFlag.length > 0) {
    nextEnv.DSH_CC_RESUME_SESSION = resumeFlag
  }
  let resumeId
  let hasResumeId = false
  let newSession = false
  let continueRequested = false
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]
    if (token === '--resume') {
      const value = rest[i + 1]
      if (value !== undefined && !value.startsWith('-')) {
        resumeId = value
        hasResumeId = true
        i += 1
        continue
      }
    }
    if (token.startsWith('--resume=')) {
      resumeId = token.slice('--resume='.length)
      hasResumeId = true
      continue
    }
    if (token === '--new' || token === '-n') {
      newSession = true
      continue
    }
    if (token === '--continue' || token === '-c') {
      continueRequested = true
      continue
    }
    args.push(token)
  }
  if (hasResumeId) {
    nextEnv.DSH_CC_RESUME_SESSION = resumeId
  } else if (newSession) {
    // Empty string is the fresh-session sentinel: the bin skips the marker
    // read on any defined value and the downstream plugin drops ''.
    nextEnv.DSH_CC_RESUME_SESSION = ''
  }
  return { env: nextEnv, args, continueRequested }
}

/**
 * Decide whether `-c`/`--continue` has a previous session to continue into.
 * Pure so the bin stays a thin shell. Returns the one-line stderr hint when
 * continue was requested but no resume target exists (an env override —
 * including the empty `--new` sentinel, which already chose fresh — or a
 * non-empty marker); null otherwise.
 *
 * @param {boolean} requested
 * @param {string | undefined} envTarget
 * @param {string | null} marker
 * @returns {string | null}
 */
export function continueHint(requested, envTarget, marker) {
  if (!requested) return null
  if (typeof envTarget === 'string') return null
  if (typeof marker === 'string' && marker.length > 0) return null
  return 'dsh-cc: no previous session to continue; starting a fresh session.'
}

/**
 * @param {boolean} profileExists
 * @param {string} version
 */
export function bootstrapCommand(profileExists, version) {
  if (profileExists) return undefined
  return ['plugin', '--profile', PROFILE, 'add', ...BUNDLES.map(name => `${name}@${version}`)]
}
