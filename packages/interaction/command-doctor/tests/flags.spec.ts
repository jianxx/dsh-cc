import { describe, expect, it } from 'vitest'
import { DOCTOR_USAGE, parseDoctorFlags } from '../src/flags.ts'

describe('parseDoctorFlags', () => {
  it('parses empty input as a default run', () => {
    expect(parseDoctorFlags('')).toEqual({ kind: 'run', verbose: false, json: false })
    expect(parseDoctorFlags('   ')).toEqual({ kind: 'run', verbose: false, json: false })
  })
  it('parses --verbose and --json independently', () => {
    expect(parseDoctorFlags('--verbose')).toEqual({ kind: 'run', verbose: true, json: false })
    expect(parseDoctorFlags('--json')).toEqual({ kind: 'run', verbose: false, json: true })
  })
  it('parses both flags order-independently', () => {
    expect(parseDoctorFlags('--verbose --json')).toEqual({ kind: 'run', verbose: true, json: true })
    expect(parseDoctorFlags(' --json   --verbose ')).toEqual({ kind: 'run', verbose: true, json: true })
  })
  it('yields usage for unknown tokens', () => {
    expect(parseDoctorFlags('--wat')).toEqual({ kind: 'usage' })
    expect(parseDoctorFlags('--verbose extra')).toEqual({ kind: 'usage' })
  })
  it('renders the exact usage text', () => {
    expect(DOCTOR_USAGE).toBe([
      'Usage:',
      '  /doctor              session health report',
      '  /doctor --verbose    include slow probes and evidence',
      '  /doctor --json       write $DSH_HOME/tui/doctor-report.json (overwrites)',
    ].join('\n'))
  })
})
