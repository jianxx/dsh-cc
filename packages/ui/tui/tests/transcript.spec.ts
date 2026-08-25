import { describe, expect, it } from 'vitest'
import { createInitialState } from '@jianxx/dsh-cc-tui/store.ts'
import { applySessionEvent } from '@jianxx/dsh-cc-tui/transcript.ts'

describe('applySessionEvent', () => {
  it('appends user text and streams assistant deltas', () => {
    let state = createInitialState()
    state = applySessionEvent(state, { type: 'user/message', data: { text: 'hi' } })
    state = applySessionEvent(state, { type: 'assistant/chunk', data: { text: 'hel' } })
    state = applySessionEvent(state, { type: 'assistant/chunk', data: { text: 'lo' } })
    expect(state.rows).toEqual([
      { kind: 'user', text: 'hi' },
      { kind: 'assistant', text: 'hello' },
    ])
    expect(state.busy).toBe(true)
    state = applySessionEvent(state, { type: 'turn/end' })
    expect(state.busy).toBe(false)
  })

  it('updates a tool row in place from call to result', () => {
    let state = createInitialState()
    state = applySessionEvent(state, {
      type: 'tool/call',
      data: { callId: '1', name: 'bash', arguments: '{"command":"ls"}' },
    })
    state = applySessionEvent(state, {
      type: 'tool/result',
      data: { callId: '1', name: 'bash', text: 'ok' },
    })
    expect(state.rows).toHaveLength(1)
    expect(state.rows[0]).toMatchObject({
      kind: 'tool',
      callId: '1',
      running: false,
      title: 'bash',
      result: 'ok',
    })
  })

  it('uses presentCall/presentResult views when a presenter is supplied', () => {
    let state = createInitialState()
    const presenters = {
      presentCall: () => ({ card: 'terminal' as const, title: 'ls -la', cwd: '/tmp' }),
      presentResult: () => ({ card: 'terminal' as const, output: 'ok', exitCode: 0 }),
    }
    state = applySessionEvent(state, {
      type: 'tool/call',
      data: { callId: '1', name: 'Bash', arguments: '{"command":"ls -la"}' },
    }, presenters)
    expect(state.rows[0]).toMatchObject({ kind: 'tool', title: 'ls -la', body: 'cwd /tmp', running: true })
    state = applySessionEvent(state, {
      type: 'tool/result',
      data: { callId: '1', name: 'Bash', text: 'ok' },
    }, presenters)
    expect(state.rows[0]).toMatchObject({ kind: 'tool', title: 'ls -la', running: false, error: false })
    expect((state.rows[0] as { body?: string }).body).toContain('exit 0')
  })

  it('folds permission/mode and plan/mode into the footer', () => {
    let state = createInitialState()
    state = applySessionEvent(state, { type: 'permission/mode', data: { mode: 'acceptEdits' } })
    expect(state.permissionMode).toBe('acceptEdits')
    state = applySessionEvent(state, { type: 'plan/mode', data: { active: true } })
    expect(state.permissionMode).toBe('plan')
  })

  it('ignores unknown durable event types', () => {
    const state = createInitialState()
    expect(applySessionEvent(state, { type: 'made-up/event', data: {} })).toBe(state)
  })
})
