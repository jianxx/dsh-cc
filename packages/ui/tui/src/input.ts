/**
 * Global composer key handling. The editor owns typing, backspace, and enter;
 * this module handles only overlay answers, permission cycling, interrupt,
 * and quit. Reads the live driver snapshot so keystrokes never land on a
 * stale closure.
 * @module @jianxx/dsh-cc-tui/input
 */

import { Key, decodeKittyPrintable, matchesKey } from '@jianxx/dsh-cc-pi-tui'
import type { ApprovalAnswerKind } from './state/driver-types.ts'
import type { TuiState } from './store.ts'

export interface InputSink {
  state: TuiState
  interrupt(): void
  cyclePermissionMode(): void
  toggleThinking(): void
  answerApproval(kind: ApprovalAnswerKind): void
  questionMove(delta: -1 | 1): void
  questionToggle(): void
  questionPick(index: number): void
  questionType(text: string): void
  questionBackspace(): void
  questionSubmit(): void
  questionCancel(): void
  modelPickerMove(delta: -1 | 1): void
  modelPickerSubmit(): void
  modelPickerCancel(): void
  sessionSwitcherMove(delta: -1 | 1): void
  sessionSwitcherSubmit(): Promise<void>
  sessionSwitcherCancel(): void
  /** Toggle the Ctrl+T todo panel: close it when open, open it when closed. */
  toggleTodoPanel(): void
  /** Move the todo-panel focus by one row (clamped; no wrap). */
  todoPanelMove(delta: -1 | 1): void
  /** Close the todo panel. */
  todoPanelClose(): void
  /** Close the `/usage` panel. */
  usagePanelClose(): void
  dispose(): Promise<void>
}

export type InputAction =
  | { kind: 'none' }
  | { kind: 'quit' }

/**
 * Decode a raw keypress into the printable character it types, if any. Kitty
 * CSI-u / modifyOtherKeys sequences decode via the vendored helper; legacy
 * input arrives as the character itself.
 */
function printableOf(data: string): string | undefined {
  const decoded = decodeKittyPrintable(data)
  if (decoded !== undefined) return decoded
  if (data.length === 1) {
    const code = data.charCodeAt(0)
    if (code >= 32 && code !== 127) return data
  }
  return undefined
}

/**
 * Route one raw keypress into the open approval overlay: `1`/`y`/`Y` grant
 * once, `2`/`n`/`N`/escape reject, `3`/`a`/`A` grant always (once + persist a
 * derived allow rule). Every other key is consumed and ignored — the overlay
 * is modal and the composer editor must never see keystrokes while it is open.
 * Shared by the headless composer path and the mounted root listener so the
 * key map has a single source of truth.
 */
export function routeApprovalInput(driver: InputSink, data: string): void {
  if (matchesKey(data, '1') || data === 'y' || data === 'Y') {
    driver.answerApproval('once')
    return
  }
  if (matchesKey(data, '2') || data === 'n' || data === 'N' || matchesKey(data, Key.escape)) {
    driver.answerApproval('reject')
    return
  }
  if (matchesKey(data, '3') || data === 'a' || data === 'A') {
    driver.answerApproval('always')
    return
  }
  // All other keys consumed and ignored (modal).
}

/**
 * Route one raw keypress into the open question overlay. Every recognized
 * key is handled and every other input is dropped — the composer editor must
 * never see keystrokes while a question is open.
 */
export function routeQuestionInput(driver: InputSink, data: string): void {
  if (matchesKey(data, Key.escape)) {
    driver.questionCancel()
    return
  }
  if (matchesKey(data, Key.up)) {
    driver.questionMove(-1)
    return
  }
  if (matchesKey(data, Key.down)) {
    driver.questionMove(1)
    return
  }
  if (matchesKey(data, Key.enter)) {
    driver.questionSubmit()
    return
  }
  if (matchesKey(data, Key.backspace)) {
    driver.questionBackspace()
    return
  }
  if (matchesKey(data, Key.space)) {
    driver.questionToggle()
    return
  }
  if (data.length === 1 && data >= '1' && data <= '9') {
    // Digit quick-pick: the driver bounds-checks against the option list.
    driver.questionPick(Number.parseInt(data, 10) - 1)
    return
  }
  const printable = printableOf(data)
  if (printable !== undefined) driver.questionType(printable)
}

/**
 * Route one raw keypress into the open model picker. Only arrows, enter, and
 * escape are recognized; everything else is dropped — the picker is modal and
 * the composer editor must never see keystrokes while it is open.
 */
export function routeModelPickerInput(driver: InputSink, data: string): void {
  if (matchesKey(data, Key.escape)) {
    driver.modelPickerCancel()
    return
  }
  if (matchesKey(data, Key.up)) {
    driver.modelPickerMove(-1)
    return
  }
  if (matchesKey(data, Key.down)) {
    driver.modelPickerMove(1)
    return
  }
  if (matchesKey(data, Key.enter)) {
    driver.modelPickerSubmit()
    return
  }
  // All other keys are consumed and ignored (modal).
}

/**
 * Route one raw keypress into the open session switcher. Only arrows, enter,
 * and escape are recognized; everything else is dropped — the switcher is
 * modal and the composer editor must never see keystrokes while it is open.
 * While `switching` is true, every key is consumed without action.
 */
export function routeSessionSwitcherInput(driver: InputSink, data: string): void {
  if (driver.state.sessionSwitcher?.switching === true) return
  if (matchesKey(data, Key.escape)) {
    driver.sessionSwitcherCancel()
    return
  }
  if (matchesKey(data, Key.up)) {
    driver.sessionSwitcherMove(-1)
    return
  }
  if (matchesKey(data, Key.down)) {
    driver.sessionSwitcherMove(1)
    return
  }
  if (matchesKey(data, Key.enter)) {
    void driver.sessionSwitcherSubmit()
    return
  }
  // All other keys consumed and ignored (modal).
}

/**
 * Route one raw keypress into the open todo panel. Only arrows, escape, and
 * ctrl+t (toggle closed) are recognized; everything else is dropped — the
 * panel is modal and the composer editor must never see keystrokes while it
 * is open. Opening is owned by the ctrl+t binding in the global listener,
 * which only fires while the panel is closed.
 */
export function routeTodoPanelInput(driver: InputSink, data: string): void {
  if (matchesKey(data, Key.ctrl('t'))) {
    driver.todoPanelClose()
    return
  }
  if (matchesKey(data, Key.escape)) {
    driver.todoPanelClose()
    return
  }
  if (matchesKey(data, Key.up)) {
    driver.todoPanelMove(-1)
    return
  }
  if (matchesKey(data, Key.down)) {
    driver.todoPanelMove(1)
    return
  }
  // All other keys consumed and ignored (modal).
}

/**
 * Route one raw keypress into the open `/usage` panel. The panel is pure
 * display with no focus list, so escape closes it and every other key is
 * consumed and ignored — the composer editor must never see keystrokes while
 * it is open. Opening is owned by the `/usage` command.
 */
export function routeUsagePanelInput(driver: InputSink, data: string): void {
  if (matchesKey(data, Key.escape)) {
    driver.usagePanelClose()
    return
  }
  // All other keys consumed and ignored (modal, no navigation).
}

/**
 * Apply one raw keypress against the live driver. Returns whether the app
 * should exit. Called from the pi-tui global input listener before the editor
 * receives the keystroke.
 */
export function handleComposerInput(driver: InputSink, data: string): InputAction {
  const live = driver.state

  if (live.approval !== undefined) {
    routeApprovalInput(driver, data)
    return { kind: 'none' }
  }

  if (live.question !== undefined) {
    routeQuestionInput(driver, data)
    return { kind: 'none' }
  }

  if (live.modelPicker !== undefined) {
    routeModelPickerInput(driver, data)
    return { kind: 'none' }
  }

  if (live.sessionSwitcher !== undefined) {
    routeSessionSwitcherInput(driver, data)
    return { kind: 'none' }
  }

  if (live.todoPanel !== undefined) {
    routeTodoPanelInput(driver, data)
    return { kind: 'none' }
  }

  if (live.usagePanel !== undefined) {
    routeUsagePanelInput(driver, data)
    return { kind: 'none' }
  }

  if (matchesKey(data, 'shift+tab')) {
    driver.cyclePermissionMode()
    return { kind: 'none' }
  }

  if (matchesKey(data, Key.ctrl('o'))) {
    driver.toggleThinking()
    return { kind: 'none' }
  }

  if (matchesKey(data, Key.ctrl('t'))) {
    driver.toggleTodoPanel()
    return { kind: 'none' }
  }

  if (matchesKey(data, Key.escape)) {
    if (live.busy) driver.interrupt()
    return { kind: 'none' }
  }

  if (matchesKey(data, Key.ctrl('c'))) {
    void driver.dispose()
    return { kind: 'quit' }
  }

  return { kind: 'none' }
}
