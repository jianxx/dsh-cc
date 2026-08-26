/**
 * Global composer key handling. The editor owns typing, backspace, and enter;
 * this module handles only overlay answers, permission cycling, interrupt,
 * and quit. Reads the live driver snapshot so keystrokes never land on a
 * stale closure.
 * @module @jianxx/dsh-cc-tui/input
 */

import { Key, decodeKittyPrintable, matchesKey } from '@jianxx/dsh-cc-pi-tui'
import type { TuiState } from './store.ts'

export interface InputSink {
  state: TuiState
  interrupt(): void
  cyclePermissionMode(): void
  toggleThinking(): void
  answerApproval(allowed: boolean): void
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
 * Apply one raw keypress against the live driver. Returns whether the app
 * should exit. Called from the pi-tui global input listener before the editor
 * receives the keystroke.
 */
export function handleComposerInput(driver: InputSink, data: string): InputAction {
  const live = driver.state

  if (live.approval !== undefined) {
    if (matchesKey(data, '1') || data === 'y' || data === 'Y') {
      driver.answerApproval(true)
    } else if (matchesKey(data, '2') || data === 'n' || data === 'N' || matchesKey(data, Key.escape)) {
      driver.answerApproval(false)
    }
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

  if (matchesKey(data, 'shift+tab')) {
    driver.cyclePermissionMode()
    return { kind: 'none' }
  }

  if (matchesKey(data, Key.ctrl('o'))) {
    driver.toggleThinking()
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
