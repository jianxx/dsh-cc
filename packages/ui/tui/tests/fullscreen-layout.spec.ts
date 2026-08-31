import { describe, expect, it } from 'vitest'
import { Terminal as XtermTerminal } from '@xterm/headless'
import { type Terminal as PiTerminal } from '@jianxx/dsh-cc-pi-tui'
import { buildRoot } from '@jianxx/dsh-cc-tui/components/root.ts'
import type { Driver } from '@jianxx/dsh-cc-tui/state/driver-types.ts'
import {
  clearQueue,
  createInitialState,
  markExitAttempt,
  popQueued,
  setNotice,
  setTurnActive,
  toggleGlobalCollapse,
  upsertRow,
  type TuiState,
} from '@jianxx/dsh-cc-tui/store.ts'
import { VERBS } from '@jianxx/dsh-cc-tui/working-line.ts'

/**
 * Minimal pi-tui Terminal that pipes write() calls into an @xterm/headless
 * Terminal so tests can assert on the rendered grid. Mirrors the fixture in
 * vt-renderer.spec.ts, plus a resize() hook.
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

	/** True while the alternate screen buffer is active (after \x1b[?1049h). */
	get altScreenActive(): boolean { return this.xterm.buffer.active === this.xterm.buffer.alternate }

	/** Feed a raw input sequence as if the user pressed keys. */
	sendInput(data: string): void { this.inputHandler?.(data) }

	/** Resize the underlying terminal and notify the TUI. */
	resize(cols: number, rows: number): void {
		this._cols = cols
		this._rows = rows
		this.xterm.resize(cols, rows)
		this.resizeHandler?.()
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
 * Minimal Driver fake: holds state, notifies subscribers, and no-ops the
 * overlay/session methods buildRoot never exercises here.
 */
function fakeDriver(initial: TuiState = createInitialState()): Driver & { setState(next: TuiState): void } {
	let state = initial
	const listeners = new Set<(s: TuiState) => void>()
	const emit = (): void => { for (const l of listeners) l(state) }
	const noop = (): void => {}
	const asyncNoop = async (): Promise<void> => {}
	return {
		get state() { return state },
		get statusLine() { return 'test · status' },
		statusLineIn: () => 'test · status',
		get cwd() { return process.cwd() },
		get promptHistory() { return [] },
		get bashHistory() { return [] },
		subscribe(listener) {
			listeners.add(listener)
			listener(state)
			return () => { listeners.delete(listener) }
		},
		setDraft(draft) { state = { ...state, draft }; emit() },
		async submit(text) {
			const draft = text ?? state.draft
			if (draft.trim().length === 0) return
			state = { ...state, draft: '' }
			emit()
		},
		interrupt() { state = { ...state, busy: false }; emit() },
		cyclePermissionMode: async () => {},
		toggleThinking() { state = { ...state, thinkingExpanded: !state.thinkingExpanded }; emit() },
		toggleGlobalCollapse() { state = toggleGlobalCollapse(state); emit() },
		answerApproval() { state = { ...state, approval: undefined }; emit() },
		questionMove: noop,
		questionToggle: noop,
		questionPick: noop,
		questionType: noop,
		questionBackspace: noop,
		questionSubmit: noop,
		questionCancel: noop,
		openModelPicker: asyncNoop,
		modelPickerMove: noop,
		modelPickerSubmit: noop,
		modelPickerCancel: noop,
		openEffortPicker: asyncNoop,
		effortPickerMove: noop,
		effortPickerSubmit: asyncNoop,
		effortPickerCancel: noop,
		openPermissionPicker: asyncNoop,
		permissionPickerMove: noop,
		permissionPickerSubmit: asyncNoop,
		permissionPickerCancel: noop,
		openSessionSwitcher: asyncNoop,
		sessionSwitcherMove: noop,
		sessionSwitcherSubmit: asyncNoop,
		sessionSwitcherCancel: noop,
		toggleTodoPanel: noop,
		todoPanelMove: noop,
		todoPanelClose: noop,
		usagePanelClose: noop,
		showNotice(text) { state = setNotice(state, text); emit() },
		markExitAttempt(now) { state = markExitAttempt(state, now ?? Date.now()); emit() },
		steerQueued() { state = clearQueue(state); emit() },
		recallQueued() {
			const popped = popQueued(state)
			if (popped.text === undefined) return undefined
			state = popped.state
			emit()
			return popped.text
		},
		switchSession: asyncNoop,
		async listSessions() { return [] },
		listCommands() { return [] },
		dispose: asyncNoop,
		setState(next) { state = next; emit() },
	}
}

/** Strip SGR sequences for structural assertions. */
function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
}

/** Wait for the throttled async render to settle. */
async function settle(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 60))
}

describe('fullscreen layout', () => {
	it('enters the alternate screen and pins the dock at the bottom', async () => {
		const vt = new VirtualTerminal(80, 24)
		let state = createInitialState()
		state = upsertRow(state, { kind: 'user', text: 'hello' })
		state = upsertRow(state, { kind: 'assistant', text: 'world' })
		state = upsertRow(state, { kind: 'status', text: 'done' })
		const driver = fakeDriver(state)

		const root = buildRoot(driver, { terminal: vt, onQuit: () => {}, uiMode: 'fullscreen', mouse: false })
		root.tui.start()
		await settle()

		expect(vt.altScreenActive).toBe(true)
		const g = vt.grid().map(stripAnsi)
		const joined = g.join('\n')
		expect(joined).toContain('dsh cc-mode')
		expect(joined).toContain('> hello')
		expect(joined).toContain('world')
		expect(joined).toContain('done')
		// The statusline docks at the very last row; the editor sits in the
		// dock above it (not scrolled away with the transcript).
		expect(g[23]).toContain('test · status')

		root.stopForExit()
		root.destroy()
	})

	it('keeps the dock pinned when the transcript overflows the viewport', async () => {
		const vt = new VirtualTerminal(80, 10)
		let state = createInitialState()
		for (let i = 0; i < 40; i++) {
			state = upsertRow(state, { kind: 'status', text: `line ${i}` })
		}
		const driver = fakeDriver(state)

		const root = buildRoot(driver, { terminal: vt, onQuit: () => {}, uiMode: 'fullscreen', mouse: false })
		root.tui.start()
		await settle()

		const g = vt.grid().map(stripAnsi)
		const joined = g.join('\n')
		// Follow-end: the latest status row is visible above the dock.
		expect(joined).toContain('line 39')
		// The oldest row scrolled off the visible region.
		expect(joined).not.toContain('line 0')
		// The dock stays pinned: statusline on the last row, editor above it.
		expect(g[9]).toContain('test · status')

		root.stopForExit()
		root.destroy()
	})

	it('survives a resize without dropping the dock', async () => {
		const vt = new VirtualTerminal(80, 24)
		const driver = fakeDriver(createInitialState())
		const root = buildRoot(driver, { terminal: vt, onQuit: () => {}, uiMode: 'fullscreen', mouse: false })
		root.tui.start()
		await settle()

		vt.resize(80, 8)
		await settle()

		const g = vt.grid().map(stripAnsi)
		// After shrinking, the statusline still occupies the bottom row.
		expect(g[7]).toContain('test · status')

		root.stopForExit()
		root.destroy()
	})

	it('replays the transcript into native scrollback on exit', async () => {
		const vt = new VirtualTerminal(80, 24)
		let state = createInitialState()
		state = upsertRow(state, { kind: 'user', text: 'persist me' })
		state = upsertRow(state, { kind: 'assistant', text: 'replayed answer' })
		const driver = fakeDriver(state)

		const root = buildRoot(driver, { terminal: vt, onQuit: () => {}, uiMode: 'fullscreen', mouse: false })
		root.tui.start()
		await settle()

		expect(vt.altScreenActive).toBe(true)

		root.stopForExit()
		// Exiting the alternate screen restores the normal buffer, and the
		// one-shot main-screen replay wrote the transcript into scrollback.
		// (The exit sequence and the replay writes are queued in order; xterm's
		// headless parser resolves them on the next tick.)
		await settle()
		expect(vt.altScreenActive).toBe(false)
		const joined = vt.grid().map(stripAnsi).join('\n')
		expect(joined).toContain('persist me')
		expect(joined).toContain('replayed answer')
		expect(joined).toContain('test · status')

		root.destroy()
	})

	it('renders the transient notice line in the dock and collapses it when empty', async () => {
		const vt = new VirtualTerminal(80, 24)
		const driver = fakeDriver(setNotice(createInitialState(), 'Press Ctrl+C again to exit'))
		const root = buildRoot(driver, { terminal: vt, onQuit: () => {}, uiMode: 'fullscreen', mouse: false })
		root.tui.start()
		await settle()

		let g = vt.grid().map(stripAnsi)
		expect(g.join('\n')).toContain('Press Ctrl+C again to exit')
		// The dock still pins the statusline to the last row.
		expect(g[23]).toContain('test · status')

		// Clearing the notice collapses the line back to zero rows.
		driver.setState(createInitialState())
		await settle()
		g = vt.grid().map(stripAnsi)
		expect(g.join('\n')).not.toContain('Press Ctrl+C again to exit')
		expect(g[23]).toContain('test · status')

		root.stopForExit()
		root.destroy()
	})
})

describe('working line', () => {
	/**
	 * Seed a live turn anchor into the fake driver; the verb is derived from
	 * startedAt exactly as the store does, so the assertion is deterministic
	 * (only the elapsed segment moves with the clock).
	 */
	function turnState(): TuiState {
		const startedAt = Date.now()
		return setTurnActive(createInitialState(), { startedAt, outputBase: undefined })
	}

	const verbOf = (state: TuiState): string => VERBS[state.turn!.startedAt % VERBS.length]

	it('renders the working line while a turn is anchored and collapses when it clears (fullscreen dock)', async () => {
		const vt = new VirtualTerminal(80, 24)
		const driver = fakeDriver(turnState())
		const verb = verbOf(driver.state)

		const root = buildRoot(driver, { terminal: vt, onQuit: () => {}, uiMode: 'fullscreen', mouse: false })
		root.tui.start()
		await settle()

		// The spinner row appears with the anchored turn's verb (`Galloping… (…)`).
		expect(vt.grid().map(stripAnsi).join('\n')).toContain(`${verb}… (`)

		// Clearing the anchor collapses the row back to zero lines.
		driver.setState(createInitialState())
		await settle()
		expect(vt.grid().map(stripAnsi).join('\n')).not.toContain(`${verb}… (`)

		root.stopForExit()
		root.destroy()
	})

	it('renders the working line in regular (inline) mode too', async () => {
		const vt = new VirtualTerminal(80, 24)
		const driver = fakeDriver(turnState())
		const verb = verbOf(driver.state)

		const root = buildRoot(driver, { terminal: vt, onQuit: () => {} })
		expect(root.mode).toBe('regular')
		root.tui.start()
		await settle()

		expect(vt.grid().map(stripAnsi).join('\n')).toContain(`${verb}… (`)

		driver.setState(createInitialState())
		await settle()
		expect(vt.grid().map(stripAnsi).join('\n')).not.toContain(`${verb}… (`)

		root.stopForExit()
		root.destroy()
	})
})
