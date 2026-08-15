import { describe, expect, it } from 'vitest'
import {
  estimateFrontmatterTokens,
  extractInlineShell,
  renderSkillBody,
  substituteArguments,
  substitutePlaceholders,
} from '../src/render.ts'

describe('substituteArguments', () => {
  it('replaces $ARGUMENTS, indexed, and shorthand forms', () => {
    const out = substituteArguments(
      'run "$ARGUMENTS" then $ARGUMENTS[0] then $1',
      'foo "hello world"',
      ['query', 'mode'],
    )
    expect(out).toBe('run "foo "hello world"" then foo then hello world')
  })

  it('replaces named arguments by frontmatter order', () => {
    const out = substituteArguments('query $query with mode $mode', 'alpha beta', ['query', 'mode'])
    expect(out).toBe('query alpha with mode beta')
  })

  it('leaves content unchanged when no arguments are provided', () => {
    expect(substituteArguments('run $ARGUMENTS', undefined, ['a'])).toBe('run $ARGUMENTS')
  })

  it('appends ARGUMENTS when no placeholder matched but args were provided', () => {
    const out = substituteArguments('no placeholders here', 'the args', ['a'])
    expect(out).toContain('ARGUMENTS: the args')
  })

  it('leaves undeclared $names literal and replaces declared ones', () => {
    const out = substituteArguments('a=$undeclared b=$ok', 'one', ['ok'])
    expect(out).toBe('a=$undeclared b=one')
  })
})

describe('substitutePlaceholders', () => {
  it('replaces skill dir and session id', () => {
    const out = substitutePlaceholders('dir ${CLAUDE_SKILL_DIR} id ${CLAUDE_SESSION_ID}', '/a/b', 'sess-1')
    expect(out).toBe('dir /a/b id sess-1')
  })
})

describe('extractInlineShell', () => {
  it('splits content on inline shell segments', () => {
    const parts = extractInlineShell('before !`echo hi` after')
    expect(parts.map(p => p.kind)).toEqual(['text', 'shell', 'text'])
    expect(parts[1]).toMatchObject({ kind: 'shell', command: 'echo hi' })
  })

  it('returns a single text segment when no inline shell is present', () => {
    const parts = extractInlineShell('just text')
    expect(parts).toHaveLength(1)
    expect(parts[0]?.kind).toBe('text')
  })
})

describe('estimateFrontmatterTokens', () => {
  it('counts name, description, and whenToUse only', () => {
    const tokens = estimateFrontmatterTokens('my-skill', 'A test skill', 'When asked')
    const shorter = estimateFrontmatterTokens('s', 'x', undefined)
    expect(tokens).toBeGreaterThan(shorter)
  })
})

describe('renderSkillBody', () => {
  it('applies argument and placeholder substitution', () => {
    const out = renderSkillBody(
      'hello $ARGUMENTS at ${CLAUDE_SKILL_DIR}',
      { args: 'world', skillDir: '/s', sessionId: 'id', allowInlineShell: false, argumentNames: [] },
    )
    expect(out.text).toContain('hello world at /s')
  })
})
