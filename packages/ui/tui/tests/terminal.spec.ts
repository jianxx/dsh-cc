import { describe, expect, it, vi } from 'vitest'
import { resetTerminalModes, setupGracefulExit } from '@jianxx/dsh-cc-tui/terminal.ts'

describe('resetTerminalModes', () => {
  it('writes mouse/paste/cursor resets without leaving the alt screen by default', () => {
    const writes: string[] = []
    const stdout = { write: (chunk: string) => { writes.push(chunk); return true } } as unknown as NodeJS.WriteStream
    resetTerminalModes(stdout, false)
    expect(writes.join('')).toContain('\x1b[?1000l')
    expect(writes.join('')).toContain('\x1b[?2004l')
    expect(writes.join('')).toContain('\x1b[?25h')
    expect(writes.join('')).not.toContain('\x1b[?1049l')
  })

  it('also leaves the alternate screen when fullscreen', () => {
    const writes: string[] = []
    const stdout = { write: (chunk: string) => { writes.push(chunk); return true } } as unknown as NodeJS.WriteStream
    resetTerminalModes(stdout, true)
    expect(writes.join('')).toContain('\x1b[?1049l')
  })
})

describe('setupGracefulExit', () => {
  it('installs exit and signal handlers and removes them on dispose', () => {
    const on = vi.spyOn(process, 'on')
    const off = vi.spyOn(process, 'off')
    const dispose = setupGracefulExit()
    const events = on.mock.calls.map(call => call[0])
    expect(events).toEqual(expect.arrayContaining(['exit', 'SIGINT', 'SIGTERM']))
    dispose()
    expect(off.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining(['exit', 'SIGINT', 'SIGTERM']))
    on.mockRestore()
    off.mockRestore()
  })
})
