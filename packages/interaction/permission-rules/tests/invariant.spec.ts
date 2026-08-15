import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as permissionRulesInvariant from '@jianxx/dsh-cc-permission-rules/invariant'
import { name, inject } from '@jianxx/dsh-cc-permission-rules/invariant'

describe('permission-rules invariant companion', () => {
  it('declares the loader-safe companion exports', () => {
    expect(name).toBe('cc-permission-rules-invariant')
    expect(inject).toContain('invariants')
    expect('default' in permissionRulesInvariant).toBe(false)
  })

  it('registers and disposes through the invariant service', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    const dispose = await permissionRulesInvariant.apply(ctx)
    expect(typeof dispose).toBe('function')
    dispose()
  })
})
