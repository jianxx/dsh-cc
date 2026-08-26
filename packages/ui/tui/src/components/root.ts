/**
 * Root pi-tui mount: TuiMainScreen with transcript, overlays, editor, and
 * statusline. Replaces the Ink/React tree from ui.tsx one-for-one.
 * @module @jianxx/dsh-cc-tui/components/root
 */

import {
  Container,
  Editor,
  Key,
  matchesKey,
  ProcessTerminal,
  Text,
  getKeybindings,
  TuiMainScreen,
  type Terminal,
  type TUI,
} from '@jianxx/dsh-cc-pi-tui'
import type { Driver } from '../state/driver-types.ts'
import { parseSlash } from '../slash.ts'
import { TuiAutocompleteProvider } from './completion.ts'
import { bold, dim, editorTheme } from './theme.ts'
import { TranscriptView } from './transcript.ts'
import { createApprovalBox, createQuestionBox } from './overlays.ts'

export interface BuildRootOptions {
  terminal?: Terminal
  onQuit?: () => void
}

export interface RootHandle {
  readonly tui: TUI
  readonly editor: Editor
  destroy(): void
}

/**
 * Build the pi-tui render tree on a TuiMainScreen.
 *
 * Children order: title · transcript · [approval] · [question] · editor ·
 * statusline. The transcript and overlays rebuild on every driver emit; the
 * editor is persistent so it retains focus and cursor state across renders.
 */
export function buildRoot(driver: Driver, opts: BuildRootOptions = {}): RootHandle {
  const terminal = opts.terminal ?? new ProcessTerminal()
  const tui = new TuiMainScreen(terminal)

  const title = new Text(bold('dsh cc-mode'), 0, 0)
  tui.addChild(title)

  const transcript = new TranscriptView()
  tui.addChild(transcript)

  // Pending-steer chip line. Collapses to zero lines when the queue is empty
  // (Text.render returns [] for blank content), so it takes no vertical space.
  const queueLine = new Text('', 0, 0)
  tui.addChild(queueLine)

  // Dynamic overlay slot (approval/question boxes). Cleared and rebuilt on
  // every state change so they appear and disappear with the driver state.
  const overlays = new Container()
  tui.addChild(overlays)

  const editor = new Editor(tui, editorTheme)
  // Seed the editor's ↑/↓ recall from persisted history (oldest first —
  // addToHistory unshifts, so the last-seeded/newest becomes index 0 and is
  // recalled on the first ↑ press).
  for (const entry of driver.promptHistory) editor.addToHistory(entry)
  editor.onChange = (text: string): void => {
    driver.setDraft(text)
  }
  editor.onSubmit = (text: string): void => {
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
  let lastCatalog = driver.listCommands()
  let autocompleteProvider = new TuiAutocompleteProvider(lastCatalog, driver.cwd)
  editor.setAutocompleteProvider(autocompleteProvider)
  tui.addChild(editor)

  const statusline = new Text(driver.statusLine, 0, 0)
  tui.addChild(statusline)

  // Free ctrl+c from the editor's copy keybinding so the global listener
  // owns the quit path.
  getKeybindings().setUserBindings({ 'tui.input.copy': [] })

  // Global key handler — runs BEFORE editor dispatch. Printable text belongs to
  // the editor; this listener owns only overlays and global chords. Anything it
  // does not consume falls through to the focused editor.
  const removeInputListener = tui.addInputListener((data: string) => {
    const live = driver.state
    if (live.approval !== undefined) {
      if (data === '1' || data === 'y' || data === 'Y') driver.answerApproval(true)
      else if (data === '2' || data === 'n' || data === 'N' || matchesKey(data, Key.escape)) driver.answerApproval(false)
      return { consume: true }
    }
    if (live.question !== undefined) {
      const index = Number.parseInt(data, 10)
      const option = live.question.options[index - 1]
      if (option !== undefined) driver.answerQuestion(option)
      else if (matchesKey(data, Key.escape)) driver.answerQuestion(live.question.options[0] ?? '')
      return { consume: true }
    }
    if (matchesKey(data, 'shift+tab')) {
      driver.cyclePermissionMode()
      return { consume: true }
    }
    if (matchesKey(data, Key.ctrl('o'))) {
      driver.toggleThinking()
      return { consume: true }
    }
    if (matchesKey(data, Key.escape)) {
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
    transcript.setRows(state.rows, { thinkingExpanded: state.thinkingExpanded })

    queueLine.setText(
      state.queued.length === 0
        ? ''
        : state.queued.map(text => dim(`⏵ queued: ${text}`)).join('\n'),
    )
    queueLine.invalidate()

    overlays.clear()
    if (state.approval !== undefined) {
      overlays.addChild(createApprovalBox(state.approval))
    }
    if (state.question !== undefined) {
      overlays.addChild(createQuestionBox(state.question))
    }
    overlays.invalidate()

    // Refresh the autocomplete provider when the command catalog moves
    // (reference equality with the last-seen array). The driver keeps the
    // cached array stable across state emits until commands/change fires, so
    // this is a cheap guard that rebuilds only on an actual catalog change.
    const latestCatalog = driver.listCommands()
    if (latestCatalog !== lastCatalog) {
      lastCatalog = latestCatalog
      autocompleteProvider = new TuiAutocompleteProvider(latestCatalog, driver.cwd)
      editor.setAutocompleteProvider(autocompleteProvider)
    }

    statusline.setText(driver.statusLine)
    tui.requestRender()
  })

  tui.setFocus(editor)

  return {
    get tui() {
      return tui
    },
    editor,
    destroy() {
      removeInputListener()
      unsubscribe()
    },
  }
}
