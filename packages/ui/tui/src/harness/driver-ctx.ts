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
