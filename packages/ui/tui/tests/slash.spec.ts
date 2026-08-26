import { describe, expect, it } from 'vitest'
import { LOCAL_COMMANDS, parseSlash } from '@jianxx/dsh-cc-tui/slash.ts'

describe('LOCAL_COMMANDS', () => {
  it('has an entry for every TUI-owned slash name', () => {
    const names = LOCAL_COMMANDS.map(c => c.name).sort()
    expect(names).toEqual(['agents', 'clear', 'exit', 'model', 'quit', 'resume', 'tui-help'])
  })

  it('every entry has a non-empty description', () => {
    for (const cmd of LOCAL_COMMANDS) {
      expect(cmd.description.length).toBeGreaterThan(0)
    }
  })

  it('resume carries an argument hint', () => {
    const resume = LOCAL_COMMANDS.find(c => c.name === 'resume')
    expect(resume?.argumentHint).toBeDefined()
    expect(resume!.argumentHint!.length).toBeGreaterThan(0)
  })

  it('agents is listed with a subagent-activity description', () => {
    const agents = LOCAL_COMMANDS.find(c => c.name === 'agents')
    expect(agents).toBeDefined()
    expect(agents!.description.toLowerCase()).toContain('subagent')
  })
})

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
    expect(parseSlash('/agents')).toEqual({ kind: 'local', name: 'agents', rawInput: '' })
  })

  it('forwards unknown names to the harness catalog', () => {
    expect(parseSlash('/permissions plan')).toEqual({ kind: 'harness', line: '/permissions plan' })
    expect(parseSlash('/status')).toEqual({ kind: 'harness', line: '/status' })
  })
})
