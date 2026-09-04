import { describe, expect, it } from 'vitest'
import { redactReport } from '../src/redact.ts'
import type { Check, DoctorReport } from '../src/report.ts'

function reportWith(checks: Check[]): DoctorReport {
  return {
    schemaVersion: 1,
    generatedAt: '2026-09-03T00:00:00.000Z',
    durationMs: 0,
    env: { dshCc: '0.4.0', node: 'v22.19.0', os: 'darwin', arch: 'arm64', cwd: '/repo' },
    checks,
    summary: { ok: 0, warn: 0, fail: checks.length, skip: 0, info: 0 },
  }
}

describe('redactReport', () => {
  it('preserves whitelisted primitive evidence and scrubs secrets in strings', () => {
    const report = reportWith([{
      id: 'test.one',
      group: 'env',
      status: 'fail',
      summary: 'request failed with sk-abc123XYZ and Bearer tok-9',
      detail: 'header ghp_0123456789abcdef leaked',
      fix: 'rotate the xoxb-1111-2222 token',
      evidence: { path: '/repo', count: 3, ok: true, token: 'sk-secretvalue' },
    }])
    const redacted = redactReport(report)
    expect(redacted.checks[0]!.summary).not.toContain('sk-abc123XYZ')
    expect(redacted.checks[0]!.summary).toContain('sk-[redacted]')
    expect(redacted.checks[0]!.summary).toContain('Bearer [redacted]')
    expect(redacted.checks[0]!.detail).toContain('ghp_[redacted]')
    expect(redacted.checks[0]!.fix).toContain('xoxb-[redacted]')
    expect(redacted.checks[0]!.evidence).toEqual({
      path: '/repo', count: 3, ok: true, token: 'sk-[redacted]',
    })
  })
  it('does not mutate the input report', () => {
    const report = reportWith([{
      id: 'test.two', group: 'env', status: 'fail', summary: 'Bearer abc',
    }])
    const copy = JSON.parse(JSON.stringify(report))
    redactReport(report)
    expect(report).toEqual(copy)
  })
  it('leaves clean reports byte-equal in content', () => {
    const report = reportWith([{
      id: 'test.three', group: 'env', status: 'ok', summary: 'fine', evidence: { n: 1 },
    }])
    expect(redactReport(report).checks[0]!.summary).toBe('fine')
  })
})
