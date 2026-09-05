/**
 * Pure payload builder for the custom status line: assembles the CC-shaped
 * JSON session object (§3.4 of the statusline plan) from a structural view of
 * live driver state. Only truthfully-sourced fields are emitted — absent
 * sources drop their field, and a sub-object with no known member is dropped
 * wholesale. `context_window.current_usage` has no truthful source (the
 * projection's context breakdown is role counts, not token buckets) and is
 * never emitted. Pure and total: no I/O, no clock, no driver imports.
 * @module @jianxx/dsh-cc-tui/harness/statusline-payload
 */

/** Structural view of the driver state the payload is built from. */
export type StatusLinePayloadView = {
  /**
   * Bundle version of dsh-cc (not a CC version). Optional as a pinned v1
   * omission: the TUI has no truthful runtime source for a bundle version, so
   * the wiring layer never supplies it (recorded as a manifest deviation).
   */
  version?: string
  /** Driver cwd at payload-fire time; the workspace/cwd fallback. */
  driverCwd?: string
  /** Session cwd (session.header.cwd). */
  sessionCwd?: string
  /** Driver project root. */
  projectDir?: string
  /** Session id. */
  sessionId?: string
  /** Transcript file path; absent when unlocatable. */
  transcriptPath?: string
  /** Selected model id (duplicated as display_name — no registry exists). */
  model?: string
  /** Selected reasoning effort. */
  effort?: string
  /** Active output style name, when readable. */
  outputStyleName?: string
  /** Worktree descriptor carried by the session, when present. */
  worktree?: { name?: string; path?: string; branch?: string }
  /** Git worktree name (mirrors the worktree descriptor's name). */
  gitWorktree?: string
  /** Uncached input-token total (the exceeds_200k decision input). */
  inputTokens?: number
  /** Output-token total. */
  outputTokens?: number
  /** Context window size in tokens. */
  contextWindowTokens?: number
  /** Projected context occupancy in tokens. */
  pressureTokens?: number
  /** Session creation timestamp (ms epoch); falls back to {@link bindTimeMs}. */
  sessionCreatedAtMs?: number
  /** Bind time of the runner (ms epoch) — the duration fallback clock base. */
  bindTimeMs: number
  /** Now (ms epoch) at payload-fire time. */
  nowMs: number
}

/** Whether a value is a finite number. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Drop keys whose value is `undefined`, then drop the object when empty. */
function compact(object: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) out[key] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Build the CC-shaped status-line payload from the view. Absent sources drop
 * their field; empty sub-objects are dropped wholesale; unknown extra keys are
 * never fabricated. Serialized structurally — the payload type stays open.
 */
export function buildStatusLinePayload(view: StatusLinePayloadView): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    cwd: view.sessionCwd ?? view.driverCwd,
    session_id: view.sessionId,
    transcript_path: view.transcriptPath,
    model: compact({
      id: view.model,
      display_name: view.model,
    }),
    workspace: compact({
      current_dir: view.sessionCwd ?? view.driverCwd,
      project_dir: view.projectDir,
      added_dirs: [],
      git_worktree: view.gitWorktree ?? view.worktree?.name,
    }),
    version: view.version,
    output_style: compact({ name: view.outputStyleName }),
    cost: compact({
      total_duration_ms: view.nowMs - (view.sessionCreatedAtMs ?? view.bindTimeMs),
    }),
    context_window: compact({
      total_input_tokens: view.inputTokens,
      total_output_tokens: view.outputTokens,
      context_window_size: view.contextWindowTokens,
      used_percentage: isFiniteNumber(view.pressureTokens) && isFiniteNumber(view.contextWindowTokens) && view.contextWindowTokens > 0
        ? (view.pressureTokens / view.contextWindowTokens) * 100
        : undefined,
      remaining_percentage: isFiniteNumber(view.pressureTokens) && isFiniteNumber(view.contextWindowTokens) && view.contextWindowTokens > 0
        ? 100 - (view.pressureTokens / view.contextWindowTokens) * 100
        : undefined,
    }),
    exceeds_200k_tokens: isFiniteNumber(view.inputTokens) && view.inputTokens > 200_000,
    effort: compact({ level: view.effort }),
    worktree: view.worktree === undefined ? undefined : compact(view.worktree),
  }
  return compact(payload) ?? {}
}
