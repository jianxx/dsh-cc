import { describe, expect, it } from 'vitest'
import { normalizeModel, resolveToolRestriction } from '@jianxx/dsh-cc-claude-code-agents'

describe('resolveToolRestriction', () => {
  it('returns undefined when neither tools nor disallowedTools is declared', () => {
    expect(resolveToolRestriction(undefined, undefined)).toBeUndefined()
  })

  it('maps a tools allow-list to an allow restriction', () => {
    expect(resolveToolRestriction(['Read', 'Write'], undefined)).toEqual({ allow: ['Read', 'Write'] })
  })

  it('maps a disallowedTools deny-list to a deny restriction', () => {
    expect(resolveToolRestriction(undefined, ['Write'])).toEqual({ deny: ['Write'] })
  })

  it('places a name in both lists into allow and deny (deny wins by intersection)', () => {
    // A name in `tools` AND `disallowedTools` is denied: restrictions intersect,
    // so deny removes it even from the allow list.
    expect(resolveToolRestriction(['Read', 'Write'], ['Write']))
      .toEqual({ allow: ['Read', 'Write'], deny: ['Write'] })
  })

  it('throws when tools holds a non-string element', () => {
    expect(() => resolveToolRestriction(['Read', 42 as unknown as string], undefined))
      .toThrow(/tools must name tools as strings/)
  })

  it('throws when disallowedTools holds a non-string element', () => {
    expect(() => resolveToolRestriction(undefined, [null as unknown as string]))
      .toThrow(/disallowedTools must name tools as strings/)
  })
})

describe('normalizeModel', () => {
  it('returns undefined when model is absent', () => {
    expect(normalizeModel(undefined)).toBeUndefined()
  })

  it('passes through a concrete model name trimmed', () => {
    expect(normalizeModel('  deepseek-chat ')).toBe('deepseek-chat')
  })

  it('normalizes the inherit sentinel case-insensitively', () => {
    expect(normalizeModel('inherit')).toBe('inherit')
    expect(normalizeModel('Inherit')).toBe('inherit')
    expect(normalizeModel('INHERIT')).toBe('inherit')
  })

  it('throws when model is not a non-empty string', () => {
    expect(() => normalizeModel(123)).toThrow(/model must be a non-empty string/)
    expect(() => normalizeModel('   ')).toThrow(/model must be a non-empty string/)
  })
})
