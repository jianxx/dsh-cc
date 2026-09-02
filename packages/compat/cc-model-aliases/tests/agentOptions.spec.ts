/**
 * Unit tests for `toAgentOptions`: dropping undefined route fields so
 * per-field inheritance survives, and collapsing fully-empty routes to
 * "no override" (undefined).
 */
import { describe, expect, it } from 'vitest'
import { toAgentOptions } from '../src/agentOptions.ts'
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
