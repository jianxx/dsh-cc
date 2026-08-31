/**
 * In-memory TUI view model. Session events fold into rows here; nothing
 * is written back to the durable log.
 * @module @jianxx/dsh-cc-tui/store
 */

import type { FileDiff } from './tool-card.ts'
import { VERBS, type TurnAnchor } from './working-line.ts'

export type TranscriptRow =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'thinking'; text: string }
  | {
    kind: 'tool'
    callId: string
    name: string
    args: string
    title: string
    body?: string
    result?: string
    error?: boolean
    running: boolean
    /** Structured file diffs from a presenter's diff-card view; rendered as hunks. */
    diffs?: readonly FileDiff[]
  }
  | {
    kind: 'status'
    text: string
    /**
     * Marks this status row as an error so the renderer paints it red instead
     * of dim. Set by `turn/end` error folding; plain status notices stay dim.
     */
    error?: boolean
  }

/**
 * Structured payload preview attached to an approval prompt, recovered from
 * the paired tool/call event: the shell command, the affected file diffs, or
 * the pretty-printed raw arguments. `none` degrades to tool name + reason.
 */
export type ApprovalPreview =
  | { kind: 'command'; command: string }
  | { kind: 'diff'; diffs: readonly FileDiff[] }
  | { kind: 'args'; json: string }
  | { kind: 'none' }

export interface ApprovalView {
  toolName: string
  reason?: string
  /** Structured payload preview for the call under review. */
  preview?: ApprovalPreview
  /** Modal entries waiting behind this one in the approval queue; absent for a lone head. */
  pendingCount?: number
}

export interface QuestionOptionView {
  label: string
  description?: string
}

/**
 * Live view of an ask-user-question prompt: the full first question item
 * (text, detail markdown, option descriptions, multiSelect, intent) plus the
 * interaction state the overlay mutates as the user navigates.
 */
export interface QuestionView {
  header: string
  /** The item's question text. */
  question: string
  /** Supporting detail (plan markdown for plan-review intents). */
  detail?: string
  options: readonly QuestionOptionView[]
  /** Whether more than one option may be selected. */
  multiSelect: boolean
  intent?: { kind: 'plan-review'; approve: string }
  /**
   * Focused row: an index into `options`, or `options.length` for the
   * trailing free-text ("Other") row.
   */
  focused: number
  /** Toggled labels (multiSelect) — single-select resolves on pick. */
  selected: readonly string[]
  /** Free-text buffer for the "Other" row. */
  custom: string
}

/**
 * One LLM adapter entry shown in the `/model` picker. Mirrors the harness
 * {@link CatalogEntry} but lives in the view layer (harness-import-free).
 */
export interface CatalogEntryView {
  provider: string
  id: string
  name: string
}

/**
 * Live view of the `/model` picker overlay: the catalog rows, the focused
 * index, and the active model route (if any) so the renderer can mark it.
 */
export interface ModelPickerView {
  entries: readonly CatalogEntryView[]
  focused: number
  current?: { provider: string; model: string }
}

/**
 * Live view of the `/effort` picker overlay: the reasoning-effort levels of
 * the active model plus the trailing reserved entry (the literal
 * `'default'`), the focused index, and the current effort (if any) so the
 * renderer can mark it. Plain strings — branding to `ReasoningEffortId`
 * happens at the driver's write seam.
 */
export interface EffortPickerView {
  entries: readonly string[]
  focused: number
  current: string | undefined
}

/**
 * One row in the `/permissions` picker. Mirrors the command package's
 * permission-mode option (`id`/`label`/`detail`) but lives in the view
 * layer so the overlay can render without importing the host surface.
 */
export interface PermissionPickerEntryView {
  id: string
  label: string
  detail: string
}

/**
 * Live view of the `/permissions` picker overlay: the five CC rule-engine
 * modes, the focused index, the current mode (so the renderer can mark it),
 * and an optional in-overlay confirmation step for `bypassPermissions`.
 */
export interface PermissionPickerView {
  entries: readonly PermissionPickerEntryView[]
  focused: number
  current: string
  confirmingBypass?: true
}

/**
 * One session entry shown in the `/resume` picker. Mirrors the harness
 * persistence header but lives in the view layer (harness-import-free).
 */
export interface SessionEntryView {
  id: string
  cwd?: string
  createdAt: number
  /** Last-activity mtime from persistence when the backend can observe it. */
  updatedAtMs?: number
  /** Async-decorated session title; absent until the title read lands. */
  title?: string
  /** Parent session id when this entry is a fork/child. */
  parentSession?: string
}

/**
 * Live view of the `/resume` session-switcher overlay: the filtered,
 * last-active-first session list, the focused index, a `switching` flag that
 * dims input while a switch is in flight, the current session id (marked
 * with `●`), the typed query filter, and the visibility scope. `sessions` is
 * the visible list only — the full list stays in the driver and
 * `totalCount` carries its length for the empty-cwd-scope hint.
 */
export interface SessionSwitcherView {
  sessions: readonly SessionEntryView[]
  focused: number
  switching: boolean
  currentId: string
  /** Free-text filter typed inside the picker ('' when none). */
  query: string
  /** Visibility scope: this project's cwd (default) or every project. */
  scope: 'cwd' | 'all'
  /** Length of the unfiltered list, for the "Tab to view all (N)" hint. */
  totalCount?: number
}

/**
 * One observed subagent run. `subagent/start` and `subagent/end` are global
 * (process-scoped) observe-only snapshots paired by `runId`; the driver
 * folds them into this view without calling `listChildren` — tracking is
 * event-only, so it stays composition-agnostic.
 */
export interface SubagentRunView {
  runId: string
  provider: string
  sessionId: string
  status: 'running' | 'done'
  /** Present once the `subagent/end` snapshot lands. */
  stopReason?: string
}

/**
 * Live statusline HUD fed by the sessionProjections change feed:
 * context-occupancy percent and cumulative token totals. Both fields are
 * optional — the footer omits whatever the current composition lacks.
 */
export interface HudView {
  /** Context occupancy, 0-100 integer; absent until a window is known. */
  contextPercent?: number
  /** Cumulative provider-reported token totals. */
  tokens?: { input: number; output: number }
  /**
   * Raw occupancy behind `contextPercent` for exact rendering. The numerator
   * is the projected token count — never back-derived from the rounded
   * percent. `window` is absent when the projection does not report one.
   */
  contextTokens?: { readonly used: number; readonly window?: number }
}

/**
 * One todo from the session's todo list. Mirrors the harness projection's
 * item shape but lives in the view layer (harness-import-free).
 */
export interface TodoItemView {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/**
 * Live view of the Ctrl+T todo panel overlay: only the interaction state the
 * panel mutates (the focused row index); the rows come from `state.todos`.
 */
export interface TodoPanelView {
  focused: number
}

/** Cumulative token usage across the four provider-reported buckets. */
export interface UsageTotalsView {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

/** Context composition by role: system prompt, tool output, messages. */
export interface UsageBreakdownView {
  system: number
  tools: number
  messages: number
}

/**
 * Live `/usage` panel content, folded from the tokenUsage, contextPressure,
 * and contextBreakdown projections. Every section is optional — the panel
 * degrades each missing one to a dim `n/a` independently.
 */
export interface UsageView {
  totals?: UsageTotalsView
  /** Context tokens currently projected into the window. */
  contextUsed?: number
  /** Context window size; absent when the projection does not report one. */
  contextWindow?: number
  breakdown?: UsageBreakdownView
}

/**
 * Marker for the open `/usage` panel overlay — pure display with no focus or
 * navigation state; the content comes from `state.usage`.
 */
export type UsagePanelView = Record<string, never>

export interface TuiState {
  rows: TranscriptRow[]
  draft: string
  busy: boolean
  /**
   * Anchor of the currently-running turn (drives the working line): absent
   * while idle. `busy` alone cannot back the line — it flips false on the
   * first assistant/message fold and jitters within a turn.
   */
  turn?: TurnAnchor
  permissionMode: string
  notice?: string
  approval?: ApprovalView
  question?: QuestionView
  modelPicker?: ModelPickerView
  /** Open `/effort` picker overlay; absent while closed. */
  effortPicker?: EffortPickerView
  /** Open `/permissions` picker overlay; absent while closed. */
  permissionPicker?: PermissionPickerView
  sessionSwitcher?: SessionSwitcherView
  /**
   * Outbox of texts submitted while the agent was busy: rendered as pending
   * chips, flushed into the next turn on durable `turn/end` (or injected
   * immediately via Ctrl+S). Idle submits bypass the outbox entirely.
   */
  queued: readonly string[]
  /** Whether thinking rows render expanded (Ctrl+O). Collapsed by default. */
  thinkingExpanded: boolean
  /**
   * Whether tool rows render their output (body/result/diffs) expanded
   * (Ctrl+O). Expanded by default — collapsing is opt-in via the toggle.
   */
  toolOutputExpanded: boolean
  /** Observed subagent runs (newest appended; capped at 20). */
  subagents: readonly SubagentRunView[]
  /** Statusline HUD (context %, token totals) from the projections feed. */
  hud?: HudView
  /** Session todo list (whole-list last-wins; absent before the first write). */
  todos?: readonly TodoItemView[]
  /** Open Ctrl+T todo panel; absent while closed. */
  todoPanel?: TodoPanelView
  /** Live usage snapshot (token totals, context occupancy, breakdown). */
  usage?: UsageView
  /** Open `/usage` panel; absent while closed. */
  usagePanel?: UsagePanelView
  /**
   * Timestamp (`Date.now()`) of the last idle Ctrl+C press — the anchor for
   * the double-press-to-exit window. Never cleared: a stale anchor simply
   * falls outside the window, so the next press starts a new attempt.
   */
  lastExitAttemptAt?: number
}

/** Empty composer + idle agent. */
export function createInitialState(permissionMode = 'default'): TuiState {
  return {
    rows: [],
    draft: '',
    busy: false,
    permissionMode,
    queued: [],
    thinkingExpanded: false,
    toolOutputExpanded: true,
    subagents: [],
  }
}

/**
 * Append or replace a transcript row. Tool rows with the same `callId` are
 * updated in place so start/result share one trail line.
 */
export function upsertRow(state: TuiState, row: TranscriptRow): TuiState {
  if (row.kind === 'tool') {
    const index = state.rows.findIndex(existing => existing.kind === 'tool' && existing.callId === row.callId)
    if (index >= 0) {
      const rows = state.rows.slice()
      rows[index] = row
      return { ...state, rows }
    }
  }
  if (row.kind === 'assistant' || row.kind === 'thinking') {
    const last = state.rows.at(-1)
    if (last?.kind === row.kind) {
      const rows = state.rows.slice()
      rows[rows.length - 1] = { ...row, text: last.text + row.text }
      return { ...state, rows }
    }
  }
  return { ...state, rows: [...state.rows, row] }
}

/** Replace the composer draft. */
export function setDraft(state: TuiState, draft: string): TuiState {
  return { ...state, draft }
}

/** Mark the agent busy or idle. */
export function setBusy(state: TuiState, busy: boolean): TuiState {
  return { ...state, busy }
}

/**
 * Anchor a newly-running turn for the working line: elapsed time counts from
 * `startedAt`, the output-token delta from `outputBase` (which may be
 * undefined when the HUD was not yet seeded — the driver's tokenUsage
 * rebase pins it later). `verbIndex` is derived deterministically from
 * `startedAt`, so re-anchoring with the same timestamp is snapshot-stable.
 * The anchor object is built fresh with no `stepStartedAt`, so anchoring a
 * new turn also clears the step clock; the pure baseline pin may pass the
 * existing `stepStartedAt` through (the driver's tokenUsage rebase does) so
 * pinning the baseline does not reset a mid-step clock.
 */
export function setTurnActive(
  state: TuiState,
  activity: { startedAt: number; outputBase: number | undefined; stepStartedAt?: number | undefined },
): TuiState {
  return {
    ...state,
    turn: {
      startedAt: activity.startedAt,
      outputBase: activity.outputBase,
      verbIndex: activity.startedAt % VERBS.length,
      ...activity.stepStartedAt === undefined ? {} : { stepStartedAt: activity.stepStartedAt },
    },
  }
}

/**
 * Reset the working line's step clock (new tool call, or tool finished and
 * the model is thinking again). Turn-modifying only: with no live turn this
 * returns the same state reference — an idle tool event must never conjure
 * a phantom anchor. Leaves startedAt/outputBase/verbIndex untouched.
 */
export function resetTurnStep(state: TuiState, at: number): TuiState {
  if (state.turn === undefined) return state
  return { ...state, turn: { ...state.turn, stepStartedAt: at } }
}

/** Clear the turn anchor (turn ended, interrupted, or session switched). */
export function clearTurn(state: TuiState): TuiState {
  const { turn: _dropped, ...rest } = state
  return rest
}

/** Record the live permission-mode footer. */
export function setPermissionMode(state: TuiState, permissionMode: string): TuiState {
  return { ...state, permissionMode }
}

/** Park or clear an approval prompt. */
export function setApproval(state: TuiState, approval: ApprovalView | undefined): TuiState {
  const { approval: _dropped, ...rest } = state
  return approval === undefined ? rest : { ...rest, approval }
}

/** Park or clear an ask-user prompt. */
export function setQuestion(state: TuiState, question: QuestionView | undefined): TuiState {
  const { question: _dropped, ...rest } = state
  return question === undefined ? rest : { ...rest, question }
}

/** Park or clear the `/model` picker overlay. */
export function setModelPicker(state: TuiState, picker: ModelPickerView | undefined): TuiState {
  const { modelPicker: _dropped, ...rest } = state
  return picker === undefined ? rest : { ...rest, modelPicker: picker }
}

/** Focus a model-picker row by index, clamped to [0, entries.length-1]. */
export function focusModelPicker(state: TuiState, index: number): TuiState {
  const picker = state.modelPicker
  if (picker === undefined || picker.entries.length === 0) return state
  const max = picker.entries.length - 1
  const focused = Math.max(0, Math.min(index, max))
  return setModelPicker(state, { ...picker, focused })
}

/** Move the model-picker focus by one row (clamped; no wrap). */
export function moveModelPickerFocus(state: TuiState, delta: -1 | 1): TuiState {
  const picker = state.modelPicker
  if (picker === undefined) return state
  return focusModelPicker(state, picker.focused + delta)
}

/** Park or clear the `/effort` picker overlay. */
export function setEffortPicker(state: TuiState, picker: EffortPickerView | undefined): TuiState {
  const { effortPicker: _dropped, ...rest } = state
  return picker === undefined ? rest : { ...rest, effortPicker: picker }
}

/** Focus an effort-picker row by index, clamped to [0, entries.length-1]. */
export function focusEffortPicker(state: TuiState, index: number): TuiState {
  const picker = state.effortPicker
  if (picker === undefined || picker.entries.length === 0) return state
  const max = picker.entries.length - 1
  const focused = Math.max(0, Math.min(index, max))
  return setEffortPicker(state, { ...picker, focused })
}

/** Move the effort-picker focus by one row (clamped; no wrap). */
export function moveEffortPickerFocus(state: TuiState, delta: -1 | 1): TuiState {
  const picker = state.effortPicker
  if (picker === undefined) return state
  return focusEffortPicker(state, picker.focused + delta)
}

/** Park or clear the `/permissions` picker overlay. */
export function setPermissionPicker(state: TuiState, picker: PermissionPickerView | undefined): TuiState {
  const { permissionPicker: _dropped, ...rest } = state
  return picker === undefined ? rest : { ...rest, permissionPicker: picker }
}

/**
 * Focus a permission-picker row by index, clamped to [0, entries.length-1].
 * Always drops `confirmingBypass` so the risk-gate flag cannot stick to a
 * non-bypass row after the user moves.
 */
export function focusPermissionPicker(state: TuiState, index: number): TuiState {
  const picker = state.permissionPicker
  if (picker === undefined || picker.entries.length === 0) return state
  const max = picker.entries.length - 1
  const focused = Math.max(0, Math.min(index, max))
  if (focused === picker.focused && picker.confirmingBypass === undefined) return state
  const { confirmingBypass: _dropped, ...rest } = picker
  return setPermissionPicker(state, { ...rest, focused })
}

/** Move the permission-picker focus by one row (clamped; no wrap). */
export function movePermissionPickerFocus(state: TuiState, delta: -1 | 1): TuiState {
  const picker = state.permissionPicker
  if (picker === undefined) return state
  return focusPermissionPicker(state, picker.focused + delta)
}

/** Park or clear the `/resume` session-switcher overlay. */
export function setSessionSwitcher(state: TuiState, switcher: SessionSwitcherView | undefined): TuiState {
  const { sessionSwitcher: _dropped, ...rest } = state
  return switcher === undefined ? rest : { ...rest, sessionSwitcher: switcher }
}

/** Focus a session-switcher row by index, clamped to [0, sessions.length-1]. */
export function focusSessionSwitcher(state: TuiState, index: number): TuiState {
  const sw = state.sessionSwitcher
  if (sw === undefined || sw.sessions.length === 0) return state
  const max = sw.sessions.length - 1
  const focused = Math.max(0, Math.min(index, max))
  return setSessionSwitcher(state, { ...sw, focused })
}

/** Move the session-switcher focus by one row (clamped; no wrap). */
export function moveSessionSwitcherFocus(state: TuiState, delta: -1 | 1): TuiState {
  const sw = state.sessionSwitcher
  if (sw === undefined) return state
  return focusSessionSwitcher(state, sw.focused + delta)
}

/** Focus a question row by index, clamped to [0, options.length]. */
export function focusQuestionOption(state: TuiState, index: number): TuiState {
  const question = state.question
  if (question === undefined) return state
  const focused = Math.max(0, Math.min(index, question.options.length))
  return setQuestion(state, { ...question, focused })
}

/** Move the question focus by one row (clamped; no wrap). */
export function moveQuestionFocus(state: TuiState, delta: -1 | 1): TuiState {
  const question = state.question
  if (question === undefined) return state
  return focusQuestionOption(state, question.focused + delta)
}

/**
 * Focus an option row and toggle its label in `selected` (multi-select).
 * Out-of-range indexes are a no-op returning the same state reference.
 */
export function toggleQuestionOption(state: TuiState, index: number): TuiState {
  const question = state.question
  if (question === undefined) return state
  const option = question.options[index]
  if (option === undefined) return state
  const selected = question.selected.includes(option.label)
    ? question.selected.filter(label => label !== option.label)
    : [...question.selected, option.label]
  return setQuestion(state, { ...question, focused: index, selected })
}

/** Append free text to the "Other" buffer and focus that row. */
export function typeQuestionText(state: TuiState, text: string): TuiState {
  const question = state.question
  if (question === undefined || text.length === 0) return state
  return setQuestion(state, {
    ...question,
    custom: question.custom + text,
    focused: question.options.length,
  })
}

/** Drop the last character of the "Other" buffer (keeps focus on that row). */
export function backspaceQuestionText(state: TuiState): TuiState {
  const question = state.question
  if (question === undefined || question.custom.length === 0) return state
  return setQuestion(state, {
    ...question,
    custom: question.custom.slice(0, -1),
    focused: question.options.length,
  })
}

/** Drop the transcript (local `/clear`). */
export function clearRows(state: TuiState): TuiState {
  const { notice: _dropped, ...rest } = state
  return { ...rest, rows: [] }
}

/** Set a one-line status notice. */
export function setNotice(state: TuiState, notice: string | undefined): TuiState {
  const { notice: _dropped, ...rest } = state
  return notice === undefined ? rest : { ...rest, notice }
}

/**
 * Record the moment of an idle Ctrl+C press (the double-press-to-exit window
 * anchor). Pure state evolution — the window comparison itself lives at the
 * input layer.
 */
export function markExitAttempt(state: TuiState, at: number): TuiState {
  return { ...state, lastExitAttemptAt: at }
}

/** Park a submitted text as pending steering while the agent is busy. */
export function enqueue(state: TuiState, text: string): TuiState {
  return { ...state, queued: [...state.queued, text] }
}

/**
 * Remove the FIRST queued entry strictly equal to `text`. No-op (returns the
 * same reference) when the text is absent. Kept for outbox bookkeeping and
 * tests — chip clearing in the live driver is synchronous (flush / Ctrl+S /
 * interrupt / recall), never event-driven.
 */
export function dequeue(state: TuiState, text: string): TuiState {
  const index = state.queued.findIndex(entry => entry === text)
  if (index < 0) return state
  const queued = state.queued.slice(0, index).concat(state.queued.slice(index + 1))
  return { ...state, queued }
}

/**
 * Remove and return the LAST queued entry — LIFO, so an editor recall hands
 * back the most recent submit. Same reference and `undefined` text on an
 * empty queue; callers treat that as "nothing to recall" and fall through.
 */
export function popQueued(state: TuiState): { state: TuiState; text: string | undefined } {
  if (state.queued.length === 0) return { state, text: undefined }
  return { state: { ...state, queued: state.queued.slice(0, -1) }, text: state.queued.at(-1) }
}

/** Drop every queued chip (e.g. on interrupt — matches cancel's inbox clear). */
export function clearQueue(state: TuiState): TuiState {
  if (state.queued.length === 0) return state
  return { ...state, queued: [] }
}

/** Flip the thinking-accordion expansion flag (Ctrl+O). */
export function toggleThinking(state: TuiState): TuiState {
  return { ...state, thinkingExpanded: !state.thinkingExpanded }
}

/**
 * Flip the global collapse state (Ctrl+O): everything expanded collapses,
 * anything else expands. Only the all-expanded state counts as "open" so the
 * toggle is a clean two-way switch between fully expanded and fully
 * collapsed, regardless of how the individual flags got there.
 */
export function toggleGlobalCollapse(state: TuiState): TuiState {
  const allExpanded = state.thinkingExpanded && state.toolOutputExpanded
  return {
    ...state,
    thinkingExpanded: !allExpanded,
    toolOutputExpanded: !allExpanded,
  }
}

/** Maximum subagent runs retained in state; oldest done drops first. */
const SUBAGENT_CAP = 20

/**
 * Drop entries from the front (oldest) until `runs` fits `cap`, preferring
 * to evict `done` runs before `running` ones. Mutates a copy; callers pass
 * the already-upserted list.
 */
function trimSubagents(runs: SubagentRunView[], cap: number): SubagentRunView[] {
  let result = runs
  while (result.length > cap) {
    const doneIndex = result.findIndex(run => run.status === 'done')
    const dropAt = doneIndex >= 0 ? doneIndex : 0
    result = result.slice(0, dropAt).concat(result.slice(dropAt + 1))
  }
  return result
}

/**
 * Append or update a subagent run by `runId` (start then end updates in
 * place). The list is capped at {@link SUBAGENT_CAP}: when over, the oldest
 * `done` entry drops first, then the oldest `running`.
 */
export function upsertSubagent(state: TuiState, view: SubagentRunView): TuiState {
  const index = state.subagents.findIndex(run => run.runId === view.runId)
  const next: SubagentRunView[] = index >= 0
    ? (() => {
      const updated = state.subagents.slice()
      updated[index] = view
      return updated
    })()
    : [...state.subagents, view]
  if (next.length === state.subagents.length && next.length <= SUBAGENT_CAP) {
    return { ...state, subagents: next }
  }
  return { ...state, subagents: trimSubagents(next, SUBAGENT_CAP) }
}

/** Count runs still in the `running` state (R5 statusline feed). */
export function countRunningSubagents(state: TuiState): number {
  return state.subagents.reduce((count, run) => count + (run.status === 'running' ? 1 : 0), 0)
}

/**
 * Merge a HUD patch into `state.hud` (fields left undefined keep their
 * current values), or clear the HUD entirely when `patch` is undefined.
 * Returns the same state reference when the clear finds nothing to drop.
 */
export function setHud(state: TuiState, patch: Partial<HudView> | undefined): TuiState {
  if (patch === undefined) {
    if (state.hud === undefined) return state
    const { hud: _dropped, ...rest } = state
    return rest
  }
  const base = state.hud ?? {}
  const merged: HudView = {
    ...base,
    ...patch.contextPercent === undefined ? {} : { contextPercent: patch.contextPercent },
    ...patch.tokens === undefined ? {} : { tokens: patch.tokens },
    ...patch.contextTokens === undefined ? {} : { contextTokens: patch.contextTokens },
  }
  return { ...state, hud: merged }
}

/**
 * Replace the session todo list (whole-list last-wins from the projection
 * feed), or clear it when `todos` is undefined. Returns the same state
 * reference when the clear finds nothing to drop.
 */
export function setTodos(state: TuiState, todos: readonly TodoItemView[] | undefined): TuiState {
  if (todos === undefined) {
    if (state.todos === undefined) return state
    const { todos: _dropped, ...rest } = state
    return rest
  }
  return { ...state, todos }
}

/** Park or clear the Ctrl+T todo panel overlay. */
export function setTodoPanel(state: TuiState, panel: TodoPanelView | undefined): TuiState {
  if (panel === undefined) {
    if (state.todoPanel === undefined) return state
    const { todoPanel: _dropped, ...rest } = state
    return rest
  }
  return { ...state, todoPanel: panel }
}

/** Open the todo panel, focused on the first row (empty list included). */
export function openTodoPanel(state: TuiState): TuiState {
  return setTodoPanel(state, { focused: 0 })
}

/** Close the todo panel. */
export function closeTodoPanel(state: TuiState): TuiState {
  return setTodoPanel(state, undefined)
}

/**
 * Move the todo-panel focus by one row, clamped to [0, todos.length-1]
 * (no wrap). A no-op when the panel is closed or the todo list is empty or
 * absent — those return the same state reference.
 */
export function moveTodoPanelFocus(state: TuiState, delta: -1 | 1): TuiState {
  const panel = state.todoPanel
  const todos = state.todos
  if (panel === undefined || todos === undefined || todos.length === 0) return state
  const max = todos.length - 1
  const focused = Math.max(0, Math.min(panel.focused + delta, max))
  if (focused === panel.focused) return state
  return setTodoPanel(state, { focused })
}

/**
 * Condense `state.todos` for the one-line strip: total count, completed
 * count, and the first in-progress content (`active`, omitted when nothing
 * is running). Undefined when there are no todos to show.
 */
export function todoSummary(state: TuiState): { total: number; done: number; active?: string } | undefined {
  const todos = state.todos
  if (todos === undefined || todos.length === 0) return undefined
  let done = 0
  let active: string | undefined
  for (const todo of todos) {
    if (todo.status === 'completed') done += 1
    else if (todo.status === 'in_progress' && active === undefined) active = todo.content
  }
  return { total: todos.length, done, ...active === undefined ? {} : { active } }
}

/**
 * Replace the live usage snapshot, or clear it when `usage` is undefined.
 * Returns the same state reference when the clear finds nothing to drop.
 */
export function setUsage(state: TuiState, usage: UsageView | undefined): TuiState {
  if (usage === undefined) {
    if (state.usage === undefined) return state
    const { usage: _dropped, ...rest } = state
    return rest
  }
  return { ...state, usage }
}

/** Open the `/usage` panel (a same-reference no-op when already open). */
export function openUsagePanel(state: TuiState): TuiState {
  if (state.usagePanel !== undefined) return state
  return { ...state, usagePanel: {} }
}

/** Close the `/usage` panel. */
export function closeUsagePanel(state: TuiState): TuiState {
  if (state.usagePanel === undefined) return state
  const { usagePanel: _dropped, ...rest } = state
  return rest
}
