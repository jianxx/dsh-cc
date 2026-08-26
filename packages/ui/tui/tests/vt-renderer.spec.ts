import { describe, expect, it } from 'vitest'
import { Terminal as XtermTerminal } from '@xterm/headless'
import {
  TuiMainScreen,
  type Terminal as PiTerminal,
} from '@jianxx/dsh-cc-pi-tui'
import { buildRoot } from '@jianxx/dsh-cc-tui/components/root.ts'
import type { Driver } from '@jianxx/dsh-cc-tui/state/driver-types.ts'
import {
  backspaceQuestionText,
  createInitialState,
  enqueue,
  moveQuestionFocus,
  setApproval,
  setBusy,
  setQuestion,
  toggleQuestionOption,
  typeQuestionText,
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
function fakeDriver(
  initial: TuiState = createInitialState(),
  promptHistory: readonly string[] = [],
): Driver & { setState(next: TuiState): void } {
  let state = initial
  const listeners = new Set<(s: TuiState) => void>()
  return {
    get state() { return state },
    get statusLine() { return 'test · status' },
    get cwd() { return process.cwd() },
    get promptHistory() { return promptHistory },
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
    toggleThinking() {
      state = { ...state, thinkingExpanded: !state.thinkingExpanded }
      for (const l of listeners) l(state)
    },
    answerApproval(_allowed: boolean) {
      state = setApproval(state, undefined)
      for (const l of listeners) l(state)
    },
    questionMove(delta) {
      state = moveQuestionFocus(state, delta)
      for (const l of listeners) l(state)
    },
    questionToggle() {
      const q = state.question
      if (q === undefined) return
      if (q.focused >= q.options.length) {
        state = typeQuestionText(state, ' ')
      } else if (q.multiSelect) {
        state = toggleQuestionOption(state, q.focused)
      } else {
        state = setQuestion(state, undefined)
      }
      for (const l of listeners) l(state)
    },
    questionPick(index) {
      const q = state.question
      if (q === undefined || index < 0 || index >= q.options.length) return
      if (q.multiSelect) {
        state = toggleQuestionOption(state, index)
      } else {
        state = setQuestion(state, undefined)
      }
      for (const l of listeners) l(state)
    },
    questionType(text) {
      state = typeQuestionText(state, text)
      for (const l of listeners) l(state)
    },
    questionBackspace() {
      state = backspaceQuestionText(state)
      for (const l of listeners) l(state)
    },
    questionSubmit() {
      state = setQuestion(state, undefined)
      for (const l of listeners) l(state)
    },
    questionCancel() {
      state = setQuestion(state, undefined)
      for (const l of listeners) l(state)
    },
    listCommands() {
      return [
        { name: 'quit', description: 'Exit the TUI session' },
        { name: 'tui-help', description: 'Show TUI keyboard and command help' },
      ]
    },
    async dispose() {},
    setState(next: TuiState) {
      state = next
      for (const l of listeners) l(state)
    },
  }
}

/** Strip SGR sequences for structural assertions. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
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

  it('approval box renders tool name, reason, capped command preview, and explicit choices', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = setApproval(state, {
      toolName: 'Bash',
      reason: 'destructive git operation',
      command: 'set -e\necho one\necho two\necho three',
    })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const joined = vt.grid().join('\n')
    expect(joined).toContain('Approve Bash')
    expect(joined).toContain('destructive git operation')
    // First three command lines render; the fourth is cut with a … trailer.
    expect(joined).toContain('set -e')
    expect(joined).toContain('echo one')
    expect(joined).toContain('echo two')
    expect(joined).toContain('…')
    expect(joined).not.toContain('echo three')
    // Explicit key → outcome mapping, not a bare yes/no.
    expect(joined).toContain('1 Yes, allow once')
    expect(joined).toContain('2 No, reject')

    root.tui.stop()
    root.destroy()
  })

  it('approval box: 1 resolves allow, 2 resolves reject, other keys never reach the editor', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = setApproval(state, { toolName: 'Bash', command: 'rm -rf /tmp/x' })
    const driver = fakeDriver(state)
    const answers: boolean[] = []
    const baseAnswer = driver.answerApproval.bind(driver)
    driver.answerApproval = (allowed: boolean) => {
      answers.push(allowed)
      baseAnswer(allowed)
    }

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    // A non-answer key is consumed by the overlay: the editor draft stays
    // untouched while the approval box is open.
    vt.sendInput('x')
    await settle()
    expect(root.editor.getText()).toBe('')

    vt.sendInput('1')
    await settle()
    expect(answers).toEqual([true])
    expect(vt.grid().join('\n')).not.toContain('Approve Bash')

    // Reopen and reject with 2.
    driver.setState(setApproval(driver.state, { toolName: 'Bash', command: 'rm -rf /tmp/x' }))
    await settle()
    vt.sendInput('2')
    await settle()
    expect(answers).toEqual([true, false])
    expect(root.editor.getText()).toBe('')

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

  it('renders diff hunks beneath a tool row head when diffs are present', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = upsertRow(state, {
      kind: 'tool',
      callId: 'd1',
      name: 'Edit',
      args: '{}',
      title: 'Edit foo.ts',
      running: false,
      diffs: [{ path: 'foo.ts', oldText: 'old line\n', newText: 'new line\n' }],
    })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const joined = vt.grid().join('\n')
    // Head line with the title.
    expect(joined).toContain('Edit foo.ts')
    // Path header and hunk lines visible on screen.
    expect(joined).toContain('foo.ts')
    expect(stripAnsi(joined)).toContain('- old line')
    expect(stripAnsi(joined)).toContain('+ new line')

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

  it('renders a running tool row with a present-tense verb before the title', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = upsertRow(state, {
      kind: 'tool',
      callId: 'r1',
      name: 'bash',
      args: '{"command":"ls"}',
      title: 'bash',
      running: true,
    })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('Running')
    expect(stripped).toContain('bash')
    expect(stripped).toContain('…')

    root.tui.stop()
    root.destroy()
  })

  it('renders a completed tool row with a checkmark and no verb', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = upsertRow(state, {
      kind: 'tool',
      callId: 'd1',
      name: 'bash',
      args: '{}',
      title: 'ls -la',
      running: false,
      result: 'ok',
    })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('ls -la')
    expect(stripped).toContain('✓')
    expect(stripped).not.toContain('Running')

    root.tui.stop()
    root.destroy()
  })

  it('renders a thinking row collapsed to a one-line hint by default (body hidden)', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = upsertRow(state, { kind: 'thinking', text: 'let me reason\nabout this\nnow' })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('thinking (3 lines — Ctrl+O to expand)')
    expect(stripped).toContain('▸')
    // Collapsed: the body text must NOT leak into the grid.
    expect(stripped).not.toContain('let me reason')

    root.tui.stop()
    root.destroy()
  })

  it('renders the thinking body with a ▾ marker when thinkingExpanded is true', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = upsertRow(state, { kind: 'thinking', text: 'let me reason\nabout this' })
    state = { ...state, thinkingExpanded: true }
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('▾')
    expect(stripped).toContain('let me reason')
    expect(stripped).not.toContain('Ctrl+O to expand')

    root.tui.stop()
    root.destroy()
  })

  it('re-renders a thinking row on a flag flip despite unchanged row identity', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = upsertRow(state, { kind: 'thinking', text: 'secret reasoning' })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    let stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('thinking (1 lines — Ctrl+O to expand)')
    expect(stripped).not.toContain('secret reasoning')

    // Flip the flag WITHOUT touching the rows array reference — the cached
    // thinking row must still rebuild so the body appears.
    driver.setState({ ...state, thinkingExpanded: true })
    await settle()

    stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('secret reasoning')
    expect(stripped).not.toContain('Ctrl+O to expand')

    root.tui.stop()
    root.destroy()
  })

  it('toggles thinking on ctrl+o and re-renders the transcript', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = upsertRow(state, { kind: 'thinking', text: 'hidden thought' })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    let stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).not.toContain('hidden thought')

    vt.sendInput('\x0f') // ctrl+o
    await settle()

    stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('hidden thought')
    expect(driver.state.thinkingExpanded).toBe(true)

    root.tui.stop()
    root.destroy()
  })

  it('surfaces slash-command autocomplete when the user types /t', async () => {
    const vt = new VirtualTerminal(80, 24)
    const driver = fakeDriver(createInitialState())

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    // Type "/t" — the editor auto-triggers autocomplete via
    // isInSlashCommandContext on the alphanumeric 't'.
    vt.sendInput('/')
    vt.sendInput('t')
    await settle()

    // The fakeDriver catalog exposes 'tui-help'; it must appear in the rendered
    // grid as a suggestion entry. Asserting the name (not the overlay layout)
    // keeps this resilient to SelectList presentation changes.
    const stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('tui-help')

    root.tui.stop()
    root.destroy()
  })

  it('seeds editor ↑/↓ history from driver.promptHistory (newest recalled first)', async () => {
    const vt = new VirtualTerminal(80, 24)
    const driver = fakeDriver(createInitialState(), ['older', 'newer'])

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    // Editor starts empty → ↑ recalls the most recent entry ('newer'), not
    // 'older' (addToHistory unshifts, so index 0 is the last seeded).
    vt.sendInput('\x1b[A') // arrow up
    await settle()

    const stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('newer')
    expect(stripped).not.toContain('older')

    root.tui.stop()
    root.destroy()
  })

  it('renders the question overlay with options, focus marker, Other row, and hint', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = setQuestion(state, {
      header: 'Decision',
      question: 'Which flavor?',
      options: [{ label: 'vanilla' }, { label: 'chocolate' }],
      multiSelect: false,
      focused: 0,
      selected: [],
      custom: '',
    })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('Which flavor?')
    expect(stripped).toContain('vanilla')
    expect(stripped).toContain('chocolate')
    // Focus marker sits on the focused (first) option.
    expect(stripped).toContain('❯ 1. vanilla')
    // Free-text escape hatch row is always present.
    expect(stripped).toContain('Other:')
    // Single-select footer hint.
    expect(stripped).toContain('enter select')
    expect(stripped).toContain('esc cancel')

    root.tui.stop()
    root.destroy()
  })

  it('renders a plan-review question with the Plan review title and plan markdown', async () => {
    const vt = new VirtualTerminal(80, 30)
    let state = createInitialState()
    state = setQuestion(state, {
      header: 'Decision',
      question: 'Approve this plan?',
      detail: '## The plan\n\n- refactor the store\n- add tests',
      options: [{ label: 'Ship it' }, { label: 'Keep iterating' }],
      multiSelect: false,
      intent: { kind: 'plan-review', approve: 'Ship it' },
      focused: 0,
      selected: [],
      custom: '',
    })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    const stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('Plan review')
    expect(stripped).toContain('Approve this plan?')
    // Plan markdown body renders (heading text + list items via Markdown).
    expect(stripped).toContain('The plan')
    expect(stripped).toContain('refactor the store')
    expect(stripped).toContain('add tests')
    // Options still follow the plan.
    expect(stripped).toContain('Ship it')

    root.tui.stop()
    root.destroy()
  })

  it('multi-select shows [ ] before unselected options and [x] after a space toggle', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = setQuestion(state, {
      header: 'Pick',
      question: 'Which areas?',
      options: [{ label: 'ui' }, { label: 'api' }],
      multiSelect: true,
      focused: 0,
      selected: [],
      custom: '',
    })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    let stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('❯ 1. [ ] ui')
    expect(stripped).toContain('2. [ ] api')
    expect(stripped).toContain('space toggle')

    // Space toggles the focused option ('ui') — [x] appears.
    vt.sendInput(' ')
    await settle()
    stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('1. [x] ui')
    expect(stripped).toContain('2. [ ] api')

    root.tui.stop()
    root.destroy()
  })

  it('typing while a question is open feeds the Other row, not the editor', async () => {
    const vt = new VirtualTerminal(80, 24)
    let state = createInitialState()
    state = setQuestion(state, {
      header: 'Pick',
      question: 'Name it',
      options: [{ label: 'alpha' }],
      multiSelect: false,
      focused: 0,
      selected: [],
      custom: '',
    })
    const driver = fakeDriver(state)

    const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
    root.tui.start()
    await settle()

    for (const ch of 'zed') vt.sendInput(ch)
    await settle()

    const stripped = stripAnsi(vt.grid().join('\n'))
    expect(stripped).toContain('Other: zed')
    // The editor draft stays empty — printable keys never reached it.
    expect(driver.state.draft).toBe('')

    root.tui.stop()
    root.destroy()
  })
})
