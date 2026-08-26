/**
 * In-memory TUI view model. Session events fold into rows here; nothing
 * is written back to the durable log.
 * @module @jianxx/dsh-cc-tui/store
 */

import type { FileDiff } from './tool-card.ts'

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
  | { kind: 'status'; text: string }

export interface ApprovalView {
  toolName: string
  reason?: string
  command?: string
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
 * One session entry shown in the `/resume` picker. Mirrors the harness
 * persistence header but lives in the view layer (harness-import-free).
 */
export interface SessionEntryView {
  id: string
  cwd?: string
  createdAt: number
}

/**
 * Live view of the `/resume` session-switcher overlay: the session list
 * (newest-first), the focused index, a `switching` flag that dims input
 * while a switch is in flight, and the current session id so the renderer
 * can mark it with `●`.
 */
export interface SessionSwitcherView {
  sessions: readonly SessionEntryView[]
  focused: number
  switching: boolean
  currentId: string
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
}

export interface TuiState {
  rows: TranscriptRow[]
  draft: string
  busy: boolean
  permissionMode: string
  notice?: string
  approval?: ApprovalView
  question?: QuestionView
  modelPicker?: ModelPickerView
  sessionSwitcher?: SessionSwitcherView
  /** Texts submitted while the agent was busy (pending steering). */
  queued: readonly string[]
  /** Whether thinking rows render expanded (Ctrl+O). Collapsed by default. */
  thinkingExpanded: boolean
  /** Observed subagent runs (newest appended; capped at 20). */
  subagents: readonly SubagentRunView[]
  /** Statusline HUD (context %, token totals) from the projections feed. */
  hud?: HudView
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

/** Park a submitted text as pending steering while the agent is busy. */
export function enqueue(state: TuiState, text: string): TuiState {
  return { ...state, queued: [...state.queued, text] }
}

/**
 * Remove the FIRST queued entry strictly equal to `text`. No-op (returns the
 * same reference) when the text is absent — so the matching chip clears the
 * instant its durable `user/message` lands in the transcript.
 */
export function dequeue(state: TuiState, text: string): TuiState {
  const index = state.queued.findIndex(entry => entry === text)
  if (index < 0) return state
  const queued = state.queued.slice(0, index).concat(state.queued.slice(index + 1))
  return { ...state, queued }
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
  }
  return { ...state, hud: merged }
}
