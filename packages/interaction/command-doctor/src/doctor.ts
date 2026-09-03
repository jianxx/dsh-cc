/**
 * Pure `/doctor` report rendering: gathers a structured environment report and
 * renders it as human shell text. No cordis imports, so the formatter is
 * unit-testable in isolation from service mounting.
 * @module @jianxx/dsh-cc-command-doctor/doctor
 */

import type { HookIssue } from '@jianxx/dsh-cc-hook-protocol'

/** One capability seam's mount status. */
export interface SeamStatus {
  /** Seam name (e.g. `fs`, `llm`, `shell`). */
  readonly name: string
  /** Whether the seam's service is mounted in this composition. */
  readonly mounted: boolean
  /** Optional human detail for mounted seams (e.g. provider ids). */
  readonly detail?: string
}

/** The structured environment report `/doctor` renders. */
export interface DoctorReport {
  /** The harness package version. */
  readonly version: string
  /** Whether the settings service is reachable. */
  readonly settings: boolean
  /** Mount status of each capability seam (provider mounts, individual seams where enumerable). */
  readonly seams: readonly SeamStatus[]
  /** Recorded hook issues (last 10 shown) plus the count of ALL valid lines in the diagnostics file. */
  readonly hooks: {
    readonly issues: readonly HookIssue[]
    readonly total: number
    /** The diagnostics file path — absent when no dsh home is resolvable. */
    readonly path?: string
  }
}

/**
 * Render the report as human shell text, one fact per line.
 * @param report - the structured report.
 * @returns the multi-line diagnostic text.
 */
export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    `Version: ${report.version}`,
    `Settings: ${report.settings ? 'reachable' : 'not mounted'}`,
    '',
    'Seams:',
  ]
  for (const seam of report.seams) {
    if (seam.mounted) {
      lines.push(`  ${seam.name}: mounted${seam.detail === undefined ? '' : ` (${seam.detail})`}`)
    } else {
      lines.push(`  ${seam.name}: not mounted`)
    }
  }
  if (report.seams.length === 0) lines.push('  (none)')
  lines.push(...renderHooks(report.hooks))
  return lines.join('\n')
}

/** How many of the newest recorded hook issues the report shows. */
const HOOK_ISSUES_SHOWN = 10

/** Render the trailing hook-diagnostics section of the report. */
function renderHooks(hooks: DoctorReport['hooks']): string[] {
  if (hooks.path === undefined) return ['Hooks: diagnostics unavailable (no dsh home)']
  if (hooks.total === 0) return ['Hooks: no issues recorded']
  const lines = [`Hooks: ${hooks.total} issue(s) recorded (${hooks.path})`]
  for (const issue of hooks.issues.slice(-HOOK_ISSUES_SHOWN)) {
    lines.push(`  [${issue.ts}] ${issue.point} ${issue.kind} — ${issue.detail} (${issue.dialect})`)
  }
  return lines
}
