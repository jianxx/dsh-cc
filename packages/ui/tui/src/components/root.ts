/**
 * Root pi-tui mount: regular mode inlines on the main screen; fullscreen mode
 * takes over the alternate screen with a docked layout.
 * @module @jianxx/dsh-cc-tui/components/root
 */

import { spawn } from 'node:child_process'
import {
	Container,
	Editor,
	Key,
	matchesKey,
	ProcessTerminal,
	ScrollView,
	Text,
	TuiAltScreen,
	TuiMainScreen,
	VStack,
	getKeybindings,
	type Component,
	type Terminal,
	type TUI,
	type TuiMode,
} from '@jianxx/dsh-cc-pi-tui'
import type { Driver } from '../state/driver-types.ts'
import { routeApprovalInput, routeQuestionInput, routeModelPickerInput, routeSessionSwitcherInput, routeTodoPanelInput } from '../input.ts'
import { parseSlash } from '../slash.ts'
import { todoSummary } from '../store.ts'
import { buildArgCompleters } from './arg-completers.ts'
import { TuiAutocompleteProvider } from './completion.ts'
import { createEditorTheme, createTheme, type ThemeOverrides } from './theme.ts'
import { TranscriptView } from './transcript.ts'
import {
  createApprovalBox,
  createModelPickerBox,
  createQuestionBox,
  createSessionSwitcherBox,
  createTodoPanelBox,
} from './overlays.ts'

export interface BuildRootOptions {
	terminal?: Terminal
	onQuit?: () => void
	/**
	 * 'regular' (default) renders inline into the main screen scrollback;
	 * 'fullscreen' enters the alternate screen on start: the transcript scrolls
	 * inside a primary ScrollView while the dock (queue, todos, overlays,
	 * editor, statusline) stays pinned at the bottom.
	 */
	uiMode?: TuiMode
	/** Fullscreen-only: mouse capture for wheel scrolling and app-owned selection. Default true. */
	mouse?: boolean
	/**
	 * Per-role palette overrides for the terminal theme. Every role accepts a
	 * basic ANSI color name or a raw SGR code string; invalid values keep the
	 * built-in default, so an absent (or partial) override renders exactly like
	 * the historical fixed palette.
	 */
	theme?: ThemeOverrides
}

/** Cap the active-task text shown in the todo strip (ellipsis past the cap). */
const TODO_ACTIVE_CAP = 60

/** How long after the first idle Ctrl+C a second press still quits (ms). */
const DOUBLE_PRESS_WINDOW_MS = 2000

function truncateActive(content: string): string {
	return content.length > TODO_ACTIVE_CAP ? `${content.slice(0, TODO_ACTIVE_CAP - 1)}…` : content
}

export interface RootHandle {
	readonly tui: TUI
	readonly editor: Editor
	readonly mode: TuiMode
	destroy(): void
	/**
	 * Stop the surface. In fullscreen mode this leaves the alternate screen
	 * with the final frame preserved, then replays the chrome through a one-shot
	 * main-screen renderer so native scrollback ends up with the same inline
	 * layout a regular session would have produced.
	 */
	stopForExit(): void
}

/**
 * Open an OSC 8 hyperlink with the OS handler. Fullscreen mouse capture takes
 * over the terminal's native link activation, so clicks are routed here.
 */
function openSystemUrl(url: string): void {
	const child = process.platform === 'win32'
		? spawn('cmd.exe', ['/c', 'start', '', url], { stdio: 'ignore', detached: true })
		: spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true })
	child.on('error', () => {})
	child.unref()
}

/**
 * Build the pi-tui render tree.
 *
 * Children order: title · transcript · queue chips · todo strip · notice ·
 * [approval] · [question] · editor · statusline. The transcript and overlays
 * rebuild on every driver emit; the editor is persistent so it retains focus
 * and cursor state across renders.
 *
 * In regular mode the children render inline into the main screen. In
 * fullscreen mode the TUI enters the alternate screen: the title and transcript
 * scroll inside a primary ScrollView while the remaining chrome docks at the
 * bottom (the dock keeps its intrinsic height and yields rows first under
 * pressure, with the editor never squeezed below 1 row and the statusline
 * never below 1).
 */
export function buildRoot(driver: Driver, opts: BuildRootOptions = {}): RootHandle {
	const terminal = opts.terminal ?? new ProcessTerminal()
	const mode: TuiMode = opts.uiMode ?? 'regular'
	const theme = createTheme(opts.theme)
	const tui: TUI = mode === 'fullscreen'
		? new TuiAltScreen(terminal, undefined, undefined, {
			mouse: opts.mouse ?? true,
			openUrl: openSystemUrl,
		})
		: new TuiMainScreen(terminal)

	const title = new Text(theme.bold('dsh cc-mode'), 0, 0)
	const transcript = new TranscriptView(theme)

	// Pending-steer chip line. Collapses to zero lines when the queue is empty
	// (Text.render returns [] for blank content), so it takes no vertical space.
	const queueLine = new Text('', 0, 0)

	// Session todo strip (`☐ done/total · active task`), same persistent-Text
	// pattern: blank content collapses it to zero lines when no todos exist.
	const todoLine = new Text('', 0, 0)

	// Transient notice line (e.g. the "Press Ctrl+C again to exit" hint), same
	// persistent-Text pattern: blank content collapses it to zero lines when no
	// notice is parked.
	const noticeLine = new Text('', 0, 0)

	// Dynamic overlay slot (approval/question boxes). Cleared and rebuilt on
	// every state change so they appear and disappear with the driver state.
	const overlays = new Container()

	const editor = new Editor(tui, createEditorTheme(theme))
	// Seed the editor's ↑/↓ recall from persisted history (oldest first —
	// addToHistory unshifts, so the last-seeded/newest becomes index 0 and is
	// recalled on the first ↑ press).
	for (const entry of driver.promptHistory) editor.addToHistory(entry)

	// --- `!` bash mode ---------------------------------------------------------
	// Shell mode is derived, not stored: the composer is in shell mode exactly
	// while its text starts with `!`. The border switches to the warning role
	// so the mode is visible, ↑/↓ browse the bash-only history stack, and Esc
	// exits the mode ahead of the generic busy-interrupt branch (the ordering
	// in the input listener below is deliberate). Paste normalization lives at
	// the driver's submit — a `!`-prefixed line runs locally no matter how it
	// got into the buffer.
	let bashBrowsing = false
	let bashBrowsingIndex = -1
	let bashDraft = ''
	let bashRecallApplied = false
	let bashRunning = false

	const inShellMode = (): boolean => editor.getText().startsWith('!')

	const resetBashHistoryBrowsing = (): void => {
		bashBrowsing = false
		bashBrowsingIndex = -1
		bashDraft = ''
	}

	/**
	 * Browse the bash history stack (driver-owned, newest-first). ↑ walks
	 * toward older entries; ↓ walks back and restores the pre-browsing draft
	 * past the newest. Recalled entries are re-prefixed with `!` so the buffer
	 * stays shell-shaped and Enter re-runs them through the same submit path.
	 */
	const browseBashHistory = (towardsOlder: boolean): void => {
		const entries = driver.bashHistory
		if (entries.length === 0) return
		if (!bashBrowsing) {
			bashBrowsing = true
			bashBrowsingIndex = -1
			bashDraft = editor.getText()
		}
		if (towardsOlder) {
			if (bashBrowsingIndex + 1 >= entries.length) return // clamped at the oldest
			bashBrowsingIndex += 1
		} else {
			bashBrowsingIndex -= 1
			if (bashBrowsingIndex < 0) {
				// Down past the newest entry: restore the pre-browsing draft.
				const draft = bashDraft
				resetBashHistoryBrowsing()
				bashRecallApplied = true
				editor.setText(draft)
				bashRecallApplied = false
				return
			}
		}
		bashRecallApplied = true
		editor.setText(`!${entries[bashBrowsingIndex]}`)
		bashRecallApplied = false
	}

	// Mirror the shell-mode border on every buffer change: the warning role
	// while the buffer holds a `!`-prefixed line, the accent role otherwise.
	const syncShellModeBorder = (): void => {
		const styler = inShellMode() ? theme.warning : theme.accent
		if (editor.borderColor !== styler) {
			editor.borderColor = styler
			tui.requestRender()
		}
	}

	editor.onChange = (text: string): void => {
		driver.setDraft(text)
		syncShellModeBorder()
		// Any buffer change that was not a bash recall ends history browsing,
		// so the next ↑ starts fresh (mirrors the editor's own navigation).
		if (!bashRecallApplied) resetBashHistoryBrowsing()
	}
	editor.onSubmit = (text: string): void => {
		if (text.startsWith('!')) {
			// Shell command: never a composer prompt. While the driver runs it,
			// the composer is disabled — the input listener swallows every key
			// until submit settles (bounded by the command's own timeout).
			resetBashHistoryBrowsing()
			bashRunning = true
			void driver.submit(text)
				.catch(() => {})
				.then(() => {
					bashRunning = false
					tui.requestRender()
				})
			return
		}
		const parsed = parseSlash(text)
		// Only prompts join editor recall; slash commands are not prompts.
		if (parsed.kind === 'none') editor.addToHistory(text)
		void driver.submit(text)
		if (parsed.kind === 'local' && (parsed.name === 'quit' || parsed.name === 'exit')) {
			opts.onQuit?.()
		}
	}

	// Slash-command + @-file autocomplete. The provider is rebuilt only when the
	// driver's command catalog changes identity (driver.listCommands() returns a
	// stable reference until commands/change fires) — cheap reference compare on
	// every state emit, rebuild only when the catalog actually moved.
	// Argument completers (`/model`, `/resume`) are driver-backed and fetch per
	// request, so a single map built once at mount never goes stale.
	const argCompleters = buildArgCompleters(driver)
	let lastCatalog = driver.listCommands()
	let autocompleteProvider = new TuiAutocompleteProvider(lastCatalog, driver.cwd, undefined, argCompleters)
	editor.setAutocompleteProvider(autocompleteProvider)

	const statusline = new Text(driver.statusLineIn(terminal.columns), 0, 0)

	// Ordered chrome shared by the inline mount and the fullscreen exit replay.
	const chrome: Component[] = [title, transcript, queueLine, todoLine, noticeLine, overlays, editor, statusline]

	if (tui instanceof TuiAltScreen) {
		// Fullscreen (alternate screen): transcript scrolls inside the primary
		// ScrollView; the rest of the chrome docks at the bottom.
		const body = new VStack()
		body.addChild(title)
		body.addChild(transcript)
		const scrollView = new ScrollView(body, {
			follow: 'end',
			primary: true,
			overscroll: 'chain',
			scrollbar: 'auto',
		})
		const dock = new VStack()
		dock.addChild(queueLine, { shrink: 1, minSize: 0 })
		dock.addChild(todoLine, { shrink: 1, minSize: 0 })
		dock.addChild(noticeLine, { shrink: 1, minSize: 0 })
		dock.addChild(overlays, { shrink: 1, minSize: 0 })
		dock.addChild(editor, { shrink: 1, minSize: 1 })
		dock.addChild(statusline, { shrink: 1, minSize: 1 })
		const layoutRoot = new VStack()
		layoutRoot.addChild(scrollView, { basis: 0, grow: 1, shrink: 1, minSize: 1 })
		layoutRoot.addChild(dock, { basis: 'auto', grow: 0, shrink: 1, minSize: 1 })
		tui.setLayoutRoot(layoutRoot)
	} else {
		for (const child of chrome) tui.addChild(child)
	}

	// Free ctrl+c from the editor's copy keybinding so the global listener
	// owns the quit path.
	getKeybindings().setUserBindings({ 'tui.input.copy': [] })

	// Global key handler — runs BEFORE editor dispatch. Printable text belongs to
	// the editor; this listener owns only overlays and global chords. Anything it
	// does not consume falls through to the focused editor.
	const removeInputListener = tui.addInputListener((data: string) => {
		const live = driver.state
		// Ctrl+C arrives as a raw \x03 byte in raw mode (never a SIGINT). Treat it
		// as an escape hatch: interrupt when busy; quit when idle — but only on a
		// double press, so a stray Ctrl+C never kills the session. When an overlay
		// is open and the agent is idle, fall through so the overlay's own key
		// handling (esc to dismiss, etc.) owns it.
		if (data === '\x03') {
			if (live.busy) {
				driver.interrupt()
				return { consume: true }
			}
			if (live.approval !== undefined || live.question !== undefined ||
				live.modelPicker !== undefined || live.sessionSwitcher !== undefined ||
				live.todoPanel !== undefined) {
				return undefined
			}
			const now = Date.now()
			const lastAttempt = live.lastExitAttemptAt
			if (lastAttempt !== undefined && now - lastAttempt <= DOUBLE_PRESS_WINDOW_MS) {
				opts.onQuit?.()
				return { consume: true }
			}
			// First press: anchor the window and hint. The window expires
			// naturally — no per-keystroke timer resets.
			driver.markExitAttempt(now)
			driver.showNotice('Press Ctrl+C again to exit')
			return { consume: true }
		}
		if (live.approval !== undefined) {
			// Approval keys route through the shared router in input.ts — the same
			// single source of truth the headless composer path uses.
			routeApprovalInput(driver, data)
			return { consume: true }
		}
		if (live.question !== undefined) {
			// While a question is open every key belongs to the overlay — routed and
			// consumed here so the editor never sees typing, arrows, or enter.
			routeQuestionInput(driver, data)
			return { consume: true }
		}
		if (live.modelPicker !== undefined) {
			// Modal model picker: arrows/enter/esc only, everything else consumed.
			routeModelPickerInput(driver, data)
			return { consume: true }
		}
		if (live.sessionSwitcher !== undefined) {
			// Modal session switcher: arrows/enter/esc only, everything else
			// consumed. While `switching` is true, all keys are consumed without
			// action.
			routeSessionSwitcherInput(driver, data)
			return { consume: true }
		}
		if (live.todoPanel !== undefined) {
			// Modal todo panel: arrows/esc/ctrl+t (close) only, everything else
			// consumed. The open path is the ctrl+t binding below, which only
			// fires while the panel is closed.
			routeTodoPanelInput(driver, data)
			return { consume: true }
		}
		if (matchesKey(data, 'shift+tab')) {
			driver.cyclePermissionMode()
			return { consume: true }
		}
		if (matchesKey(data, Key.ctrl('o'))) {
			driver.toggleGlobalCollapse()
			return { consume: true }
		}
		if (matchesKey(data, Key.ctrl('t'))) {
			driver.toggleTodoPanel()
			return { consume: true }
		}
		if (matchesKey(data, Key.ctrl('s'))) {
			// Queue-jump: inject the outbox into the running turn now.
			driver.steerQueued()
			return { consume: true }
		}
		if (bashRunning) {
			// A local `!` command is in flight: the composer is disabled and
			// every key is swallowed until it settles. Ctrl+C above still owns
			// interrupt/quit; the stall is bounded by the command's timeout.
			return { consume: true }
		}
		if (inShellMode() && (matchesKey(data, Key.up) || matchesKey(data, Key.down))) {
			// Bash history browsing: the root-owned stack from driver.bashHistory,
			// consumed here so the editor's built-in prompt navigation never
			// interleaves with it (the editor never sees these arrows).
			browseBashHistory(matchesKey(data, Key.up))
			return { consume: true }
		}
		if (matchesKey(data, Key.up) && editor.getText().length === 0 && live.queued.length > 0) {
			// Empty composer + ↑ recalls the most recent queued entry for editing.
			// A non-empty composer (or empty queue) falls through so the editor's
			// own history navigation keeps working.
			const recalled = driver.recallQueued()
			if (recalled !== undefined) {
				editor.setText(recalled)
				return { consume: true }
			}
		}
		if (matchesKey(data, Key.escape)) {
			if (inShellMode()) {
				// Bash mode owns Esc FIRST — this branch must stay above the
				// busy-interrupt path: in shell mode Esc leaves the mode (the
				// buffer clears via onChange, which also restores the border)
				// and never interrupts the agent, even while busy.
				editor.setText('')
				resetBashHistoryBrowsing()
				return { consume: true }
			}
			if (live.busy) {
				driver.interrupt()
				return { consume: true }
			}
			return undefined
		}
		return undefined
	})

	// Rebuild transcript + overlays + statusline on every driver emit.
	const unsubscribe = driver.subscribe((state) => {
		transcript.setRows(state.rows, {
			thinkingExpanded: state.thinkingExpanded,
			toolOutputExpanded: state.toolOutputExpanded,
		})

		queueLine.setText(
			state.queued.length === 0
				? ''
				: state.queued.map(text => theme.muted(`⏵ queued: ${text}`)).join('\n'),
		)
		queueLine.invalidate()

		const summary = todoSummary(state)
		todoLine.setText(
			summary === undefined
				? ''
				: theme.muted(`☐ ${summary.done}/${summary.total}${summary.active === undefined ? '' : ` · ${truncateActive(summary.active)}`}`),
		)
		todoLine.invalidate()

		noticeLine.setText(state.notice === undefined ? '' : theme.muted(state.notice))
		noticeLine.invalidate()

		overlays.clear()
		if (state.approval !== undefined) {
			overlays.addChild(createApprovalBox(state.approval, theme))
		}
		if (state.question !== undefined) {
			overlays.addChild(createQuestionBox(state.question, theme))
		}
		if (state.modelPicker !== undefined) {
			overlays.addChild(createModelPickerBox(state.modelPicker, theme))
		}
		if (state.sessionSwitcher !== undefined) {
			overlays.addChild(createSessionSwitcherBox(state.sessionSwitcher, theme))
		}
		if (state.todoPanel !== undefined) {
			overlays.addChild(createTodoPanelBox(state.todos ?? [], state.todoPanel.focused, theme))
		}
		overlays.invalidate()

		// Refresh the autocomplete provider when the command catalog moves
		// (reference equality with the last-seen array). The driver keeps the
		// cached array stable across state emits until commands/change fires, so
		// this is a cheap guard that rebuilds only on an actual catalog change.
		const latestCatalog = driver.listCommands()
		if (latestCatalog !== lastCatalog) {
			lastCatalog = latestCatalog
			autocompleteProvider = new TuiAutocompleteProvider(latestCatalog, driver.cwd, undefined, argCompleters)
			editor.setAutocompleteProvider(autocompleteProvider)
		}

		// Known downgrade: the statusline is a fixed string, so a resize alone
		// does not recompute it — the new width applies on the next driver emit.
		statusline.setText(driver.statusLineIn(terminal.columns))
		tui.requestRender()
	})

	tui.setFocus(editor)

	return {
		get tui() {
			return tui
		},
		get mode() {
			return mode
		},
		editor,
		destroy() {
			removeInputListener()
			unsubscribe()
		},
		stopForExit() {
			if (!(tui instanceof TuiAltScreen)) {
				tui.stop()
				return
			}
			// Fullscreen exit (transcript form): leave the alternate
			// screen without repainting, then replay the chrome through a one-shot
			// main-screen renderer so native scrollback ends up with the same
			// inline layout a regular session would have produced.
			tui.stop({ preserveScreen: true })
			const replay = new TuiMainScreen(terminal)
			for (const child of chrome) replay.addChild(child)
			replay.renderNow()
			replay.stop()
		},
	}
}
