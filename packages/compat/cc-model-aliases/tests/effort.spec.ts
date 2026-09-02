/**
 * Tests for `overlayStampedEffort`: apply an alias-stamped reasoning effort
 * onto a resolved `LlmCallConfig` inside the host `agent/request` waterfall.
 * The overlay runs AFTER `next()` so it beats fork-seed header restoration,
 * and it must return a shallow copy — `buildRequest` deep-freezes the seed
 * config, so an in-place assignment throws or is invisible.
 */
import { describe, expect, it } from 'vitest'
import { overlayStampedEffort, stampedEffortOf } from '../src/effort.ts'

/** Minimal structural LlmCallConfig shape the helper reads/writes. */
function config(parts: Record<string, unknown>): Record<string, unknown> {
  return { provider: 'orchestrix', model: 'glm-5.3', ...parts }
}

describe('overlayStampedEffort', () => {
  it('a stamped effort overwrites the seed effort', () => {
    const resolved = config({ reasoningEffort: 'high' })
    expect(overlayStampedEffort(resolved as never, 'max')).toEqual({
      provider: 'orchestrix',
      model: 'glm-5.3',
      reasoningEffort: 'max',
    })
  })

  it('a stamped effort lands on a seed that had none', () => {
    const resolved = config({})
    expect(overlayStampedEffort(resolved as never, 'xhigh')).toEqual({
      provider: 'orchestrix',
      model: 'glm-5.3',
      reasoningEffort: 'xhigh',
    })
  })

  it('an absent stamp leaves the resolved config identity-untouched', () => {
    const resolved = config({ reasoningEffort: 'high' })
    expect(overlayStampedEffort(resolved as never, undefined)).toBe(resolved)
    expect(overlayStampedEffort(resolved as never, undefined)).toEqual(config({ reasoningEffort: 'high' }))
  })

  it('a blank stamp (empty string) leaves the resolved config untouched', () => {
    const resolved = config({})
    expect(overlayStampedEffort(resolved as never, '')).toBe(resolved)
  })

  it('a non-string stamp leaves the resolved config untouched', () => {
    const resolved = config({})
    expect(overlayStampedEffort(resolved as never, 42 as never)).toBe(resolved)
  })

  it('does not mutate the input config (shallow copy on overlay)', () => {
    const resolved = Object.freeze(config({ reasoningEffort: 'high' }))
    const overlaid = overlayStampedEffort(resolved as never, 'max')
    expect(overlaid).not.toBe(resolved)
    expect(overlaid).toEqual({
      provider: 'orchestrix',
      model: 'glm-5.3',
      reasoningEffort: 'max',
    })
    expect(resolved).toEqual(config({ reasoningEffort: 'high' }))
  })
})

describe('stampedEffortOf', () => {
  it('reads a non-empty string stamp off agent options', () => {
    expect(stampedEffortOf({ provider: 'mock', model: 'm', reasoningEffort: 'max' })).toBe('max')
  })

  it('returns undefined for absent, blank, or non-string stamps', () => {
    expect(stampedEffortOf({ provider: 'mock', model: 'm' })).toBeUndefined()
    expect(stampedEffortOf({ reasoningEffort: '' })).toBeUndefined()
    expect(stampedEffortOf({ reasoningEffort: 3 })).toBeUndefined()
    expect(stampedEffortOf(undefined)).toBeUndefined()
    expect(stampedEffortOf(null)).toBeUndefined()
  })
})
