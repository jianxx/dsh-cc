/**
 * Cross-process resume marker. The TUI writes the live session id; the
 * `dsh-cc` launcher (and `DSH_CC_RESUME_SESSION`) feed it back on next boot.
 * Session records themselves stay in harness persistence.
 * @module @jianxx/dsh-cc-tui/resume-target
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ResumeTargetOptions {
  /** Data directory. Defaults to `$DSH_HOME/tui` or `~/.dsh/tui`. */
  home?: string
}

function dataDir(options: ResumeTargetOptions = {}): string {
  if (options.home !== undefined) return options.home
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(dshHome, 'tui')
}

function resumeFile(options: ResumeTargetOptions = {}): string {
  return join(dataDir(options), 'resume.txt')
}

/**
 * Persist the session id the next `dsh --profile tui --resume` should attach.
 */
export function writeResumeTarget(sessionId: string, options: ResumeTargetOptions = {}): void {
  const dir = dataDir(options)
  mkdirSync(dir, { recursive: true })
  writeFileSync(resumeFile(options), `${sessionId.trim()}\n`)
}

/** Forget the marker (`/new` / a fresh session). */
export function clearResumeTarget(options: ResumeTargetOptions = {}): void {
  try {
    writeFileSync(resumeFile(options), '')
  } catch {
    // Best effort — the marker is a launcher nicety.
  }
}

/**
 * The stored session id, or undefined when absent/blank.
 */
export function readResumeTarget(options: ResumeTargetOptions = {}): string | undefined {
  try {
    const value = readFileSync(resumeFile(options), 'utf8').trim()
    return value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}
