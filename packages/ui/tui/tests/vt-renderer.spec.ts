import { describe, expect, it } from 'vitest'
import { Terminal as XtermTerminal } from '@xterm/headless'
import {
  TuiMainScreen,
  type Terminal as PiTerminal,
} from '@jianxx/dsh-cc-pi-tui'
import { buildRoot } from '@jianxx/dsh-cc-tui/components/root.ts'
import type { Driver } from '@jianxx/dsh-cc-tui/state/driver-types.ts'
import {
  createInitialState,
  enqueue,
  setApproval,
  setBusy,
  setQuestion,
  upsertRow,
  type TuiState,
} from '@jianxx/dsh-cc-tui/store.ts'

/**
 * Minimal pi-tui Terminal implementation that pipes write() calls into an
 * @xterm/headless Terminal so tests can assert on the rendered grid.
 */
class VirtualTerminal implements PiTerminal {
  private readonly xterm: XtermTerminal
  private inputHandler?: (data: string) => void
  private resizeHandler?: () => void
  private _cols: number
  private _rows: number

  constructor(cols = 80, rows = 24) {
    this._cols = cols
    this._rows = rows
    this.xterm = new XtermTerminal({ cols, rows, allowProposedApi: true })
  }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inputHandler = onInput
    this.resizeHandler = onResize
  }

  stop(): void {}

  async drainInput(): Promise<void> {}

  write(data: string): void {
    this.xterm.write(data)
  }

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

  /** Feed raw input as if the user pressed a key. */
  sendInput(data: string): void {
    this.inputHandler?.(data)
  }

  /** Read a grid row (trimmed). */
  line(row: number): string {
    const base = this.xterm.buffer.active.baseY
    return this.xterm.buffer.active.getLine(base + row)?.translateToString(true) ?? ''
  }

  /** Full visible grid as trimmed strings. */
  grid(): string[] {
    const lines: string[] = []
    for (let i = 0; i < this._rows; i++) lines.push(this.line(i))
    return lines
  }
}

/**
 * Minimal Driver fake: holds state, notifies subscribers, and implements the
 * overlay-answer methods so the global input listener can dismiss prompts.
 */
function fakeDriver(initial: TuiState = createInitialState()): Driver & { setState(next: TuiState): void } {
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
    setDraft(draft: string) {
      state = { ...state, draft }
      for (const l of listeners) l(state)
    },
    async submit(text?: string) {
      const draft = text ?? state.draft
      if (draft.trim().length === 0) return
      state = { ...state, draft: '' }
      for (const l of listeners) l(state)
    },
    interrupt() {
      state = setBusy(state, false)
      for (const l of listeners) l(state)
    },
    cyclePermissionMode() {},
    answerApproval(_allowed: boolean) {
      state = setApproval(state, undefined)
      for (const l of listeners) l(state)
    },
    answerQuestion(_selected: string) {
      state = setQuestion(state, undefined)
      for (const l of listeners) l(state)
    },
    async dispose() {},
    setState(next: TuiState) {
      state = next
      for (const l of listeners) l(state)
    },
  }
}

/** Wait for the throttled async render to settle. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 60))
}

describe('vt-renderer', () => {
  it('renders transcript rows in order', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = upsertRow(state, { kind: 'user', text: 'hello' })
    state = upsertRow(state, { kind: 'assistant', text: 'world' })
    state = upsertRow(state, { kind: 'status', text: 'done' })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const g = vt.grid()
    const joined = g.join('\n')
    expect(joined).toContain('dsh cc-mode')
    expect(joined).toContain('> hello')
    expect(joined).toContain('world')
    expect(joined).toContain('done')

    // Title comes before the first transcript row.
    const titleRow = g.findIndex(l => l.includes('dsh cc-mode'))
    const userRow = g.findIndex(l => l.includes('> hello'))
    expect(titleRow).toBeGreaterThanOrEqual(0)
    expect(userRow).toBeGreaterThan(titleRow)

    root.tui.stop()
    root.destroy()
  })

  it('shows an approval overlay and dismisses it on 1', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = setApproval(state, { toolName: 'Bash', command: 'rm -rf /' })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    let g = vt.grid()
    expect(g.join('\n')).toContain('Approve Bash')
    expect(g.join('\n')).toContain('1 yes')

    // Answer "yes" by pressing 1.
    vt.sendInput('1')
    await settle()

    g = vt.grid()
    expect(g.join('\n')).not.toContain('Approve Bash')

    root.tui.stop()
    root.destroy()
  })

  it('keeps the composer visible when the transcript overflows the terminal', async () => {
    const vt = new VirtualTerminal(80, 10)
    let state = createInitialState()
    for (let i = 0; i < 20; i++) {
      state = upsertRow(state, { kind: 'assistant', text: `line ${i + 1}` })
    }
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const g = vt.grid()
    // The editor border (─) and the statusline must be in the visible
    // viewport — the frame-overflow regression would push them off-screen.
    const joined = g.join('\n')
    expect(joined).toContain('─')
    expect(joined).toContain('test · status')

    root.tui.stop()
    root.destroy()
  })

  it('renders a queued chip line for each pending steer above the composer', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = upsertRow(state, { kind: 'assistant', text: 'working' })
    state = setBusy(state, true)
    state = enqueue(state, 'fix the bug')
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const joined = vt.grid().join('\n')
    expect(joined).toContain('⏵ queued: fix the bug')

    root.tui.stop()
    root.destroy()
  })

  it('does not render a queue chip when the queue is empty', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = upsertRow(state, { kind: 'user', text: 'hi' })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const joined = vt.grid().join('\n')
    expect(joined).not.toContain('⏵ queued:')

    root.tui.stop()
    root.destroy()
  })
})
