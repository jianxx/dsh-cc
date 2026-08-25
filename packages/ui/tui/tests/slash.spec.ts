import { describe, expect, it } from 'vitest'
import { parseSlash } from '@jianxx/dsh-cc-tui/slash.ts'

describe('parseSlash', () => {
  it('treats a non-slash line as none', () => {
    expect(parseSlash('hello')).toEqual({ kind: 'none' })
  })

  it('keeps TUI-owned names local', () => {
    expect(parseSlash('/quit')).toEqual({ kind: 'local', name: 'quit', rawInput: '' })
    expect(parseSlash('/exit now')).toEqual({ kind: 'local', name: 'exit', rawInput: 'now' })
    expect(parseSlash('/clear')).toEqual({ kind: 'local', name: 'clear', rawInput: '' })
    expect(parseSlash('/resume sess-1')).toEqual({ kind: 'local', name: 'resume', rawInput: 'sess-1' })
    expect(parseSlash('/model 2')).toEqual({ kind: 'local', name: 'model', rawInput: '2' })
  })

  it('forwards unknown names to the harness catalog', () => {
    expect(parseSlash('/permissions plan')).toEqual({ kind: 'harness', line: '/permissions plan' })
    expect(parseSlash('/status')).toEqual({ kind: 'harness', line: '/status' })
  })
})
