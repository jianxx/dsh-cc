/**
 * Structural Driver interface for UI components. Components import from here
 * (not from harness/driver.ts) so the boundary gate keeps harness imports
 * out of the view layer.
 * @module @jianxx/dsh-cc-tui/state/driver-types
 */

import type { CatalogEntry } from '../model-catalog.ts'
import type { TuiState } from '../store.ts'

export interface Driver {
  readonly state: TuiState
  readonly statusLine: string
  /**
   * Width-aware status line: same content as {@link Driver.statusLine}, but
   * the parenthetical context detail is omitted when the line would not fit
   * `width` columns. Without a width the full line is returned.
   */
  statusLineIn(width?: number): string
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
   * Open the `/model` picker overlay: loads the catalog, parks `modelPicker`
   * state focused on the current route, or falls back to the status-row
   * notice when the catalog is empty. The arg path (`/model <n|provider/id>`)
   * bypasses the overlay and stays scriptable.
   */
  openModelPicker(): Promise<void>
  /** Move the model-picker focus by one row (clamped; no wrap). */
  modelPickerMove(delta: -1 | 1): void
  /** Select the focused entry, close the overlay, and emit the status row. */
  modelPickerSubmit(): void
  /** Close the overlay without changing the selection. */
  modelPickerCancel(): void
  /**
   * Open the `/resume` session-switcher overlay: loads the session list
   * (newest-first), parks `sessionSwitcher` state focused on the current
   * session, or falls back to a status-row notice when no sessions exist.
   * The arg path (`/resume <id>`) bypasses the overlay and switches directly.
   */
  openSessionSwitcher(): Promise<void>
  /** Move the session-switcher focus by one row (clamped; no wrap). */
  sessionSwitcherMove(delta: -1 | 1): void
  /** Switch to the focused session (await {@link Driver.switchSession}) and close the overlay. */
  sessionSwitcherSubmit(): Promise<void>
  /** Close the overlay without switching. */
  sessionSwitcherCancel(): void
  /**
   * Toggle the Ctrl+T todo panel: open it focused on the first row when
   * closed (rendering a placeholder when the session has no todos), or close
   * it when open. Pure store evolution — no harness calls.
   */
  toggleTodoPanel(): void
  /** Move the todo-panel focus by one row (clamped; no wrap). */
  todoPanelMove(delta: -1 | 1): void
  /** Close the todo panel. */
  todoPanelClose(): void
  /**
   * Switch the live agent to a different persisted session in-process: dispose
   * the current handle, resume the target, replay its history through the same
   * fold the boot path uses, and reset the transcript. No-op when `id` matches
   * the current session. On failure the old session stays bound and a notice
   * is emitted.
   */
  switchSession(id: string): Promise<void>
  /** List persisted sessions (newest-first absent — the caller sorts). */
  listSessions(): Promise<readonly { id: string; cwd?: string; createdAt: number }[]>
  /**
   * Live LLM model catalog (`provider`/`id`/`name` per advertised model), the
   * same list `/model` resolves its argument against. Used by slash argument
   * completion; fetched per call so it never goes stale.
   */
  loadModelCatalog(): Promise<readonly CatalogEntry[]>
  /**
   * Merged slash-command catalog: TUI-local commands first, then harness
   * commands (deduped by name, local wins). The array identity is stable
   * across calls until the catalog changes (so callers can detect a refresh
   * by reference equality).
   */
  listCommands(): readonly { name: string; description?: string; argumentHint?: string }[]
  dispose(): Promise<void>
}
