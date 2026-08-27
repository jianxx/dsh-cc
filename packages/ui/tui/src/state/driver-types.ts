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
  subscribe(listener: (state: TuiState) => void): () => void
  setDraft(draft: string): void
  submit(text?: string): Promise<void>
  interrupt(): void
  cyclePermissionMode(): void
  toggleThinking(): void
  answerApproval(allowed: boolean): void
  answerQuestion(selected: string): void
  /**
   * Merged slash-command catalog: TUI-local commands first, then harness
   * commands (deduped by name, local wins). The array identity is stable
   * across calls until the catalog changes (so callers can detect a refresh
   * by reference equality).
   */
  listCommands(): readonly { name: string; description?: string; argumentHint?: string }[]
  dispose(): Promise<void>
}
