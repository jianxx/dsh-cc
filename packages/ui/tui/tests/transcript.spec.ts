import { describe, expect, it } from 'vitest'
import { createInitialState, enqueue } from '@jianxx/dsh-cc-tui/store.ts'
import { applySessionEvent } from '@jianxx/dsh-cc-tui/transcript.ts'

describe('applySessionEvent', () => {
  it('appends user text and streams assistant deltas', () => {
    let state = createInitialState()
    state = applySessionEvent(state, { type: 'user/message', data: { text: 'hi', source: { kind: 'user' } } })
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

  it('unwraps the live {turn, step, chunk} assistant/chunk envelope', () => {
    let state = createInitialState()
    state = applySessionEvent(state, { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { blockType: 'text', index: 0, type: 'block-start' } } })
    expect(state.busy).toBe(true)
    state = applySessionEvent(state, { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { index: 0, text: 'MOCK OK', type: 'text-delta' } } })
    expect(state.rows).toContainEqual({ kind: 'assistant', text: 'MOCK OK' })
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

  it('extracts text from a UserMessage content-block array', () => {
    let state = createInitialState()
    state = applySessionEvent(state, {
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'hi there' }], source: { kind: 'user' } },
    })
    expect(state.rows).toEqual([{ kind: 'user', text: 'hi there' }])
  })

  it('concatenates only text blocks from mixed UserMessage content', () => {
    let state = createInitialState()
    state = applySessionEvent(state, {
      type: 'user/message',
      data: {
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image', attachment: {} as never },
          { type: 'text', text: ' world' },
        ],
        source: { kind: 'user' },
      },
    })
    expect(state.rows).toEqual([{ kind: 'user', text: 'hello world' }])
  })

  it('removes the matching queued entry when a user/message lands', () => {
    let state = createInitialState()
    state = enqueue(state, 'hello')
    state = enqueue(state, 'still here')
    expect(state.queued).toEqual(['hello', 'still here'])
    state = applySessionEvent(state, { type: 'user/message', data: { text: 'hello', source: { kind: 'user' } } })
    expect(state.queued).toEqual(['still here'])
    expect(state.rows).toEqual([{ kind: 'user', text: 'hello' }])
  })

  it('leaves non-matching queued entries untouched on user/message', () => {
    let state = createInitialState()
    state = enqueue(state, 'pending')
    state = applySessionEvent(state, { type: 'user/message', data: { text: 'other', source: { kind: 'user' } } })
    expect(state.queued).toEqual(['pending'])
    expect(state.rows).toEqual([{ kind: 'user', text: 'other' }])
  })

  describe('user/message source routing', () => {
    const CLAUDE_MD = [
      '<system-reminder>',
      '# Workspace instructions',
      ...Array.from({ length: 40 }, (_, i) => `Rule ${i}: filler CLAUDE.md line`),
      '</system-reminder>',
    ].join('\n')

    it('renders a user row for human input (kind user)', () => {
      let state = createInitialState()
      state = applySessionEvent(state, {
        type: 'user/message',
        data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } },
      })
      expect(state.rows).toEqual([{ kind: 'user', text: 'hi' }])
    })

    it('hides plugin-injected instructions (CLAUDE.md payload)', () => {
      const state = createInitialState()
      const next = applySessionEvent(state, {
        type: 'user/message',
        data: {
          content: [{ type: 'text', text: CLAUDE_MD }],
          source: { kind: 'plugin', plugin: 'workspace-instructions', form: 'instructions' },
        },
      })
      expect(next).toBe(state)
    })

    it('hides a plugin-injected skill catalog', () => {
      const state = createInitialState()
      const next = applySessionEvent(state, {
        type: 'user/message',
        data: {
          content: [{ type: 'text', text: 'The following skills are available: find-docs, lark-im…' }],
          source: { kind: 'plugin', plugin: 'skills', form: 'catalog' },
        },
      })
      expect(next).toBe(state)
    })

    it('hides a plugin-injected runtime-context snapshot', () => {
      const state = createInitialState()
      const next = applySessionEvent(state, {
        type: 'user/message',
        data: {
          content: [{ type: 'text', text: 'Current runtime context: today is 2026-08-26.' }],
          source: {
            kind: 'plugin',
            plugin: 'runtime-context',
            form: 'snapshot',
            sections: [{ name: 'date', text: 'today is 2026-08-26' }],
          },
        },
      })
      expect(next).toBe(state)
    })

    it('renders a notice form as exactly one dim status row with its summary', () => {
      let state = createInitialState()
      state = applySessionEvent(state, {
        type: 'user/message',
        data: {
          content: [{ type: 'text', text: 'Elided compaction detail:\n' + CLAUDE_MD }],
          source: { kind: 'plugin', plugin: 'compaction', form: 'notice', summary: 'Compacted 12 messages' },
        },
      })
      expect(state.rows).toEqual([{ kind: 'status', text: 'Compacted 12 messages' }])
    })

    it('hides a notice form without a string summary', () => {
      const state = createInitialState()
      const next = applySessionEvent(state, {
        type: 'user/message',
        data: {
          content: [{ type: 'text', text: CLAUDE_MD }],
          source: { kind: 'plugin', plugin: 'compaction', form: 'notice' },
        },
      })
      expect(next).toBe(state)
    })

    it('hides a relay-form plugin message', () => {
      const state = createInitialState()
      const next = applySessionEvent(state, {
        type: 'user/message',
        data: {
          content: [{ type: 'text', text: 'relayed subagent chatter' }],
          source: { kind: 'plugin', plugin: 'subagent', form: 'relay' },
        },
      })
      expect(next).toBe(state)
    })

    it('hides a plugin message with no form', () => {
      const state = createInitialState()
      const next = applySessionEvent(state, {
        type: 'user/message',
        data: {
          content: [{ type: 'text', text: CLAUDE_MD }],
          source: { kind: 'plugin', plugin: 'workspace-instructions' },
        },
      })
      expect(next).toBe(state)
    })

    it('hides tool-sourced user messages', () => {
      const state = createInitialState()
      const next = applySessionEvent(state, {
        type: 'user/message',
        data: {
          content: [{ type: 'text', text: 'tool_result body' }],
          source: { kind: 'tool' },
        },
      })
      expect(next).toBe(state)
    })

    it('hides messages with a missing source', () => {
      const state = createInitialState()
      const next = applySessionEvent(state, {
        type: 'user/message',
        data: { content: [{ type: 'text', text: CLAUDE_MD }] },
      })
      expect(next).toBe(state)
    })

    it('hides messages with an unknown source kind', () => {
      const state = createInitialState()
      const next = applySessionEvent(state, {
        type: 'user/message',
        data: {
          content: [{ type: 'text', text: CLAUDE_MD }],
          source: { kind: 'time-travel' },
        },
      })
      expect(next).toBe(state)
    })

    it('adds no row for kind user with no text blocks but still dequeues', () => {
      let state = createInitialState()
      state = enqueue(state, '')
      expect(state.queued).toEqual([''])
      state = applySessionEvent(state, {
        type: 'user/message',
        data: {
          content: [{ type: 'image', attachment: {} as never }],
          source: { kind: 'user' },
        },
      })
      expect(state.queued).toEqual([])
      expect(state.rows).toEqual([])
    })

    it('adds no row for kind user with whitespace-only text but still dequeues', () => {
      let state = createInitialState()
      state = enqueue(state, '   ')
      state = applySessionEvent(state, {
        type: 'user/message',
        data: { content: [{ type: 'text', text: '   ' }], source: { kind: 'user' } },
      })
      expect(state.queued).toEqual([])
      expect(state.rows).toEqual([])
    })
  })

  describe('diff card propagation', () => {
    it('stores diffs on the tool row when presentCall returns a diff card', () => {
      let state = createInitialState()
      const presenters = {
        presentCall: () => ({
          card: 'diff' as const,
          title: 'Edit foo.ts',
          diffs: [{ path: 'foo.ts', oldText: 'a\n', newText: 'b\n' }],
        }),
      }
      state = applySessionEvent(state, {
        type: 'tool/call',
        data: { callId: '1', name: 'Edit', arguments: '{"path":"foo.ts"}' },
      }, presenters)
      const row = state.rows[0]
      expect(row).toMatchObject({ kind: 'tool', callId: '1', title: 'Edit foo.ts', running: true })
      expect((row as { diffs?: unknown }).diffs).toEqual([
        { path: 'foo.ts', oldText: 'a\n', newText: 'b\n' },
      ])
    })

    it('stores diffs on the tool row when presentResult returns a diff card', () => {
      let state = createInitialState()
      const diffs = [{ path: 'bar.ts', oldText: null, newText: 'hi\n' }]
      const presenters = {
        presentCall: () => ({ card: 'diff' as const, title: 'Write bar.ts', diffs }),
        presentResult: () => ({ card: 'diff' as const, title: 'Wrote bar.ts', diffs }),
      }
      state = applySessionEvent(state, {
        type: 'tool/call',
        data: { callId: '2', name: 'Write', arguments: '{"path":"bar.ts"}' },
      }, presenters)
      state = applySessionEvent(state, {
        type: 'tool/result',
        data: { callId: '2', name: 'Write', text: 'ok' },
      }, presenters)
      const row = state.rows[0]
      expect(row).toMatchObject({ kind: 'tool', callId: '2', running: false })
      expect((row as { diffs?: unknown }).diffs).toEqual(diffs)
    })

    it('leaves diffs undefined when the presenter returns a non-diff card', () => {
      let state = createInitialState()
      const presenters = {
        presentCall: () => ({ card: 'terminal' as const, title: 'ls', cwd: '/tmp' }),
      }
      state = applySessionEvent(state, {
        type: 'tool/call',
        data: { callId: '3', name: 'Bash', arguments: '{"command":"ls"}' },
      }, presenters)
      const row = state.rows[0]
      expect((row as { diffs?: unknown }).diffs).toBeUndefined()
    })
  })

  it('ignores unknown durable event types', () => {
    const state = createInitialState()
    expect(applySessionEvent(state, { type: 'made-up/event', data: {} })).toBe(state)
  })

  describe('tool-call-delta streaming', () => {
    it('creates a pending tool row from a single tool-call-delta chunk', () => {
      let state = createInitialState()
      state = applySessionEvent(state, {
        type: 'assistant/chunk',
        data: { turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'bash', argumentsDelta: '{"command":"ls"}' } },
      })
      expect(state.rows).toHaveLength(1)
      expect(state.rows[0]).toMatchObject({
        kind: 'tool',
        callId: 'call-1',
        name: 'bash',
        args: '{"command":"ls"}',
        title: 'bash',
        running: true,
      })
      expect(state.busy).toBe(true)
    })

    it('accumulates tool-call-delta args in place by callId', () => {
      let state = createInitialState()
      state = applySessionEvent(state, {
        type: 'assistant/chunk',
        data: { turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'bash', argumentsDelta: '{"command":' } },
      })
      state = applySessionEvent(state, {
        type: 'assistant/chunk',
        data: { turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 0, id: 'call-1', argumentsDelta: '"ls -la"}' } },
      })
      expect(state.rows).toHaveLength(1)
      expect(state.rows[0]).toMatchObject({
        kind: 'tool',
        callId: 'call-1',
        name: 'bash',
        args: '{"command":"ls -la"}',
        running: true,
      })
    })

    it('accumulates interleaved tool-call-deltas independently per callId', () => {
      let state = createInitialState()
      state = applySessionEvent(state, {
        type: 'assistant/chunk',
        data: { turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 0, id: 'call-a', name: 'bash', argumentsDelta: '{"a":' } },
      })
      state = applySessionEvent(state, {
        type: 'assistant/chunk',
        data: { turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 1, id: 'call-b', name: 'grep', argumentsDelta: '{"b":' } },
      })
      state = applySessionEvent(state, {
        type: 'assistant/chunk',
        data: { turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 0, id: 'call-a', argumentsDelta: '1}' } },
      })
      state = applySessionEvent(state, {
        type: 'assistant/chunk',
        data: { turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 1, id: 'call-b', argumentsDelta: '2}' } },
      })
      expect(state.rows).toHaveLength(2)
      expect(state.rows[0]).toMatchObject({ kind: 'tool', callId: 'call-a', args: '{"a":1}' })
      expect(state.rows[1]).toMatchObject({ kind: 'tool', callId: 'call-b', args: '{"b":2}' })
    })

    it('replaces a streamed tool row with the presenter card on durable tool/call', () => {
      let state = createInitialState()
      state = applySessionEvent(state, {
        type: 'assistant/chunk',
        data: { turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'Bash', argumentsDelta: '{"command":"ls' } },
      })
      state = applySessionEvent(state, {
        type: 'assistant/chunk',
        data: { turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 0, id: 'call-1', argumentsDelta: ' -la"}' } },
      })
      const presenters = {
        presentCall: () => ({ card: 'terminal' as const, title: 'ls -la', cwd: '/tmp' }),
        presentResult: () => ({ card: 'terminal' as const, output: 'ok', exitCode: 0 }),
      }
      state = applySessionEvent(state, {
        type: 'tool/call',
        data: { callId: 'call-1', name: 'Bash', arguments: '{"command":"ls -la"}' },
      }, presenters)
      expect(state.rows).toHaveLength(1)
      expect(state.rows[0]).toMatchObject({
        kind: 'tool',
        callId: 'call-1',
        title: 'ls -la',
        body: 'cwd /tmp',
        running: true,
      })
    })

    it('finalizes a streamed tool row on durable tool/result', () => {
      let state = createInitialState()
      const presenters = {
        presentCall: () => ({ card: 'terminal' as const, title: 'ls -la', cwd: '/tmp' }),
        presentResult: () => ({ card: 'terminal' as const, output: 'done', exitCode: 0 }),
      }
      state = applySessionEvent(state, {
        type: 'assistant/chunk',
        data: { turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'Bash', argumentsDelta: '{"command":"ls -la"}' } },
      })
      state = applySessionEvent(state, {
        type: 'tool/call',
        data: { callId: 'call-1', name: 'Bash', arguments: '{"command":"ls -la"}' },
      }, presenters)
      state = applySessionEvent(state, {
        type: 'tool/result',
        data: { callId: 'call-1', name: 'Bash', text: 'done' },
      }, presenters)
      expect(state.rows).toHaveLength(1)
      expect(state.rows[0]).toMatchObject({ kind: 'tool', callId: 'call-1', running: false, error: false })
      expect((state.rows[0] as { body?: string }).body).toContain('exit 0')
    })

    it('ignores a tool-call-delta arriving after the row was finalized by tool/result', () => {
      let state = createInitialState()
      state = applySessionEvent(state, {
        type: 'tool/call',
        data: { callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
      })
      state = applySessionEvent(state, {
        type: 'tool/result',
        data: { callId: 'call-1', name: 'bash', text: 'ok' },
      })
      const before = state.rows[0]
      state = applySessionEvent(state, {
        type: 'assistant/chunk',
        data: { turn: 1, step: 1, chunk: { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'bash', argumentsDelta: 'garbage' } },
      })
      expect(state.rows).toHaveLength(1)
      expect(state.rows[0]).toBe(before)
      expect(state.rows[0]).toMatchObject({ kind: 'tool', callId: 'call-1', running: false, result: 'ok' })
    })
  })
})
