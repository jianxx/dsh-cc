/**
 * Global composer key handling. The editor owns typing, backspace, and enter;
 * this module handles only overlay answers, permission cycling, interrupt,
 * and quit. Reads the live driver snapshot so keystrokes never land on a
 * stale closure.
 * @module @jianxx/dsh-cc-tui/input
 */

import { Key, matchesKey } from '@jianxx/dsh-cc-pi-tui'
import type { TuiState } from './store.ts'

export interface InputSink {
  state: TuiState
  interrupt(): void
  cyclePermissionMode(): void
  toggleThinking(): void
  answerApproval(allowed: boolean): void
  answerQuestion(selected: string): void
  dispose(): Promise<void>
}

export type InputAction =
  | { kind: 'none' }
  | { kind: 'quit' }

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
    const index = Number.parseInt(data, 10)
    const option = live.question.options[index - 1]
    if (option !== undefined) {
      driver.answerQuestion(option)
    } else if (matchesKey(data, Key.escape)) {
      driver.answerQuestion(live.question.options[0] ?? '')
    }
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
