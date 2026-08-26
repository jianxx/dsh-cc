/**
 * Fold a harness session-event envelope into the TUI store. UI-only: never
 * appends new durable event types.
 * @module @jianxx/dsh-cc-tui/transcript
 */

import {
  formatCallCard,
  formatResultCard,
  type ToolCallView,
  type ToolResultView,
} from './tool-card.ts'
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

/** Optional presenters looked up by tool name (agent-scoped registry). */
export interface ToolPresenters {
  presentCall?(name: string, args: unknown): ToolCallView | undefined
  presentResult?(name: string, args: unknown, result: { content: unknown; isError: boolean; meta?: unknown }): ToolResultView | undefined
}

function parseArgs(raw: string): unknown {
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function textOf(data: unknown): string {
  if (data === null || data === undefined) return ''
  if (typeof data === 'string') return data
  if (typeof data !== 'object') return String(data)
  const record = data as Record<string, unknown>
  if (typeof record.text === 'string') return record.text
  if (typeof record.message === 'string') return record.message
  if (typeof record.content === 'string') return record.content
  // UserMessage carries content as an array of typed blocks; concatenate the
  // text of every text block (ignore images and other non-text blocks).
  if (Array.isArray(record.content)) {
    return record.content
      .filter((block): block is { type: 'text'; text: string } =>
        block !== null && typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string')
      .map(block => block.text)
      .join('')
  }
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
  let record = data as Record<string, unknown>
  // The live agent emits assistant/chunk as {turn, step, chunk: <StreamChunk>};
  // unwrap the envelope so the chunk's own type classifies the row.
  if (record.chunk !== null && typeof record.chunk === 'object' && !Array.isArray(record.chunk)) {
    record = record.chunk as Record<string, unknown>
  }
  const type = typeof record.type === 'string' ? record.type : ''
  if (type.includes('reason') || type.includes('think')) return 'thinking'
  if (record.reasoning === true) return 'thinking'
  return 'assistant'
}

function chunkText(data: unknown): string {
  if (data === null || typeof data !== 'object') return textOf(data)
  let record = data as Record<string, unknown>
  // The live agent emits assistant/chunk as {turn, step, chunk: <StreamChunk>};
  // unwrap the envelope so the delta's text reaches the transcript.
  if (record.chunk !== null && typeof record.chunk === 'object' && !Array.isArray(record.chunk)) {
    record = record.chunk as Record<string, unknown>
  }
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
 * @param presenters - optional presentCall/presentResult lookup.
 */
export function applySessionEvent(
  state: TuiState,
  event: SessionEventLike,
  presenters?: ToolPresenters,
): TuiState {
  const data = event.data
  switch (event.type) {
    case 'user/message': {
      const text = textOf(data)
      // Suppress the duplicate optimistic row the driver appends at submit
      // time when the real user/message event arrives with the same text.
      const last = state.rows.at(-1)
      if (last?.kind === 'user' && last.text === text) return state
      return upsertRow(state, { kind: 'user', text })
    }
    case 'assistant/chunk': {
      const text = chunkText(data)
      if (text.length === 0) return setBusy(state, true)
      return setBusy(upsertRow(state, { kind: chunkKind(data), text }), true)
    }
    case 'assistant/message':
      return setBusy(state, false)
    case 'tool/call': {
      const name = nameOf(data)
      const args = argsOf(data)
      const view = presenters?.presentCall?.(name, parseArgs(args))
      const card = formatCallCard(view, { name, args })
      return upsertRow(state, {
        kind: 'tool',
        callId: callIdOf(data),
        name,
        args,
        title: card.title,
        ...card.body === undefined ? {} : { body: card.body },
        running: true,
      })
    }
    case 'tool/result': {
      const name = nameOf(data)
      const callId = callIdOf(data)
      const pending = state.rows.find(row => row.kind === 'tool' && row.callId === callId)
      const pendingTitle = pending?.kind === 'tool' ? pending.title : name
      const pendingArgs = pending?.kind === 'tool' ? pending.args : argsOf(data)
      const isError = data !== null && typeof data === 'object' && (data as { error?: unknown }).error !== undefined
      const fallback = textOf(data) || argsOf(data)
      const view = presenters?.presentResult?.(name, parseArgs(pendingArgs), {
        content: data,
        isError,
      })
      const card = formatResultCard(view, { pendingTitle, fallback, error: isError })
      return upsertRow(state, {
        kind: 'tool',
        callId,
        name,
        args: pendingArgs,
        title: card.title,
        ...card.body === undefined ? {} : { body: card.body, result: card.body },
        error: card.error,
        running: false,
      })
    }
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
