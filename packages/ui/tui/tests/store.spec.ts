import { describe, expect, it } from 'vitest'
import {
  clearQueue,
  createInitialState,
  dequeue,
  enqueue,
  type TuiState,
} from '@jianxx/dsh-cc-tui/store.ts'

describe('queue helpers', () => {
  it('enqueue appends to the queue', () => {
    const state = enqueue(createInitialState(), 'hello')
    expect(state.queued).toEqual(['hello'])
  })

  it('enqueue preserves prior entries (FIFO order)', () => {
    let state = createInitialState()
    state = enqueue(state, 'one')
    state = enqueue(state, 'two')
    expect(state.queued).toEqual(['one', 'two'])
  })

  it('dequeue removes the FIRST entry strictly equal to the text', () => {
    let state = createInitialState()
    state = enqueue(state, 'one')
    state = enqueue(state, 'two')
    state = enqueue(state, 'one')
    state = dequeue(state, 'one')
    expect(state.queued).toEqual(['two', 'one'])
  })

  it('dequeue is a no-op when the text is absent', () => {
    let state = createInitialState()
    state = enqueue(state, 'one')
    const next = dequeue(state, 'missing')
    expect(next.queued).toEqual(['one'])
    expect(next).toBe(state)
  })

  it('clearQueue empties the queue', () => {
    let state = createInitialState()
    state = enqueue(state, 'one')
    state = enqueue(state, 'two')
    state = clearQueue(state)
    expect(state.queued).toEqual([])
  })

  it('helpers do not mutate the original state', () => {
    const base = createInitialState()
    const enqueued = enqueue(base, 'hello')
    expect(base.queued).toEqual([])
    expect(enqueued.queued).toEqual(['hello'])

    const dequeued = dequeue(enqueued, 'hello')
    expect(enqueued.queued).toEqual(['hello'])
    expect(dequeued.queued).toEqual([])

    const cleared = clearQueue(enqueued)
    expect(enqueued.queued).toEqual(['hello'])
    expect(cleared.queued).toEqual([])
  })

  it('createInitialState defaults queued to an empty array', () => {
    const state: TuiState = createInitialState()
    expect(state.queued).toEqual([])
  })
})
