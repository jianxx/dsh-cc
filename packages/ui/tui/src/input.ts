/**
 * Pure composer key handling. Reads the live driver snapshot so keystrokes
 * never land on a stale React closure.
 * @module @jianxx/dsh-cc-tui/input
 */

import { parseSlash } from './slash.ts'
import type { TuiState } from './store.ts'

export interface InputKey {
  return?: boolean
  escape?: boolean
  backspace?: boolean
  delete?: boolean
  tab?: boolean
  shift?: boolean
  ctrl?: boolean
  meta?: boolean
}

export interface InputSink {
  state: TuiState
  setDraft(draft: string): void
  submit(): Promise<void>
  interrupt(): void
  cyclePermissionMode(): void
  answerApproval(allowed: boolean): void
  answerQuestion(selected: string): void
  dispose(): Promise<void>
}

export type InputAction =
  | { kind: 'none' }
  | { kind: 'quit' }

/**
 * Apply one keypress against the live driver. Returns whether the app should exit.
 */
export function handleComposerInput(
  driver: InputSink,
  input: string,
  key: InputKey,
): InputAction {
  const live = driver.state
  if (live.approval !== undefined) {
    if (input === '1' || input === 'y' || input === 'Y') driver.answerApproval(true)
    else if (input === '2' || input === 'n' || input === 'N' || key.escape === true) driver.answerApproval(false)
    return { kind: 'none' }
  }
  if (live.question !== undefined) {
    const index = Number.parseInt(input, 10)
    const option = live.question.options[index - 1]
    if (option !== undefined) driver.answerQuestion(option)
    else if (key.escape === true) driver.answerQuestion(live.question.options[0] ?? '')
    return { kind: 'none' }
  }
  if (key.tab === true && key.shift === true) {
    driver.cyclePermissionMode()
    return { kind: 'none' }
  }
  if (key.escape === true) {
    if (live.busy) driver.interrupt()
    return { kind: 'none' }
  }
  if (key.return === true || input === '\r' || input === '\n') {
    const parsed = parseSlash(live.draft)
    void driver.submit()
    if (parsed.kind === 'local' && (parsed.name === 'quit' || parsed.name === 'exit')) {
      return { kind: 'quit' }
    }
    return { kind: 'none' }
  }
  if (key.backspace === true || key.delete === true) {
    driver.setDraft(live.draft.slice(0, -1))
    return { kind: 'none' }
  }
  if (input === 'c' && key.ctrl === true) {
    void driver.dispose()
    return { kind: 'quit' }
  }
  if (input.length > 0 && key.ctrl !== true && key.meta !== true) {
    driver.setDraft(live.draft + input)
  }
  return { kind: 'none' }
}
