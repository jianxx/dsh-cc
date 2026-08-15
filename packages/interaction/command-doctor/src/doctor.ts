/**
 * Pure `/doctor` report rendering: gathers a structured environment report and
 * renders it as human shell text. No cordis imports, so the formatter is
 * unit-testable in isolation from service mounting.
 * @module @jianxx/dsh-cc-command-doctor/doctor
 */

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
  return lines.join('\n')
}
