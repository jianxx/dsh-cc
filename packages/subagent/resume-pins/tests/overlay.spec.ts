/**
 * Pure overlay-builder matrix (plan §4.8): presence semantics (a pinned
 * `null` key is REMOVED — asserted absent, not null), degraded pins set only
 * explicitly-present fields, the gate-evaluated `resume.overlay` tuple wins,
 * and blocked pins throw.
 */
import { describe, expect, it } from 'vitest'
import { PinBlockedError, applyPinOverlay } from '../src/overlay.ts'
import type { ResumePin } from '../src/pin.ts'

function makePin(overrides: Partial<ResumePin> = {}): ResumePin {
  return {
    version: 1,
    childId: 'child-1',
    parentSessionId: 'parent',
    label: 'research',
    mode: 'continuable-background',
    createdAt: '2026-09-04T00:00:00.000Z',
    definition: { kind: 'plain' },
    modelSelector: { raw: 'inherit', via: 'inherit' },
    effective: {
      provider: 'mock',
      model: 'mock',
      reasoningEffort: 'high',
      maxTokens: 5555,
      complete: true,
    },
    toolFilter: { allow: [], deny: [] },
    workspace: { cwd: '/ws', gitDir: '.git', gitCommonDir: '.git', branch: 'main' },
    resume: { state: 'ok' },
    ...overrides,
  }
}

describe('applyPinOverlay — complete pins', () => {
  it('sets every pinned non-null field on a shallow copy', () => {
    const resolved = { provider: 'other', model: 'other', maxTokens: 1 }
    const out = applyPinOverlay(resolved, makePin())
    expect(out).toEqual({ provider: 'mock', model: 'mock', maxTokens: 5555, reasoningEffort: 'high' })
    expect(resolved).toEqual({ provider: 'other', model: 'other', maxTokens: 1 })
  })

  it('REMOVES the key for a pinned null (absence, not assignment)', () => {
    const pin = makePin({ effective: { provider: 'mock', model: 'mock', reasoningEffort: null, maxTokens: null, complete: true } })
    const out = applyPinOverlay({ provider: 'x', model: 'x', maxTokens: 99, reasoningEffort: 'low' }, pin)
    expect(out).toEqual({ provider: 'mock', model: 'mock' })
    expect(Object.prototype.hasOwnProperty.call(out, 'maxTokens')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(out, 'reasoningEffort')).toBe(false)
    expect(out).not.toHaveProperty('maxTokens')
    expect(out).not.toHaveProperty('reasoningEffort')
  })

  it('removes a pinned-null key that was absent from the input too', () => {
    const pin = makePin({ effective: { provider: 'mock', model: 'mock', reasoningEffort: null, maxTokens: 42, complete: true } })
    const out = applyPinOverlay({ provider: 'x', model: 'x' }, pin)
    expect(out).not.toHaveProperty('reasoningEffort')
    expect(out).toEqual({ provider: 'mock', model: 'mock', maxTokens: 42 })
  })
})

describe('applyPinOverlay — degraded pins (complete:false)', () => {
  it('sets only the explicitly-present pinned fields, never touching absent ones', () => {
    const pin = makePin({ effective: { provider: 'mock', model: 'mock', reasoningEffort: 'high', maxTokens: null, complete: false } })
    const out = applyPinOverlay({ provider: 'x', model: 'x', reasoningEffort: 'low' }, pin)
    expect(out).toEqual({ provider: 'mock', model: 'mock', reasoningEffort: 'high' })
    expect(out).not.toHaveProperty('maxTokens')
  })
})

describe('applyPinOverlay — gate-evaluated route-current overlay', () => {
  it('the resume.overlay tuple wins over the pinned effective tuple', () => {
    const pin = makePin({
      resume: {
        state: 'ok',
        overlay: { provider: 'mock2', model: 'mock2', reasoningEffort: null, maxTokens: 999 },
      },
    })
    const out = applyPinOverlay({ provider: 'mock', model: 'mock', reasoningEffort: 'high', maxTokens: 5555 }, pin)
    expect(out).toEqual({ provider: 'mock2', model: 'mock2', maxTokens: 999 })
    expect(out).not.toHaveProperty('reasoningEffort')
  })
})

describe('applyPinOverlay — blocked pins', () => {
  it('throws PinBlockedError naming the stored reason (defense-in-depth)', () => {
    const pin = makePin({ resume: { state: 'blocked', reason: '[WORKSPACE_MISSING] gone' } })
    expect(() => applyPinOverlay({ provider: 'x', model: 'x' }, pin)).toThrow(PinBlockedError)
    expect(() => applyPinOverlay({ provider: 'x', model: 'x' }, pin)).toThrow(/WORKSPACE_MISSING/)
  })
})
