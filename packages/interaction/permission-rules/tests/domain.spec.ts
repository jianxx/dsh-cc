import { describe, expect, it } from 'vitest'
import { canonicalizeHostname, domainMatches, isWebFetchRuleTool, parseDomainContent } from '../src/domain.ts'
import { parseRule, parseRuleString } from '../src/parser.ts'
import { evaluatePermission } from '../src/evaluate.ts'
import { subjectOf } from '../src/matchers.ts'
import { EMPTY_RULE_SET } from '../src/types.ts'
import type { EvaluationInput, PermissionRuleSet } from '../src/types.ts'

function input(overrides: Partial<EvaluationInput> = {}): EvaluationInput {
  return { toolName: 'web_fetch', rules: EMPTY_RULE_SET, mode: 'default', ...overrides }
}

function rules(overrides: Partial<PermissionRuleSet> = {}): PermissionRuleSet {
  return { allow: [], deny: [], ask: [], bypassImmune: [], ...overrides }
}

describe('isWebFetchRuleTool', () => {
  it('accepts both CC and harness spellings', () => {
    expect(isWebFetchRuleTool('WebFetch')).toBe(true)
    expect(isWebFetchRuleTool('web_fetch')).toBe(true)
    expect(isWebFetchRuleTool('Bash')).toBe(false)
  })
})

describe('canonicalizeHostname', () => {
  it('lowercases, strips trailing dots and ignores path/query', () => {
    expect(canonicalizeHostname('https://WWW.Example.com./path?q=1')).toBe('www.example.com')
    expect(canonicalizeHostname('https://Example.com./path?q=1')).toBe('example.com')
  })

  it('ignores the port', () => {
    expect(canonicalizeHostname('https://example.com:8443/')).toBe('example.com')
  })

  it('strips IPv6 brackets', () => {
    expect(canonicalizeHostname('http://[::1]:8080/')).toBe('::1')
  })

  it('returns undefined for an invalid URL', () => {
    expect(canonicalizeHostname('not a url')).toBeUndefined()
  })
})

describe('parseDomainContent', () => {
  it('parses and canonicalizes a plain host', () => {
    expect(parseDomainContent('domain:Example.COM.')).toEqual({ kind: 'domain', hostname: 'example.com' })
  })

  it('keeps a leading *. in the stored hostname', () => {
    expect(parseDomainContent('domain:*.example.com')).toEqual({ kind: 'domain', hostname: '*.example.com' })
  })

  it('rejects empty, scheme, path, port, and mid-label stars', () => {
    expect(() => parseDomainContent('domain:')).toThrow(TypeError)
    expect(() => parseDomainContent('domain:https://x')).toThrow(TypeError)
    expect(() => parseDomainContent('domain:example.com/path')).toThrow(TypeError)
    expect(() => parseDomainContent('domain:example.com:443')).toThrow(TypeError)
    expect(() => parseDomainContent('domain:*example.com')).toThrow(TypeError)
    expect(() => parseDomainContent('domain:foo*bar.com')).toThrow(TypeError)
  })

  it('accepts a star in a whole label position', () => {
    expect(parseDomainContent('domain:foo.*.com')).toEqual({ kind: 'domain', hostname: 'foo.*.com' })
  })
})

describe('domainMatches', () => {
  it('matches exact hosts only for a plain pattern', () => {
    expect(domainMatches('example.com', 'example.com')).toBe(true)
    expect(domainMatches('example.com', 'www.example.com')).toBe(false)
  })

  it('matches the bare domain and any depth for a leading *.', () => {
    expect(domainMatches('*.example.com', 'example.com')).toBe(true)
    expect(domainMatches('*.example.com', 'a.b.example.com')).toBe(true)
    expect(domainMatches('*.example.com', 'example.com.evil.com')).toBe(false)
  })

  it('matches exactly one label for a star in another position', () => {
    expect(domainMatches('foo.*.com', 'foo.bar.com')).toBe(true)
    expect(domainMatches('foo.*.com', 'foo.bar.baz.com')).toBe(false)
    expect(domainMatches('*.*.example.com', 'a.b.example.com')).toBe(true)
  })
})

describe('parseRuleString domain dispatch', () => {
  it('parses a WebFetch domain rule into a domain matcher', () => {
    expect(parseRuleString('WebFetch(domain:example.com)')).toEqual({
      toolName: 'WebFetch',
      content: 'domain:example.com',
      matcher: { kind: 'domain', hostname: 'example.com' },
    })
  })

  it('canonicalizes the host of a wildcard WebFetch domain rule', () => {
    const parsed = parseRuleString('WebFetch(domain:*.example.com)')
    expect(parsed.matcher).toEqual({ kind: 'domain', hostname: '*.example.com' })
  })

  it('canonicalizes case and trailing dot in the WebFetch rule', () => {
    const parsed = parseRuleString('web_fetch(domain:Example.COM.)')
    expect(parsed.matcher).toEqual({ kind: 'domain', hostname: 'example.com' })
  })

  it('keeps Bash(domain:example.com) a prefix matcher', () => {
    expect(parseRuleString('Bash(domain:example.com)')).toEqual({
      toolName: 'Bash',
      content: 'domain:example.com',
      matcher: { kind: 'prefix', prefix: 'domain:example.com' },
    })
  })

  it('throws on invalid WebFetch domain content', () => {
    expect(() => parseRuleString('WebFetch(domain:https://x)')).toThrow(TypeError)
    expect(() => parseRuleString('WebFetch(domain:)')).toThrow(TypeError)
    expect(() => parseRuleString('WebFetch(domain:*example.com)')).toThrow(TypeError)
  })

  it('round-trips through parseRule', () => {
    const rule = parseRule('WebFetch(domain:example.com)', 'allow', 'config')
    expect(rule.matcher).toEqual({ kind: 'domain', hostname: 'example.com' })
  })
})

describe('evaluatePermission with domain rules', () => {
  it('allows an exact host', () => {
    const decision = evaluatePermission(input({
      rules: rules({ allow: [parseRule('WebFetch(domain:docs.example.com)', 'allow', 'config')] }),
      subject: 'docs.example.com',
    }))
    expect(decision).toMatchObject({ kind: 'allow' })
  })

  it('does not match www with an exact rule', () => {
    const decision = evaluatePermission(input({
      rules: rules({ allow: [parseRule('WebFetch(domain:example.com)', 'allow', 'config')] }),
      subject: 'www.example.com',
    }))
    expect(decision).toEqual({ kind: 'passthrough' })
  })

  it('matches subdomains with a *. rule', () => {
    const decision = evaluatePermission(input({
      rules: rules({ allow: [parseRule('WebFetch(domain:*.example.com)', 'allow', 'config')] }),
      subject: 'a.b.example.com',
    }))
    expect(decision).toMatchObject({ kind: 'allow' })
  })

  it('lets a user deny beat a config allow of the same domain', () => {
    const decision = evaluatePermission(input({
      rules: rules({
        deny: [parseRule('WebFetch(domain:example.com)', 'deny', 'userSettings')],
        allow: [parseRule('WebFetch(domain:example.com)', 'allow', 'config')],
      }),
      subject: 'example.com',
    }))
    expect(decision).toMatchObject({ kind: 'deny' })
  })
})

describe('subjectOf WebFetch hostname', () => {
  it('returns the canonical hostname of args.url', () => {
    const exec = { name: 'web_fetch', arguments: { url: 'https://docs.example.com/a' } }
    expect(subjectOf(exec as never, 'Bash')).toBe('docs.example.com')
  })

  it('returns undefined for an unparsable URL', () => {
    const exec = { name: 'web_fetch', arguments: { url: 'not a url' } }
    expect(subjectOf(exec as never, 'Bash')).toBeUndefined()
  })

  it('keeps the bash command subject first', () => {
    const exec = { name: 'Bash', arguments: { command: 'npm install', url: 'https://x.com' } }
    expect(subjectOf(exec as never, 'Bash')).toBe('npm install')
  })
})
