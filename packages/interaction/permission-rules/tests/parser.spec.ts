import { describe, expect, it } from 'vitest'
import {
  escapeRuleContent,
  unescapeRuleContent,
  parseRuleString,
  parseRule,
  matchContent,
  contentMatches,
  wildcardMatches,
  ruleString,
} from '../src/parser.ts'

describe('escapeRuleContent / unescapeRuleContent', () => {
  it('escapes parentheses and unescapes them back', () => {
    expect(unescapeRuleContent(escapeRuleContent('psycopg2.connect()'))).toBe('psycopg2.connect()')
    expect(unescapeRuleContent(escapeRuleContent('echo "a(b)\\nc"'))).toBe('echo "a(b)\\nc"')
  })

  it('unescapes a literal escaped-paren sequence', () => {
    // "psycopg2.connect\(\)" unescapes to "psycopg2.connect()".
    expect(unescapeRuleContent(`psycopg2.connect${escapeRuleContent('()')}`)).toBe('psycopg2.connect()')
  })

  it('round-trips a backslash inside content', () => {
    const content = 'echo "test\\\\nvalue"'
    expect(unescapeRuleContent(escapeRuleContent(content))).toBe(content)
  })
})

describe('parseRuleString', () => {
  it('parses a bare tool name', () => {
    expect(parseRuleString('Bash')).toEqual({ toolName: 'Bash' })
  })

  it('parses content and derives a prefix matcher', () => {
    const parsed = parseRuleString('Bash(npm install)')
    expect(parsed.toolName).toBe('Bash')
    expect(parsed.content).toBe('npm install')
    expect(parsed.matcher).toEqual({ kind: 'prefix', prefix: 'npm install' })
  })

  it('parses the legacy :* prefix form', () => {
    const parsed = parseRuleString('Bash(npm publish:*)')
    expect(parsed.content).toBe('npm publish:*')
    expect(parsed.matcher).toEqual({ kind: 'prefix', prefix: 'npm publish:' })
  })

  it('parses a wildcard content', () => {
    const parsed = parseRuleString('Edit(foo/*.json)')
    expect(parsed.content).toBe('foo/*.json')
    expect(parsed.matcher).toEqual({ kind: 'wildcard', pattern: 'foo/*.json' })
  })

  it('unescapes parens inside content', () => {
    const rule = `Bash(python -c "print${escapeRuleContent('(1)')}")`
    const parsed = parseRuleString(rule)
    expect(parsed.toolName).toBe('Bash')
    expect(parsed.content).toBe('python -c "print(1)"')
  })

  it('treats empty or single-wildcard content as a whole-tool rule', () => {
    expect(parseRuleString('Bash()')).toEqual({ toolName: 'Bash' })
    expect(parseRuleString('Bash(*)')).toEqual({ toolName: 'Bash' })
  })

  it('throws on empty input', () => {
    expect(() => parseRuleString('')).toThrow(TypeError)
    expect(() => parseRuleString('   ')).toThrow(TypeError)
  })

  it('throws on an unclosed parenthesis', () => {
    expect(() => parseRuleString('Bash(npm')).toThrow(/no unescaped/)
  })

  it('throws on trailing text after the closing paren', () => {
    expect(() => parseRuleString('Bash(ls) extra')).toThrow(/content after its closing/)
  })

  it('throws on content with no tool name', () => {
    expect(() => parseRuleString('(foo)')).toThrow(/no tool name/)
  })
})

describe('matchContent', () => {
  it('returns undefined for empty content (whole-tool)', () => {
    expect(matchContent('')).toBeUndefined()
  })

  it('classifies :* as a prefix on the stem', () => {
    expect(matchContent('npm publish:')).toEqual({ kind: 'prefix', prefix: 'npm publish:' })
  })

  it('classifies a plain string as a prefix matcher', () => {
    expect(matchContent('npm install')).toEqual({ kind: 'prefix', prefix: 'npm install' })
  })

  it('classifies unescaped wildcard as a wildcard pattern', () => {
    expect(matchContent('foo/*.json')).toEqual({ kind: 'wildcard', pattern: 'foo/*.json' })
  })
})

describe('contentMatches', () => {
  it('prefix matches a command starting with the prefix', () => {
    const matcher = { kind: 'prefix' as const, prefix: 'npm install' }
    expect(contentMatches(matcher, 'npm install --save x')).toBe(true)
    expect(contentMatches(matcher, 'npm publish')).toBe(false)
  })

  it('prefix matching honors the legacy :* stem', () => {
    const matcher = { kind: 'prefix' as const, prefix: 'npm publish:' }
    expect(contentMatches(matcher, 'npm publish:foo')).toBe(true)
    expect(contentMatches(matcher, 'npm publish')).toBe(false)
  })
})

describe('wildcardMatches', () => {
  it('matches a leading wildcard', () => {
    expect(wildcardMatches('*/package.json', 'foo/package.json')).toBe(true)
    expect(wildcardMatches('*/package.json', 'package.json')).toBe(false)
  })

  it('matches a trailing wildcard', () => {
    expect(wildcardMatches('src/*', 'src/index.ts')).toBe(true)
    expect(wildcardMatches('src/*', 'lib/index.ts')).toBe(false)
  })

  it('matches a middle wildcard', () => {
    expect(wildcardMatches('foo/*.json', 'foo/a.json')).toBe(true)
    expect(wildcardMatches('foo/*.json', 'bar/a.json')).toBe(false)
  })

  it('matches a literal backslash-star with \\*', () => {
    expect(wildcardMatches('a\\*b', 'a*b')).toBe(true)
    expect(wildcardMatches('a\\*b', 'axb')).toBe(false)
  })

  it('matches a literal backslash with \\\\', () => {
    expect(wildcardMatches('a\\\\b', 'a\\b')).toBe(true)
  })

  it('matches empty wildcard runs', () => {
    expect(wildcardMatches('a*b', 'ab')).toBe(true)
    expect(wildcardMatches('*', 'anything')).toBe(true)
  })
})

describe('parseRule', () => {
  it('produces a source-labelled content rule', () => {
    const rule = parseRule('Bash(npm publish:*)', 'deny', 'userSettings')
    expect(rule).toMatchObject({
      toolName: 'Bash',
      content: 'npm publish:*',
      behavior: 'deny',
      source: 'userSettings',
    })
  })

  it('produces a whole-tool rule without content', () => {
    const rule = parseRule('Write', 'allow', 'config')
    expect(rule).toMatchObject({ toolName: 'Write', behavior: 'allow', source: 'config' })
    expect(rule.content).toBeUndefined()
    expect(rule.matcher).toBeUndefined()
  })

  it('throws on a malformed rule (fails loud)', () => {
    expect(() => parseRule('Bash(npm', 'deny', 'config')).toThrow(TypeError)
    expect(() => parseRule('', 'deny', 'config')).toThrow(TypeError)
  })
})

describe('ruleString', () => {
  it('round-trips through parseRuleString with escaped parens', () => {
    const rule = ruleString('Bash', 'python -c "print(1)"')
    expect(parseRuleString(rule)).toMatchObject({
      toolName: 'Bash',
      content: 'python -c "print(1)"',
    })
  })
})
