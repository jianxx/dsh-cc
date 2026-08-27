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
  subscribe(listener: (state: TuiState) => void): () => void
  setDraft(draft: string): void
  submit(text?: string): Promise<void>
  interrupt(): void
  cyclePermissionMode(): void
  answerApproval(allowed: boolean): void
  answerQuestion(selected: string): void
  dispose(): Promise<void>
}
