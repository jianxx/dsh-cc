/**
 * Structural Driver interface for UI components. Components import from here
 * (not from harness/driver.ts) so the boundary gate keeps harness imports
 * out of the view layer.
 * @module @jianxx/dsh-cc-tui/state/driver-types
 */

import type { TuiState } from '../store.ts'

export interface Driver {
  readonly state: TuiState
  readonly statusLine: string
  /** Session working directory, used for `@`-path completion. */
  readonly cwd: string
  /**
   * Persisted composer history (oldest→newest) loaded at boot from
   * `~/.dsh/tui/history.txt`. Seeds the editor's ↑/↓ recall; new prompts are
   * appended on submit (see {@link Driver.submit}). Read once at mount.
   */
  readonly promptHistory: readonly string[]
  subscribe(listener: (state: TuiState) => void): () => void
  setDraft(draft: string): void
  submit(text?: string): Promise<void>
  interrupt(): void
  cyclePermissionMode(): void
  toggleThinking(): void
  answerApproval(allowed: boolean): void
  /**
   * While a question overlay is open: move the focus one row across the
   * options and the trailing free-text ("Other") row.
   */
  questionMove(delta: -1 | 1): void
  /**
   * Activate the focused row: a multi-select question toggles the option in
   * `selected`; a single-select question resolves immediately with that
   * option's label; on the "Other" row a space is typed into the buffer.
   */
  questionToggle(): void
  /**
   * Jump to option `index` (0-based) and activate it — single-select
   * resolves, multi-select toggles. Out-of-range indexes are ignored. This is
   * the digit quick-pick path (keys 1-9).
   */
  questionPick(index: number): void
  /** Append free text to the "Other" buffer and focus that row. */
  questionType(text: string): void
  /** Edit the "Other" buffer (drops the last character). */
  questionBackspace(): void
  /**
   * Resolve the open question: the toggled labels for multi-select, or the
   * focused option when nothing is chosen and the buffer is empty; a
   * non-empty "Other" buffer is sent as `custom` (with an empty `selected`
   * when no option was picked).
   */
  questionSubmit(): void
  /** Dismiss the overlay resolving the first option (legacy escape behavior). */
  questionCancel(): void
  /**
   * Merged slash-command catalog: TUI-local commands first, then harness
   * commands (deduped by name, local wins). The array identity is stable
   * across calls until the catalog changes (so callers can detect a refresh
   * by reference equality).
   */
  listCommands(): readonly { name: string; description?: string; argumentHint?: string }[]
  dispose(): Promise<void>
}
