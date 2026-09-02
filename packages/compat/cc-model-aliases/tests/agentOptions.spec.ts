/**
 * Unit tests for `toAgentOptions`: dropping undefined route fields so
 * per-field inheritance survives, and collapsing fully-empty routes to
 * "no override" (undefined).
 */
import { describe, expect, it } from 'vitest'
import { toAgentOptions, toOneShotRoute } from '../src/agentOptions.ts'
import type { ResolvedRoute } from '../src/types.ts'

describe('toAgentOptions', () => {
  it('undefined route → undefined (no override)', () => {
    expect(toAgentOptions(undefined)).toBeUndefined()
  })

  it('model-only route → model key only', () => {
    expect(toAgentOptions({ model: 'm' })).toEqual({ model: 'm' })
  })

  it('full route forwards all three keys', () => {
    expect(toAgentOptions({ provider: 'p', model: 'm', reasoningEffort: 'max' })).toEqual({
      provider: 'p',
      model: 'm',
      reasoningEffort: 'max',
    })
  })

  it('explicit-undefined fields are dropped so per-field inheritance survives', () => {
    const route: ResolvedRoute = { model: 'm', provider: undefined }
    expect(toAgentOptions(route)).toEqual({ model: 'm' })
  })

  it('empty route (every field undefined) → undefined', () => {
    expect(toAgentOptions({})).toBeUndefined()
  })
})

describe('toOneShotRoute', () => {
  it('undefined route → undefined even with a parent', () => {
    expect(toOneShotRoute(undefined, { provider: 'p', model: 'main' })).toBeUndefined()
  })

  it('model-only route inherits the parent provider; alias model wins', () => {
    expect(toOneShotRoute({ model: 'm' }, { provider: 'p', model: 'main' })).toEqual({
      provider: 'p',
      model: 'm',
    })
  })

  it('a full route ignores the parent', () => {
    expect(toOneShotRoute({ provider: 'p2', model: 'm2' }, { provider: 'p', model: 'main' })).toEqual({
      provider: 'p2',
      model: 'm2',
    })
  })

  it('model-only route with no parent → undefined (incomplete pair)', () => {
    expect(toOneShotRoute({ model: 'm' })).toBeUndefined()
  })

  it('model-only route with a parent that has no provider → undefined', () => {
    expect(toOneShotRoute({ model: 'm' }, { model: 'main' })).toBeUndefined()
  })

  it('empty strings on either field → undefined', () => {
    expect(toOneShotRoute({ model: '' }, { provider: 'p' })).toBeUndefined()
    expect(toOneShotRoute({ model: 'm' }, { provider: '' })).toBeUndefined()
  })
})
