import { describe, expect, it } from 'vitest'
import { formatDoctorReport } from '../src/render.ts'
import type { Check, DoctorReport } from '../src/report.ts'

const clockDate = new Date('2026-09-03T00:00:00.000Z')

function report(checks: Check[], verboseEnv = false): DoctorReport {
  return {
    schemaVersion: 1,
    generatedAt: clockDate.toISOString(),
    durationMs: 0,
    env: {
      dshCc: '0.4.0',
      ...(verboseEnv ? { harness: '0.1.0-rc.5' } : {}),
      node: 'v22.23.2',
      os: 'darwin',
      arch: 'arm64',
      cwd: '/repo',
    },
    checks,
    summary: {
      ok: checks.filter(c => c.status === 'ok').length,
      warn: checks.filter(c => c.status === 'warn').length,
      fail: checks.filter(c => c.status === 'fail').length,
      skip: checks.filter(c => c.status === 'skip').length,
      info: checks.filter(c => c.status === 'info').length,
    },
  }
}

describe('formatDoctorReport', () => {
  it('collapses ok rows and expands non-ok rows with detail and fix', () => {
    const text = formatDoctorReport(report([
      { id: 'env.dsh-cc', group: 'env', status: 'ok', summary: 'dsh-cc 0.4.0' },
      { id: 'env.node', group: 'env', status: 'warn', summary: 'effort mismatch', detail: 'effort high not listed', fix: 'pick a listed effort' },
      { id: 'mcp.serena', group: 'mcp', status: 'fail', summary: 'serena: error' },
    ]))
    expect(text).toContain('dsh-cc 0.4.0')
    expect(text).toContain('node v22.23.2')
    expect(text).toContain('os darwin arm64')
    expect(text).toContain('cwd /repo')
    expect(text).toContain('  ok   env.dsh-cc: dsh-cc 0.4.0')
    expect(text).toContain('  warn env.node: effort mismatch')
    expect(text).toContain('    effort high not listed')
    expect(text).toContain('    fix: pick a listed effort')
    expect(text).toContain('  fail mcp.serena: serena: error')
    expect(text).toContain('summary: 1 ok, 1 warn, 1 fail, 0 skip, 0 info')
    // ok rows never expand detail in default mode.
    expect(text).not.toMatch(/ok   env\.dsh-cc[\s\S]*detail/)
  })

  it('prints evidence as a compact k=v list in verbose mode only', () => {
    const checks: Check[] = [{
      id: 'seams.llm', group: 'seams', status: 'ok', summary: 'llm mounted',
      evidence: { providers: 2, host: 'https://api.example.com' },
    }]
    const quiet = formatDoctorReport(report(checks))
    const verbose = formatDoctorReport(report(checks), { verbose: true })
    expect(quiet).not.toContain('evidence:')
    expect(verbose).toContain('  ok   seams.llm: llm mounted')
    expect(verbose).toContain('    evidence: providers=2, host=https://api.example.com')
  })

  it('skips absent groups and keeps a stable group order', () => {
    const text = formatDoctorReport(report([
      { id: 'seams.fs', group: 'seams', status: 'skip', summary: 'fs not mounted' },
      { id: 'session.id', group: 'session', status: 'ok', summary: 's-1' },
    ]))
    const sessionIndex = text.indexOf('session:')
    const seamsIndex = text.indexOf('seams:')
    expect(sessionIndex).toBeGreaterThan(-1)
    expect(seamsIndex).toBeGreaterThan(sessionIndex)
    expect(text).not.toContain('env:')
    expect(text).toContain('  skip seams.fs: fs not mounted')
    expect(text).toContain('summary: 1 ok, 0 warn, 0 fail, 1 skip, 0 info')
  })
})
