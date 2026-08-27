import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Terminal as XtermTerminal } from '@xterm/headless'
import {
  isKittyProtocolActive,
  setKittyProtocolActive,
  TuiMainScreen,
  type Terminal as PiTerminal,
} from '@jianxx/dsh-cc-pi-tui'
import { buildRoot } from '@jianxx/dsh-cc-tui/components/root.ts'
import type { Driver } from '@jianxx/dsh-cc-tui/state/driver-types.ts'
import { createInitialState, type TuiState } from '@jianxx/dsh-cc-tui/store.ts'

/**
 * Minimal pi-tui Terminal implementation that pipes write() calls into an
 * @xterm/headless Terminal so tests can assert on the rendered grid.
 * (Same pattern as vt-renderer.spec.ts.)
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
 * Minimal Driver fake: holds state, notifies subscribers, and tracks every
 * submit() call — including no-arg calls that resolve to the current draft,
 * mirroring the real driver's `const draft = text ?? state.draft` contract.
 */
function fakeDriver(initial: TuiState = createInitialState()): Driver & { submitted: string[] } {
  let state = initial
  const submitted: string[] = []
  const listeners = new Set<(s: TuiState) => void>()
  return {
    submitted,
    get state() { return state },
    get statusLine() { return 'test · status' },
    get cwd() { return process.cwd() },
    get promptHistory() { return [] },
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
      submitted.push(draft)
      state = { ...state, draft: '' }
      for (const l of listeners) l(state)
    },
    interrupt() {},
    cyclePermissionMode() {},
    toggleThinking() {},
    answerApproval() {},
    questionMove() {}, questionToggle() {}, questionPick() {},
    questionType() {}, questionBackspace() {}, questionSubmit() {}, questionCancel() {},
    async openModelPicker() {}, modelPickerMove() {}, modelPickerSubmit() {}, modelPickerCancel() {},
    async openSessionSwitcher() {}, sessionSwitcherMove() {},
    async sessionSwitcherSubmit() {}, sessionSwitcherCancel() {},
    async switchSession() {}, async listSessions() { return [] },
    listCommands() { return [] },
    async dispose() {},
  }
}

/** Wait for the throttled async render to settle. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 60))
}

describe('Enter key submission', () => {
  let savedKitty: boolean

  beforeEach(() => {
    savedKitty = isKittyProtocolActive()
    setKittyProtocolActive(true)
  })

  afterEach(() => {
    setKittyProtocolActive(savedKitty)
  })

  it('submits on \\n (line feed) even with Kitty keyboard protocol active', async () => {
    const vt = new VirtualTerminal(80, 24)
    const driver = fakeDriver()
    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    // Type a prompt — the editor's onChange feeds driver.setDraft.
    for (const ch of 'hello') vt.sendInput(ch)
    await settle()
    expect(driver.state.draft).toBe('hello')

    // \n is Shift+Enter (newline) under Kitty protocol — without the
    // explicit Enter handler the editor would insert a newline instead of
    // submitting. The global listener must catch it and call submit().
    vt.sendInput('\n')
    await settle()

    expect(driver.submitted).toContain('hello')

    root.tui.stop()
    root.destroy()
  })

  it('submits on \\r (carriage return)', async () => {
    const vt = new VirtualTerminal(80, 24)
    const driver = fakeDriver()
    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    for (const ch of 'hello') vt.sendInput(ch)
    await settle()

    vt.sendInput('\r')
    await settle()

    expect(driver.submitted).toContain('hello')

    root.tui.stop()
    root.destroy()
  })

  it('does not submit on Enter when an overlay is open (approval)', async () => {
    const vt = new VirtualTerminal(80, 24)
    const driver = fakeDriver({
      ...createInitialState(),
      approval: { toolName: 'Bash', command: 'rm -rf /tmp/x' },
    })
    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    vt.sendInput('\r')
    await settle()

    // The approval overlay owns Enter — submit is never called.
    expect(driver.submitted).toHaveLength(0)

    root.tui.stop()
    root.destroy()
  })
})
