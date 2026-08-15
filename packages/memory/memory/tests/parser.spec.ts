import { describe, expect, it } from 'vitest'
import { parseMemoryFile } from '../src/parser.ts'

describe('parseMemoryFile', () => {
  it('parses name, description, and typed frontmatter with a body', () => {
    const parsed = parseMemoryFile([
      '---',
      'name: user role',
      'description: user is a principal engineer',
      'type: user',
      '---',
      '',
      'The user is a principal engineer focused on observability.',
    ].join('\n'))
    expect(parsed).toEqual({
      frontmatter: { name: 'user role', description: 'user is a principal engineer', type: 'user' },
      body: 'The user is a principal engineer focused on observability.',
    })
  })

  it('drops the type when absent or unknown (legacy files keep working)', () => {
    expect(parseMemoryFile('---\nname: a\ndescription: b\n---\nbody')?.frontmatter).toEqual({
      name: 'a',
      description: 'b',
    })
    const unknown = parseMemoryFile('---\nname: a\ndescription: b\ntype: nope\n---\nbody')
    expect(unknown?.frontmatter).toEqual({ name: 'a', description: 'b' })
  })

  it('accepts all four documented types', () => {
    for (const type of ['user', 'feedback', 'project', 'reference']) {
      const parsed = parseMemoryFile(`---\nname: a\ndescription: b\ntype: ${type}\n---\nbody`)
      expect(parsed?.frontmatter.type).toBe(type)
    }
  })

  it('returns undefined for text without a leading frontmatter fence', () => {
    expect(parseMemoryFile('# just a heading\n\nbody')).toBeUndefined()
  })

  it('returns undefined when name or description is missing or empty', () => {
    expect(parseMemoryFile('---\ndescription: b\n---\nbody')).toBeUndefined()
    expect(parseMemoryFile('---\nname: " "\ndescription: b\n---\nbody')).toBeUndefined()
    expect(parseMemoryFile('---\nname: a\n---\nbody')).toBeUndefined()
  })

  it('returns undefined for malformed YAML body-less fences', () => {
    expect(parseMemoryFile('---\nname: a\ndescription: b\n')).toBeUndefined()
  })

  it('handles CRLF line endings', () => {
    const parsed = parseMemoryFile('---\r\nname: a\r\ndescription: b\r\ntype: project\r\n---\r\nbody')
    expect(parsed?.frontmatter).toEqual({ name: 'a', description: 'b', type: 'project' })
    expect(parsed?.body).toBe('body')
  })

  it('returns undefined for YAML that parses to a non-object', () => {
    expect(parseMemoryFile('---\n- a\n- b\n---\nbody')).toBeUndefined()
  })

  it('trims surrounding blank lines from the body', () => {
    const parsed = parseMemoryFile('---\nname: a\ndescription: b\n---\n\n  \nbody text\n\n')
    expect(parsed?.body).toBe('body text')
  })
})
