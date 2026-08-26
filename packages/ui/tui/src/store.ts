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

export interface QuestionView {
  header: string
  options: readonly string[]
}

export interface TuiState {
  rows: TranscriptRow[]
  draft: string
  busy: boolean
  permissionMode: string
  notice?: string
  approval?: ApprovalView
  question?: QuestionView
  /** Texts submitted while the agent was busy (pending steering). */
  queued: readonly string[]
}

/** Empty composer + idle agent. */
export function createInitialState(permissionMode = 'default'): TuiState {
  return {
    rows: [],
    draft: '',
    busy: false,
    permissionMode,
    queued: [],
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
