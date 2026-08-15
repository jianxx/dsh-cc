import { describe, expect, it } from 'vitest'
import { gatesPass, sessionGatePasses, timeGatePasses } from '../src/gates.ts'

const HOUR = 3_600_000
const NOW = 1_760_000_000_000

describe('timeGatePasses', () => {
  it('passes once minHours have elapsed since the last consolidation', () => {
    expect(timeGatePasses(NOW - 24 * HOUR, NOW, 24)).toBe(true)
    expect(timeGatePasses(NOW - 25 * HOUR, NOW, 24)).toBe(true)
  })

  it('fails when insufficient time has elapsed', () => {
    expect(timeGatePasses(NOW - 23 * HOUR, NOW, 24)).toBe(false)
    expect(timeGatePasses(NOW - 60_000, NOW, 24)).toBe(false)
  })

  it('passes with no prior consolidation (lastAt 0)', () => {
    expect(timeGatePasses(0, NOW, 24)).toBe(true)
  })

  it('passes with zero minHours', () => {
    expect(timeGatePasses(NOW, NOW, 0)).toBe(true)
  })
})

describe('sessionGatePasses', () => {
  it('passes at or above the session minimum', () => {
    expect(sessionGatePasses(5, 5)).toBe(true)
    expect(sessionGatePasses(7, 5)).toBe(true)
  })

  it('fails below the session minimum', () => {
    expect(sessionGatePasses(4, 5)).toBe(false)
    expect(sessionGatePasses(0, 5)).toBe(false)
  })
})

describe('gatesPass', () => {
  const base = {
    lastConsolidatedAt: 0,
    now: NOW,
    minHours: 24,
    sessionCount: 10,
    minSessions: 5,
  }

  it('passes only when both gates pass', () => {
    expect(gatesPass({ ...base, lastConsolidatedAt: NOW - 24 * HOUR, sessionCount: 6 })).toBe(true)
    expect(gatesPass({ ...base, lastConsolidatedAt: NOW - 1, sessionCount: 6 })).toBe(false)
    expect(gatesPass({ ...base, lastConsolidatedAt: NOW - 24 * HOUR, sessionCount: 4 })).toBe(false)
    expect(gatesPass({ ...base, lastConsolidatedAt: NOW - 1, sessionCount: 4 })).toBe(false)
  })
})
