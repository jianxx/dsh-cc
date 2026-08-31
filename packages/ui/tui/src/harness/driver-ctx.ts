/**
 * Driver cluster context: structural interface(s) that free-function
 * collaborators (harness/driver-*.ts) use instead of importing the createDriver
 * factory (which would be a cycle). This file is a type-only leaf — every new
 * cluster that migrates out of driver.ts grows a `*.Ctx` here.
 *
 * All TS-only; erased at runtime.
 * @module @jianxx/dsh-cc-tui/harness/driver-ctx
 */

import type { TuiState } from '../store.ts'
import type { ShellExecutorLike } from '../state/driver-types.ts'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'

/**
 * The slice of createDriver's closed-over state that `!` shell-command
 * execution needs. `state()` returns the CURRENT view-model value — createDriver
 * rebinds `state` on every emit, so collaborators must read it through a getter
 * rather than capturing a stale snapshot.
 */
export interface DriverBashCtx {
  /** Publish the next view-model value (rebinds createDriver's `state`). */
  emit(next: TuiState): void
  /** Read the current view-model value (fresh, not a snapshot). */
  state(): TuiState
  /** Working directory for fallback `/bin/sh -c` runs. */
  cwd: string
  /** Shell executor when mounted; undefined degrades to a direct child run. */
  shell: ShellExecutorLike | undefined
  /** Record a command in bash-mode history (dedup + cap + persist). */
  appendBashHistory(command: string): void
}

/**
 * The slice of createDriver's closed-over state that the modal pipeline
 * (approvals + questions sharing one FIFO) needs. `state()` returns the CURRENT
 * view-model value — createDriver rebinds `state` on every emit, so the modal
 * collaborator must read it through a getter rather than a stale snapshot.
 */
export interface DriverModalCtx {
  /** Publish the next view-model value (rebinds createDriver's `state`). */
  emit(next: TuiState): void
  /** Read the current view-model value (fresh, not a snapshot). */
  state(): TuiState
}

/**
 * The slice of createDriver's closed-over state that the plan/mode writepath
 * needs (driver-mode.ts). `state()` returns the CURRENT view-model value —
 * createDriver rebinds `state` on every emit, so the collaborator must read it
 * through a getter rather than a stale snapshot.
 */
export interface DriverModeCtx {
  /** Publish the next view-model value (rebinds createDriver's `state`). */
  emit(next: TuiState): void
  /** Read the current view-model value (fresh, not a snapshot). */
  state(): TuiState
  /** The rebindable agent holder (switchSession replaces it in place). */
  current: { agent: Agent }
  /** Plan-unit projector, when mounted. */
  projections: { stateOf(session: unknown, unit: string): unknown } | undefined
  /** Surface a transient notice line. */
  showNotice(text: string): void
  /** Run a bare /plan channel command. Late-bound (defined after this ctx). */
  runHarness(line: string): Promise<{ kind: string; text?: string } | undefined | null>
  /** Returns the mounted permission-rules engine's setMode seam, if any. */
  getRules(): PermissionRulesSeam | undefined
  /** Fold the current plan/permission mode (live, not a snapshot). */
  liveMode(agent: Agent, fallback: string): string
}

/** Duck-typed surface for the permission-rules engine's mode writepath. */
export interface PermissionRulesSeam {
  setMode(agent: Agent, mode: string): void
}

/**
 * The slice of createDriver's closed-over state that the statusline HUD /
 * sessionProjections feed needs (driver-hud.ts). `state()` returns the CURRENT
 * view-model value — createDriver rebinds `state` on every emit, so the
 * collaborator must read it through a getter rather than a stale snapshot.
 * `current` and `selection` are passed by reference (createDriver rebinds them
 * in place across switchSession), so the section always reads the live values.
 */
export interface DriverHudCtx {
  /** Publish the next view-model value (rebinds createDriver's `state`). */
  emit(next: TuiState): void
  /** Read the current view-model value (fresh, not a snapshot). */
  state(): TuiState
  /** Host context for the sessionProjections service lookup. */
  ctx: Context
  /** Working directory (process cwd, fallback for the branch probe). */
  cwd: string
  /** The rebindable agent holder (switchSession replaces it in place). */
  current: { agent: Agent }
  /** Model selection ref; statusline reads reasoningEffort/model from it. */
  selection: ModelSelectionRef
  /** Best-effort git-branch probe for the statusline footer. */
  branchProbe: (dir: string) => Promise<string | undefined>
}

/**
 * The slice of createDriver's closed-over state that the slash-command
 * catalog + subagent lifecycle section needs (driver-catalog.ts). `state()`
 * returns the CURRENT view-model value — createDriver rebinds `state` on every
 * emit, so the collaborator must read it through a getter rather than a stale
 * snapshot. `current` is the rebindable agent holder (list() reads the live
 * agent).
 */
export interface DriverCatalogCtx {
  /** Publish the next view-model value (rebinds createDriver's `state`). */
  emit(next: TuiState): void
  /** Read the current view-model value (fresh, not a snapshot). */
  state(): TuiState
  /** The rebindable agent holder (switchSession replaces it in place). */
  current: { agent: Agent }
  /** Host context for the commands service lookup + event subscriptions. */
  ctx: Context
}

/**
 * The slice of createDriver's closed-over state that the approval + user
 * question pipeline needs (driver-approvals.ts). The section owns the modal
 * FIFO (via createModalQueue) so approvals and questions share one queue.
 * `state()` returns the CURRENT view-model value — createDriver rebinds
 * `state` on every emit, so the collaborator must read it through a getter
 * rather than a stale snapshot.
 */
export interface DriverApprovalsCtx {
  /** Publish the next view-model value (rebinds createDriver's `state`). */
  emit(next: TuiState): void
  /** Read the current view-model value (fresh, not a snapshot). */
  state(): TuiState
  /** Host context: settings/userQuestions lookup + approval/request hook. */
  ctx: Context
  /** The rebindable agent holder (approval listener reads the live id). */
  current: { agent: Agent }
  /** Surface a transient notice line (rule-persist outcomes and failures). */
  showNotice(text: string): void
}
