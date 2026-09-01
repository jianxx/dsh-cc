/**
 * First-run helpers for the dsh-cc launcher. Pure so tests can drive the
 * decision table without spawning dsh.
 */

import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

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

// --- worktree support (--worktree) ------------------------------------------
// Slug, path, and branch rules mirror
// packages/workspace/tool-git-worktree/src/worktree.ts exactly — keep the two
// in sync. The tool package cannot be imported here: the launcher is plain
// dependency-free JS that runs before any build.

/** Env var carrying the launcher's worktree-session descriptor to the TUI. */
export const WORKTREE_ENV = 'DSH_CC_WORKTREE'

const MAX_SLUG_LENGTH = 64
const SEGMENT = /^[a-zA-Z0-9._-]+$/
const ADJECTIVES = ['swift', 'bright', 'calm', 'keen', 'bold']
const NOUNS = ['fox', 'owl', 'elm', 'oak', 'ray']

/**
 * Scan dsh-cc args for the `--worktree` flag and strip it. Name forms:
 * `--worktree <name>`, `--worktree=<name>`, or bare `--worktree` (random
 * name). A following token that starts with `-` is NOT taken as the name.
 * @param {string[]} args
 * @returns {{ name: string | null | undefined, args: string[] }}
 *   `name` is undefined when the flag is absent, null when present without a
 *   name, and the slug otherwise; `args` is the remainder to forward.
 */
export function parseWorktreeFlag(args) {
  let name
  const rest = []
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]
    if (token === '--worktree') {
      const value = args[i + 1]
      if (value !== undefined && !value.startsWith('-')) {
        name = value
        i += 1
      } else {
        name = null
      }
      continue
    }
    if (token.startsWith('--worktree=')) {
      const value = token.slice('--worktree='.length)
      name = value.length > 0 ? value : null
      continue
    }
    rest.push(token)
  }
  return { name, args: rest }
}

/**
 * Validate a worktree slug. Identical rules and messages to the tool
 * package's validateSlug.
 * @param {string} slug
 */
export function validateWorktreeSlug(slug) {
  if (slug.length > MAX_SLUG_LENGTH) {
    throw new Error(
      `invalid worktree name: must be ${MAX_SLUG_LENGTH} characters or fewer (got ${slug.length})`,
    )
  }
  for (const segment of slug.split('/')) {
    if (segment === '.' || segment === '..') {
      throw new Error(
        `invalid worktree name "${slug}": must not contain "." or ".." path segments`,
      )
    }
    if (!SEGMENT.test(segment)) {
      throw new Error(
        `invalid worktree name "${slug}": each "/"-separated segment must be non-empty and contain only letters, digits, dots, underscores, and dashes`,
      )
    }
  }
}

/**
 * @param {string} slug - A validated worktree slug.
 * @returns {string} the flattened single-directory name (`user/feature` → `user+feature`).
 */
export function flattenSlug(slug) {
  return slug.replaceAll('/', '+')
}

/**
 * @param {string} slug - A validated worktree slug.
 * @returns {string} the branch backing the worktree.
 */
export function worktreeBranch(slug) {
  return `worktree-${flattenSlug(slug)}`
}

/**
 * @param {string} repoRoot
 * @param {string} slug - A validated worktree slug.
 * @returns {string} the absolute on-disk worktree path.
 */
export function worktreePathFor(repoRoot, slug) {
  return join(repoRoot, '.claude', 'worktrees', flattenSlug(slug))
}

/**
 * Generate a random slug (`swift-fox-8f3a`), same word lists as the tool
 * package. Injectable `rand` keeps tests deterministic.
 * @param {() => number} [rand]
 * @returns {string}
 */
export function randomWorktreeSlug(rand = Math.random) {
  const adjective = ADJECTIVES[Math.floor(rand() * ADJECTIVES.length)]
  const noun = NOUNS[Math.floor(rand() * NOUNS.length)]
  const suffix = rand().toString(36).slice(2, 6)
  return `${adjective}-${noun}-${suffix}`
}

/**
 * @param {string} repoRoot
 * @param {string | null} name - Requested slug, or null for a random one.
 * @param {() => number} [rand]
 * @returns {{ slug: string, worktreePath: string, branch: string }}
 */
export function planWorktree(repoRoot, name, rand) {
  const slug = name === null || name === undefined ? randomWorktreeSlug(rand) : name
  validateWorktreeSlug(slug)
  return { slug, worktreePath: worktreePathFor(repoRoot, slug), branch: worktreeBranch(slug) }
}

/**
 * argv for `git worktree add -B <branch> <path> HEAD` (execFile form — no
 * shell, so no quoting concerns). `-B` resets a stale orphan branch left by
 * a removed worktree.
 * @param {{ worktreePath: string, branch: string }} plan
 * @returns {string[]}
 */
export function worktreeAddArgv(plan) {
  return ['worktree', 'add', '-B', plan.branch, plan.worktreePath, 'HEAD']
}

/**
 * Env fragment handed to the spawned dsh process so the TUI can recognize
 * this session as launcher-managed worktree session at /quit time.
 * @param {{ worktreePath: string, branch: string }} plan
 * @param {string} repoRoot
 * @param {string} baseHead - The commit the worktree was based on.
 * @returns {Record<string, string>}
 */
export function worktreeEnv(plan, repoRoot, baseHead) {
  return {
    [WORKTREE_ENV]: JSON.stringify({
      repoRoot,
      worktreePath: plan.worktreePath,
      branch: plan.branch,
      baseHead,
    }),
  }
}

/**
 * Filename of the cwd-bucketed resume marker. Must stay in lockstep with
 * `resumeMarkerFile` in packages/ui/tui/src/resume-target.ts: sha256 of
 * `path.resolve(cwd)`, first 16 hex chars.
 * @param {string} cwd
 * @returns {string}
 */
export function resumeMarkerName(cwd) {
  const key = createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 16)
  return `resume-${key}.txt`
}

/**
 * Absolute path of the cwd-bucketed resume marker under `$DSH_HOME/tui`.
 * @param {string} home - DSH_HOME (typically `~/.dsh`).
 * @param {string} cwd
 * @returns {string}
 */
export function resumeMarkerPath(home, cwd) {
  return join(home, 'tui', resumeMarkerName(cwd))
}

/**
 * Collision policy for a *named* `--worktree <slug>` whose path already
 * exists: reuse it (do not `git worktree add`). Random slugs still fail so
 * they can retry a fresh name.
 * @param {{ named: boolean, pathExists: boolean }} params
 * @returns {'reuse' | 'create'}
 */
export function existingWorktreeDecision({ named, pathExists }) {
  return named && pathExists ? 'reuse' : 'create'
}

/**
 * Collision policy for `git worktree add`: a random slug may retry with a
 * fresh name; a user-named slug fails immediately with an actionable error.
 * @param {{ named: boolean, attempt: number, maxAttempts?: number }} params
 * @returns {'retry' | 'fail'}
 */
export function slugRetryDecision({ named, attempt, maxAttempts = 5 }) {
  return !named && attempt < maxAttempts ? 'retry' : 'fail'
}
