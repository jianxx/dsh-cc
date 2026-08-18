/**
 * Unit tests for the cc-model-aliases resolver and merge semantics: lookup
 * order (settings → config → builtin fallback), inherit, case-insensitive key
 * matching, null deletion, entry-shallow merge (no field blending), builtin
 * fallback, and literal passthrough with warn.
 */
import { describe, expect, it } from 'vitest'
import { createModelResolver, mergeAliasMaps, BUILTIN_ALIASES } from '../src/resolver.ts'
import { ConfigAliasesSchema, SettingsAliasesSchema } from '../src/schema.ts'
import type { AliasTarget } from '../src/types.ts'
import type { ResolvedRoute } from '../src/types.ts'

/** Build a resolver whose alias source is a fixed (call-time) map. */
function resolverFor(
  config: Record<string, unknown> | undefined,
  settings: Record<string, unknown> | null | undefined,
): { resolve: (model: string | undefined) => ResolvedRoute | undefined; warns: string[] } {
  const warns: string[] = []
  const resolve = createModelResolver(
    () => mergeAliasMaps(config as never, settings as never),
    { warn: message => warns.push(message) },
  )
  return { resolve, warns }
}

describe('mergeAliasMaps', () => {
  it('folds alias keys to lowercase across both layers', () => {
    const merged = mergeAliasMaps(
      { Sonnet: 'sf' },
      { sONNET: { provider: 'p', model: 'm' } },
    )
    const folded = Object.fromEntries(merged)
    expect(folded).toEqual({ sonnet: { provider: 'p', model: 'm' } })
  })

  it('settings entry replaces config entry wholesale, never field-merging', () => {
    const merged = mergeAliasMaps(
      { opus: { provider: 'A', model: 'X' } },
      { opus: { model: 'Y' } },
    )
    // The settings `{ provider: undefined, model: Y }`-shape object wins whole;
    // provider must NOT survive from config as a blended `{ provider: A, model: Y }`.
    expect(Object.fromEntries(merged)['opus']).toEqual({ model: 'Y' })
  })

  it('settings null deletes a configured config entry', () => {
    const merged = mergeAliasMaps(
      { sonnet: 'sf', opus: { provider: 'p', model: 'm' } },
      { sonnet: null },
    )
    const folded = Object.fromEntries(merged)
    expect(folded).toEqual({ opus: { provider: 'p', model: 'm' } })
  })

  it('config-only aliases survive when settings provided no competing key', () => {
    const merged = mergeAliasMaps({ turbo: 't' }, { sonnet: 's' })
    const folded = Object.fromEntries(merged)
    expect(folded).toEqual({ turbo: 't', sonnet: 's' })
  })

  it('undefined layers yield an empty map', () => {
    expect(mergeAliasMaps(undefined, undefined).size).toBe(0)
  })
})

describe('createModelResolver lookup order', () => {
  it('settings alias wins over config alias', () => {
    const { resolve } = resolverFor({ sonnet: 'cfg' }, { sonnet: 'set' })
    expect(resolve('sonnet')).toEqual({ model: 'set' })
  })

  it('config alias is used when settings have none', () => {
    const { resolve } = resolverFor({ sonnet: 'cfg' }, {})
    expect(resolve('sonnet')).toEqual({ model: 'cfg' })
  })

  it('alias key matching is case-insensitive', () => {
    const { resolve } = resolverFor({ Sonnet: 'sf' }, {})
    expect(resolve('SONNET')).toEqual({ model: 'sf' })
    expect(resolve('sonnet')).toEqual({ model: 'sf' })
  })

  it('string-form alias resolves to model-only route', () => {
    const { resolve } = resolverFor({ opus: 'deepseek-pro' }, {})
    expect(resolve('opus')).toEqual({ model: 'deepseek-pro' })
  })

  it('object-form alias resolves to explicit provider+model route', () => {
    const { resolve } = resolverFor({}, { opus: { provider: 'anthropic', model: 'claude-opus' } })
    expect(resolve('opus')).toEqual({ provider: 'anthropic', model: 'claude-opus' })
  })

  it('live settings read is fresh on every invocation (liveness, not a snapshot)', () => {
    let settings: Record<string, string> = { sonnet: 'v1' }
    const warns: string[] = []
    const resolve = createModelResolver(
      () => mergeAliasMaps({}, settings),
      { warn: m => warns.push(m) },
    )
    expect(resolve('sonnet')).toEqual({ model: 'v1' })
    settings = { sonnet: 'v2' }
    expect(resolve('sonnet')).toEqual({ model: 'v2' })
    expect(warns).toEqual([])
  })
})

describe('createModelResolver inherit / builtin fallback / passthrough', () => {
  it('undefined model resolves to undefined (no override)', () => {
    const { resolve } = resolverFor({}, {})
    expect(resolve(undefined)).toBeUndefined()
    expect(resolve('  ')).toBeUndefined()
  })

  it('inherit resolves to undefined (case-insensitive), fixing the pass-through bug', () => {
    const { resolve } = resolverFor({}, {})
    expect(resolve('inherit')).toBeUndefined()
    expect(resolve('Inherit')).toBeUndefined()
    expect(resolve('INHERIT')).toBeUndefined()
  })

  it('unconfigured builtin alias falls back to inherit (undefined)', () => {
    const { resolve } = resolverFor({}, {})
    for (const alias of ['fable', 'opus', 'sonnet', 'haiku']) {
      expect(resolve(alias)).toBeUndefined()
    }
    // Case-insensitive builtin match.
    expect(resolve('OPUS')).toBeUndefined()
  })

  it('a null-deleted builtin alias still falls back to inherit (no error state)', () => {
    // settings deletes a config entry for a builtin; the map has no entry, so
    // the builtin fallback (inherit) applies.
    const { resolve } = resolverFor({ opus: 'cfg' }, { opus: null })
    expect(resolve('opus')).toBeUndefined()
  })

  it('custom unconfigured alias passes through verbatim and warns', () => {
    const { resolve, warns } = resolverFor({}, {})
    expect(resolve('turbo')).toEqual({ model: 'turbo' })
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatch(/turbo/)
  })

  it('literal model id with punctuation passes through verbatim without warning', () => {
    const { resolve, warns } = resolverFor({}, {})
    expect(resolve('deepseek-chat')).toEqual({ model: 'deepseek-chat' })
    expect(warns).toEqual([])
  })

  it('BUILTIN_ALIASES lists the four builtin names', () => {
    expect([...BUILTIN_ALIASES].sort()).toEqual(['fable', 'haiku', 'opus', 'sonnet'])
  })
})

describe('schema and defensive robustness', () => {
  it('schemas accept the documented shapes', () => {
    const cfg = (v: unknown): Record<string, AliasTarget> => ConfigAliasesSchema(v as never)
    const set = (v: unknown): Record<string, AliasTarget | null> => SettingsAliasesSchema(v as never)
    expect(() => cfg({ opus: { provider: 'p', model: 'm' } })).not.toThrow()
    expect(() => cfg({ sonnet: 's' })).not.toThrow()
    expect(() => set({ sonnet: null })).not.toThrow()
    expect(() => set({ opus: { provider: 'p', model: 'm' } })).not.toThrow()
    // A blank string target is rejected (union string branch min(1) fails).
    expect(() => cfg({ sonnet: '' })).toThrow()
  })

  it('config null is treated as absent (schemastery dicts are lenient at validation)', () => {
    const merged = mergeAliasMaps({ opus: null } as never, {})
    expect(merged.has('opus')).toBe(false)
    const { resolve } = resolverFor({ opus: null } as never, {})
    expect(resolve('opus')).toBeUndefined()
  })
})
