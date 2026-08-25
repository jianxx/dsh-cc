/**
 * Fold a harness session-event envelope into the TUI store. UI-only: never
 * appends new durable event types.
 * @module @jianxx/dsh-cc-tui/transcript
 */

import {
  setBusy,
  setPermissionMode,
  upsertRow,
  type TuiState,
} from './store.ts'

/** Minimal session-event face the TUI understands. */
export interface SessionEventLike {
  readonly type: string
  readonly data?: unknown
}

function textOf(data: unknown): string {
  if (data === null || data === undefined) return ''
  if (typeof data === 'string') return data
  if (typeof data !== 'object') return String(data)
  const record = data as Record<string, unknown>
  if (typeof record.text === 'string') return record.text
  if (typeof record.message === 'string') return record.message
  if (typeof record.content === 'string') return record.content
  return ''
}

function callIdOf(data: unknown): string {
  if (data === null || typeof data !== 'object') return ''
  const record = data as Record<string, unknown>
  if (record.callId !== undefined) return String(record.callId)
  if (record.id !== undefined) return String(record.id)
  return ''
}

function nameOf(data: unknown): string {
  if (data === null || typeof data !== 'object') return 'tool'
  const record = data as Record<string, unknown>
  if (typeof record.name === 'string') return record.name
  if (typeof record.toolName === 'string') return record.toolName
  return 'tool'
}

function argsOf(data: unknown): string {
  if (data === null || typeof data !== 'object') return ''
  const record = data as Record<string, unknown>
  if (typeof record.arguments === 'string') return record.arguments
  if (record.arguments !== undefined) {
    try {
      return JSON.stringify(record.arguments)
    } catch {
      return String(record.arguments)
    }
  }
  return ''
}

function chunkKind(data: unknown): 'assistant' | 'thinking' {
  if (data === null || typeof data !== 'object') return 'assistant'
  const record = data as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : ''
  if (type.includes('reason') || type.includes('think')) return 'thinking'
  if (record.reasoning === true) return 'thinking'
  return 'assistant'
}

function chunkText(data: unknown): string {
  if (data === null || typeof data !== 'object') return textOf(data)
  const record = data as Record<string, unknown>
  if (typeof record.text === 'string') return record.text
  if (typeof record.delta === 'string') return record.delta
  if (record.delta !== null && typeof record.delta === 'object') {
    const delta = record.delta as Record<string, unknown>
    if (typeof delta.text === 'string') return delta.text
  }
  return textOf(data)
}

/**
 * Apply one session event to the view model.
 * @param state - current TUI state.
 * @param event - a `session/event` envelope.
 */
export function applySessionEvent(state: TuiState, event: SessionEventLike): TuiState {
  const data = event.data
  switch (event.type) {
    case 'user/message':
      return upsertRow(state, { kind: 'user', text: textOf(data) })
    case 'assistant/chunk': {
      const text = chunkText(data)
      if (text.length === 0) return setBusy(state, true)
      return setBusy(upsertRow(state, { kind: chunkKind(data), text }), true)
    }
    case 'assistant/message':
      return setBusy(state, false)
    case 'tool/call':
      return upsertRow(state, {
        kind: 'tool',
        callId: callIdOf(data),
        name: nameOf(data),
        args: argsOf(data),
        running: true,
      })
    case 'tool/result':
      return upsertRow(state, {
        kind: 'tool',
        callId: callIdOf(data),
        name: nameOf(data),
        args: '',
        result: textOf(data) || argsOf(data),
        error: data !== null && typeof data === 'object' && (data as { error?: unknown }).error !== undefined,
        running: false,
      })
    case 'turn/start':
      return setBusy(state, true)
    case 'turn/end':
    case 'agent/status': {
      const status = data !== null && typeof data === 'object'
        ? (data as { status?: string }).status
        : undefined
      if (event.type === 'agent/status' && status === 'running') return setBusy(state, true)
      return setBusy(state, false)
    }
    case 'permission/mode': {
      const mode = data !== null && typeof data === 'object'
        ? (data as { mode?: string }).mode
        : undefined
      return mode === undefined ? state : setPermissionMode(state, mode)
    }
    case 'plan/mode': {
      const active = data !== null && typeof data === 'object'
        ? (data as { active?: boolean }).active
        : undefined
      return active ? setPermissionMode(state, 'plan') : state
    }
    default:
      return state
  }
}
