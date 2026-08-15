import { describe, expect, it } from 'vitest'
import {
  parseCcFrontmatter,
  parseCcFrontmatterDocument,
} from '../src/frontmatter.ts'

describe('parseCcFrontmatter', () => {
  it('parses a full Claude Code skill frontmatter document', () => {
    const doc = [
      '---',
      'name: my-skill',
      'description: A demo skill',
      'when_to_use: When the user asks about demos',
      'allowed-tools: Bash, Edit',
      'argument-hint: "[query]"',
      'arguments: query mode',
      'version: 1.2.0',
      'model: inherit',
      'user-invocable: true',
      'disable-model-invocation: false',
      'context: fork',
      'agent: codex',
      'effort: high',
      'shell: false',
      'hooks:',
      '  PreToolUse:',
      '    - matcher: "read"',
      '      hooks: []',
      'paths:',
      '  - "src/**"',
      'custom-unknown: whatever',
      '---',
      '',
      'Body text.',
    ].join('\n')
    const parsed = parseCcFrontmatter(doc)
    expect(parsed).toEqual({
      name: 'my-skill',
      description: 'A demo skill',
      whenToUse: 'When the user asks about demos',
      allowedTools: ['Bash', 'Edit'],
      argumentHint: '[query]',
      arguments: ['query', 'mode'],
      version: '1.2.0',
      userInvocable: true,
      disableModelInvocation: false,
      executionContext: 'fork',
      agent: 'codex',
      effort: 'high',
      shell: false,
      hooks: {
        PreToolUse: [
          {
            matcher: 'read',
            hooks: [],
          },
        ],
      },
      paths: ['src'],
      unknown: { 'custom-unknown': 'whatever' },
    })
    expect(parsed?.model).toBeUndefined()
  })

  it('returns undefined for a document without frontmatter', () => {
    expect(parseCcFrontmatter('Just body text')).toBeUndefined()
    expect(parseCcFrontmatter('')).toBeUndefined()
  })

  it('tolerates unknown fields', () => {
    const parsed = parseCcFrontmatter([
      '---',
      'description: hello',
      'totally-unknown-field: 123',
      'another: [a, b]',
      '---',
      '',
      'Body.',
    ].join('\n'))!
    expect(parsed.description).toBe('hello')
  })

  it('throws for a known field with a bad value', () => {
    expect(() => parseCcFrontmatter([
      '---',
      'description: hello',
      'user-invocable: banana',
      '---',
      '',
      'Body.',
    ].join('\n'))).toThrow(/user-invocable/)
    expect(() => parseCcFrontmatter([
      '---',
      'description: hello',
      'context: not-fork',
      '---',
      '',
      'Body.',
    ].join('\n'))).toThrow(/context/)
  })

  it('separates frontmatter from body', () => {
    const doc = '---\ndescription: hello\n---\n\nActual body.\nSecond line.'
    const parsed = parseCcFrontmatterDocument(doc)!
    expect(parsed.data.description).toBe('hello')
    expect(parsed.body).toBe('Actual body.\nSecond line.')
  })
})

describe('frontmatter field defaults', () => {
  it('defaults userInvocable true and modelInvocable from disable-model-invocation', () => {
    const parsed = parseCcFrontmatter('---\ndescription: hi\n---\n\nB.')!
    expect(parsed.userInvocable).toBe(true)
    expect(parsed.disableModelInvocation).toBe(false)
  })

  it('reads named model as inherit when absent', () => {
    const parsed = parseCcFrontmatter('---\ndescription: hi\nmodel: claude-sonnet-4\n---\n\nB.')!
    expect(parsed.model).toBe('claude-sonnet-4')
  })
})
