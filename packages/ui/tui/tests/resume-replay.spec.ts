import { describe, expect, it, vi } from 'vitest'
import { Terminal as XtermTerminal } from '@xterm/headless'
import {
  type Terminal as PiTerminal,
} from '@jianxx/dsh-cc-pi-tui'
import { buildRoot } from '@jianxx/dsh-cc-tui/components/root.ts'
import type { Driver } from '@jianxx/dsh-cc-tui/state/driver-types.ts'
import {
  createInitialState,
  type TuiState,
} from '@jianxx/dsh-cc-tui/store.ts'
import {
  applySessionEvent,
  type SessionEventLike,
  type ToolPresenters,
} from '@jianxx/dsh-cc-tui/transcript.ts'

/**
 * Minimal pi-tui Terminal implementation that pipes write() calls into an
 * @xterm/headless Terminal so tests can assert on the rendered grid.
 * Mirrors the fixture in vt-renderer.spec.ts.
 */
class VirtualTerminal implements PiTerminal {
  private readonly xterm: XtermTerminal
  private _cols: number
  private _rows: number

  constructor(cols = 80, rows = 24) {
    this._cols = cols
    this._rows = rows
    this.xterm = new XtermTerminal({ cols, rows, allowProposedApi: true })
  }

  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void { this.xterm.write(data) }

  get columns(): number { return this._cols }
  get rows(): number { return this._rows }
  get kittyProtocolActive(): boolean { return false }

  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}

  line(row: number): string {
    const base = this.xterm.buffer.active.baseY
    return this.xterm.buffer.active.getLine(base + row)?.translateToString(true) ?? ''
  }

  grid(): string[] {
    const lines: string[] = []
    for (let i = 0; i < this._rows; i++) lines.push(this.line(i))
    return lines
  }
}

/** Minimal Driver fake that serves a fixed state to subscribers. */
function fakeDriver(initial: TuiState): Driver {
  let state = initial
  const listeners = new Set<(s: TuiState) => void>()
  return {
    get state() { return state },
    get statusLine() { return 'test · status' },
    subscribe(listener: (s: TuiState) => void) {
      listeners.add(listener)
      listener(state)
      return () => { listeners.delete(listener) }
    },
    setDraft() {},
    async submit() {},
    interrupt() {},
    cyclePermissionMode() {},
    answerApproval() {},
    answerQuestion() {},
    async dispose() {},
  }
}

/** Wait for the throttled async render to settle. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 60))
}

describe('resume replay — folding a durable event log', () => {
  it('re-runs presenters on replay and produces finalized rows', () => {
    const presentCall = vi.fn((_name: string, _args: unknown) =>
      ({ card: 'terminal' as const, title: 'run: bash', cwd: '/tmp' }))
    const presentResult = vi.fn((_name: string, _args: unknown, _result: { content: unknown; isError: boolean; meta?: unknown }) =>
      ({ card: 'terminal' as const, output: 'ok-out', exitCode: 0 }))
    const presenters: ToolPresenters = { presentCall, presentResult }

    const events: SessionEventLike[] = [
      // Unknown seed bracket — fold must skip it without throwing.
      { type: 'session/start', data: {} },
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { content: [{ type: 'text', text: 'list files' }], source: { kind: 'user' } } },
      { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Hello' } } },
      { type: 'assistant/message', data: { turn: 1, step: 1, message: {} } },
      { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } },
      { type: 'tool/result', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', text: 'file.txt' } },
      { type: 'turn/end', data: { turn: 1, reason: 'normal' } },
    ]

    let folded = createInitialState()
    for (const event of events) {
      folded = applySessionEvent(folded, event, presenters)
    }

    // Presenters re-ran on the stored args (pure by contract).
    expect(presentCall).toHaveBeenCalledWith('bash', { command: 'ls' })
    expect(presentResult).toHaveBeenCalledWith('bash', { command: 'ls' }, expect.objectContaining({ isError: false }))

    // Rows: user text, assistant text, finalized tool row.
    expect(folded.rows).toContainEqual({ kind: 'user', text: 'list files' })
    expect(folded.rows).toContainEqual({ kind: 'assistant', text: 'Hello' })
    expect(folded.rows).toContainEqual(expect.objectContaining({
      kind: 'tool',
      callId: 'c1',
      running: false,
      title: 'run: bash',
    }))
    expect(folded.busy).toBe(false)
  })

  it('renders the folded rows through TranscriptView into the terminal', async () => {
    const events: SessionEventLike[] = [
      { type: 'user/message', data: { content: [{ type: 'text', text: 'list files' }], source: { kind: 'user' } } },
      { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Hello' } } },
      {
        type: 'tool/call',
        data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
      },
      {
        type: 'tool/result',
        data: { turn: 1, step: 1, callId: 'c1', name: 'bash', text: 'file.txt' },
      },
    ]

    let folded = createInitialState()
    for (const event of events) {
      folded = applySessionEvent(folded, event)
    }

    const vt = new VirtualTerminal(80, 24)
    const driver = fakeDriver(folded)
    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const joined = vt.grid().join('\n')
    expect(joined).toContain('list files')
    expect(joined).toContain('Hello')
    expect(joined).toContain('bash')

    root.tui.stop()
    root.destroy()
  })
})
