/**
 * Cross-process resume marker. The TUI writes the live session id; the
 * `dsh-cc` launcher (and `DSH_CC_RESUME_SESSION`) feed it back on next boot.
 * Session records themselves stay in harness persistence.
 *
 * Markers are bucketed by cwd so a worktree (or any other checkout) does not
 * steal the last session of a sibling directory. The filename scheme
 * (`resume-<sha256(resolve(cwd))[:16]>.txt`) is duplicated in
 * `packages/launcher/tui/bootstrap.mjs` — keep the two in sync.
 * @module @jianxx/dsh-cc-tui/resume-target
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface ResumeTargetOptions {
  /** Data directory. Defaults to `$DSH_HOME/tui` or `~/.dsh/tui`. */
  home?: string
  /** Working directory the marker is keyed by. Defaults to `process.cwd()`. */
  cwd?: string
}

function dataDir(options: ResumeTargetOptions = {}): string {
  if (options.home !== undefined) return options.home
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(dshHome, 'tui')
}

function resumeKey(cwd: string): string {
  return createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 16)
}

/**
 * On-disk path of the resume marker for `cwd`. Exported so tests (and the
 * launcher, via the duplicated hash in bootstrap.mjs) can lock the scheme.
 */
export function resumeMarkerFile(options: ResumeTargetOptions = {}): string {
  const cwd = options.cwd ?? process.cwd()
  return join(dataDir(options), `resume-${resumeKey(cwd)}.txt`)
}

/**
 * Persist the session id the next `dsh --profile tui --resume` should attach.
 */
export function writeResumeTarget(sessionId: string, options: ResumeTargetOptions = {}): void {
  const dir = dataDir(options)
  mkdirSync(dir, { recursive: true })
  writeFileSync(resumeMarkerFile(options), `${sessionId.trim()}\n`)
}

/** Forget the marker (`/new` / a fresh session). */
export function clearResumeTarget(options: ResumeTargetOptions = {}): void {
  try {
    writeFileSync(resumeMarkerFile(options), '')
  } catch {
    // Best effort — the marker is a launcher nicety.
  }
}

/**
 * The stored session id, or undefined when absent/blank.
 */
export function readResumeTarget(options: ResumeTargetOptions = {}): string | undefined {
  try {
    const value = readFileSync(resumeMarkerFile(options), 'utf8').trim()
    return value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}
