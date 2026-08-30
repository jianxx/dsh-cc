import { describe, expect, it } from 'vitest'
import {
  evaluateInvariants,
  foldRates,
  foldReport,
  hitRate,
  renderReportTable,
  thresholdsFromEnv,
} from '../src/index.ts'

/**
 * Pure-layer contract for the cache-hit-rate benchmark (Item 6): the rate
 * definition, the per-request/session folds, the shape+cache invariant
 * evaluation, the report fold, the console table, and the env threshold knob.
 * TDD red layer — these pin the API before the runner/bin exist.
 */

/** Rate definition: cacheRead / (input + cacheRead); undefined when unknown. */
describe('hitRate', () => {
  it('divides cacheRead by input + cacheRead', () => {
    expect(hitRate({ inputTokens: 30, cacheReadTokens: 70 })).toBe(0.7)
    expect(hitRate({ inputTokens: 0, cacheReadTokens: 5 })).toBe(1)
    expect(hitRate({ inputTokens: 5, cacheReadTokens: 0 })).toBe(0)
  })

  it('is undefined when the cache bucket is absent (provider without caching)', () => {
    expect(hitRate({ inputTokens: 10 })).toBeUndefined()
  })

  it('is undefined when the denominator is zero', () => {
    expect(hitRate({ inputTokens: 0, cacheReadTokens: 0 })).toBeUndefined()
  })
})

const ROW = (index: number, turn: number, input: number, cached: number) => ({
  index,
  turn,
  inputTokens: input,
  outputTokens: 1,
  ...(cached > 0 ? { cacheReadTokens: cached } : {}),
})

describe('foldRates', () => {
  it('folds per-request rates and both session aggregates', () => {
    const rows = [ROW(0, 1, 100, 0), ROW(1, 1, 10, 90), ROW(2, 2, 10, 190)]
    const folded = foldRates(rows)
    // Request 0 reported no cache bucket at all → undefined, not zero.
    expect(folded.perRequest).toEqual([undefined, 0.9, 190 / 200])
    // All requests: (0+90+190)/(100+10+10 + 0+90+190)
    expect(folded.session).toBeCloseTo(280 / 400, 12)
    // Excluding the first request (the L1 session gate).
    expect(folded.sessionExcludingFirst).toBeCloseTo(280 / 300, 12)
  })

  it('yields undefined session rate when no request reports a cache bucket', () => {
    const folded = foldRates([ROW(0, 1, 10, 0), ROW(1, 2, 10, 0)])
    expect(folded.session).toBeUndefined()
    expect(folded.sessionExcludingFirst).toBeUndefined()
  })

  it('yields undefined sessionExcludingFirst for a single request', () => {
    expect(foldRates([ROW(0, 1, 10, 5)]).sessionExcludingFirst).toBeUndefined()
  })
})

const thresholds = { perRequestMinRate: 0.3, sessionMinRate: 0.6 }

describe('evaluateInvariants', () => {
  it('passes a healthy with-key shape without failures', () => {
    const failures = evaluateInvariants({
      rows: [ROW(0, 1, 100, 0), ROW(1, 1, 10, 90), ROW(2, 2, 10, 190)],
      thresholds,
      minRequests: 3,
      cacheHitsExpected: true,
      firstTurnToolCalls: 1,
    })
    expect(failures).toEqual([])
  })

  it('fails the request-count lower bound (never an upper bound)', () => {
    const failures = evaluateInvariants({
      rows: [ROW(0, 1, 100, 0)],
      thresholds,
      minRequests: 3,
      cacheHitsExpected: true,
      firstTurnToolCalls: 1,
    })
    expect(failures.some(line => line.includes('requests'))).toBe(true)
  })

  it('fails when a request after the first reports no cached tokens', () => {
    const failures = evaluateInvariants({
      rows: [ROW(0, 1, 100, 0), ROW(1, 1, 10, 0)],
      thresholds,
      minRequests: 2,
      cacheHitsExpected: true,
      firstTurnToolCalls: 1,
    })
    expect(failures.some(line => line.includes('request 2'))).toBe(true)
  })

  it('fails the per-request soft floor and the session floor', () => {
    const failures = evaluateInvariants({
      rows: [ROW(0, 1, 100, 0), ROW(1, 2, 95, 5), ROW(2, 3, 95, 5)],
      thresholds,
      minRequests: 3,
      cacheHitsExpected: true,
      firstTurnToolCalls: 1,
    })
    // per-request: 5/100 = 0.05 < 0.3 on requests 2 and 3.
    expect(failures.filter(line => line.includes('below the per-request floor')).length).toBe(2)
    // session: 10/(190+10) = 0.05 < 0.6.
    expect(failures.some(line => line.includes('session'))).toBe(true)
  })

  it('skips cache criteria when cache hits are not expected (keyless runs)', () => {
    const failures = evaluateInvariants({
      rows: [ROW(0, 1, 3, 0), ROW(1, 1, 3, 0)],
      thresholds,
      minRequests: 2,
      cacheHitsExpected: false,
      firstTurnToolCalls: 1,
    })
    expect(failures).toEqual([])
  })

  it('fails for requests that reported no usage at all', () => {
    const failures = evaluateInvariants({
      rows: [ROW(0, 1, 3, 0), { index: 1, turn: 1, inputTokens: 0, outputTokens: 0 }],
      thresholds,
      minRequests: 2,
      cacheHitsExpected: false,
      firstTurnToolCalls: 1,
      rowsWithoutUsage: [2],
    })
    expect(failures.some(line => line.includes('no usage'))).toBe(true)
  })

  it('fails when the first turn was required to call a tool but did not', () => {
    const failures = evaluateInvariants({
      rows: [ROW(0, 1, 3, 0), ROW(1, 2, 3, 0)],
      thresholds,
      minRequests: 2,
      cacheHitsExpected: false,
      firstTurnToolCalls: 0,
    })
    expect(failures.some(line => line.includes('tool'))).toBe(true)
  })

  it('does not require a tool call when the first turn does not demand one', () => {
    const failures = evaluateInvariants({
      rows: [ROW(0, 1, 3, 0), ROW(1, 2, 3, 0)],
      thresholds,
      minRequests: 2,
      cacheHitsExpected: false,
      firstTurnToolCalls: 0,
      firstTurnExpectsToolCall: false,
    })
    expect(failures).toEqual([])
  })
})

describe('foldReport', () => {
  it('builds a schema-valid report with verdict pass on a healthy run', () => {
    const report = foldReport({
      trajectoryId: 'standard',
      sessionId: 'cache-trajectory-standard',
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      rows: [ROW(0, 1, 100, 0), ROW(1, 1, 10, 90), ROW(2, 2, 10, 190)],
      thresholds,
      minRequests: 3,
      cacheHitsExpected: true,
      firstTurnToolCalls: 1,
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
    })
    expect(report.schemaVersion).toBe(1)
    expect(report.verdict).toBe('pass')
    expect(report.failures).toEqual([])
    expect(report.requests).toHaveLength(3)
    expect(report.requests[1]).toMatchObject({ index: 1, turn: 1, cacheReadTokens: 90, hitRate: 0.9 })
    expect(report.totals.requests).toBe(3)
    expect(report.totals.hitRateExcludingFirst).toBeCloseTo(280 / 300, 12)
    expect(report.thresholds).toEqual({ ...thresholds, minRequests: 3, cacheHitsExpected: true })
  })

  it('collects failures and flips the verdict to fail', () => {
    const report = foldReport({
      trajectoryId: 'standard',
      sessionId: 's',
      provider: 'p',
      model: 'm',
      rows: [ROW(0, 1, 100, 0), ROW(1, 2, 10, 0)],
      thresholds,
      minRequests: 2,
      cacheHitsExpected: true,
      firstTurnToolCalls: 0,
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
    })
    expect(report.verdict).toBe('fail')
    expect(report.failures.length).toBeGreaterThan(0)
  })
})

describe('renderReportTable', () => {
  it('renders one row per request plus session totals and the verdict', () => {
    const report = foldReport({
      trajectoryId: 'standard',
      sessionId: 's',
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      rows: [ROW(0, 1, 100, 0), ROW(1, 1, 10, 90)],
      thresholds,
      minRequests: 2,
      cacheHitsExpected: true,
      firstTurnToolCalls: 1,
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
    })
    const table = renderReportTable(report)
    expect(table).toContain('standard')
    expect(table).toContain('deepseek-v4-flash')
    expect(table).toContain('#1')
    expect(table).toContain('90.0%')
    expect(table).toContain('PASS')
    // Requests without a cache bucket render as an explicit dash, not NaN.
    expect(table).toMatch(/#0 .*--/)
  })

  it('renders FAIL with the failure lines', () => {
    const report = foldReport({
      trajectoryId: 'standard',
      sessionId: 's',
      provider: 'p',
      model: 'm',
      rows: [ROW(0, 1, 100, 0), ROW(1, 2, 10, 0)],
      thresholds,
      minRequests: 2,
      cacheHitsExpected: true,
      firstTurnToolCalls: 0,
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
    })
    const table = renderReportTable(report)
    expect(table).toContain('FAIL')
    for (const failure of report.failures) expect(table).toContain(failure)
  })
})

describe('thresholdsFromEnv', () => {
  const base = { perRequestMinRate: 0.3, sessionMinRate: 0.6 }

  it('returns the base thresholds when the env knob is unset', () => {
    expect(thresholdsFromEnv(base, undefined)).toEqual(base)
    expect(thresholdsFromEnv(base, '')).toEqual(base)
  })

  it('overrides both floors when the env knob parses in [0,1]', () => {
    expect(thresholdsFromEnv(base, '0.5')).toEqual({ perRequestMinRate: 0.5, sessionMinRate: 0.5 })
    expect(thresholdsFromEnv(base, '0')).toEqual({ perRequestMinRate: 0, sessionMinRate: 0 })
  })

  it('ignores values outside [0,1] or non-numeric garbage', () => {
    expect(thresholdsFromEnv(base, '1.5')).toEqual(base)
    expect(thresholdsFromEnv(base, '-0.1')).toEqual(base)
    expect(thresholdsFromEnv(base, 'loose')).toEqual(base)
  })
})
