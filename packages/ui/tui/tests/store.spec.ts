import { describe, expect, it } from 'vitest'
import {
  backspaceQuestionText,
  clearQueue,
  closeTodoPanel,
  countRunningSubagents,
  createInitialState,
  dequeue,
  enqueue,
  focusQuestionOption,
  focusModelPicker,
  moveModelPickerFocus,
  moveQuestionFocus,
  moveTodoPanelFocus,
  openTodoPanel,
  setModelPicker,
  setQuestion,
  setTodos,
  todoSummary,
  toggleGlobalCollapse,
  toggleQuestionOption,
  toggleThinking,
  typeQuestionText,
  upsertSubagent,
  type CatalogEntryView,
  type ModelPickerView,
  type QuestionView,
  type SubagentRunView,
  type TodoItemView,
  type TuiState,
} from '@jianxx/dsh-cc-tui/store.ts'

function questionState(overrides: Partial<QuestionView> = {}): TuiState {
  const question: QuestionView = {
    header: 'Pick',
    question: 'Which one?',
    options: [
      { label: 'a', description: 'first' },
      { label: 'b' },
      { label: 'c' },
    ],
    multiSelect: false,
    focused: 0,
    selected: [],
    custom: '',
    ...overrides,
  }
  return setQuestion(createInitialState(), question)
}

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

describe('question helpers', () => {
  it('toggleQuestionOption adds a label that is absent', () => {
    const state = toggleQuestionOption(questionState({ multiSelect: true }), 1)
    expect(state.question?.selected).toEqual(['b'])
    // Focus jumps to the toggled row.
    expect(state.question?.focused).toBe(1)
  })

  it('toggleQuestionOption removes a label that is present (multi-select)', () => {
    const base = questionState({ multiSelect: true, selected: ['a', 'b'] })
    const state = toggleQuestionOption(base, 1)
    expect(state.question?.selected).toEqual(['a'])
  })

  it('toggleQuestionOption is a no-op for an out-of-range index', () => {
    const base = questionState()
    const next = toggleQuestionOption(base, 9)
    expect(next).toBe(base)
  })

  it('question helpers never mutate the original state', () => {
    const base = questionState({ multiSelect: true })
    const toggled = toggleQuestionOption(base, 0)
    expect(base.question?.selected).toEqual([])
    expect(toggled.question?.selected).toEqual(['a'])
    expect(toggled).not.toBe(base)

    const typed = typeQuestionText(toggled, 'hi')
    expect(toggled.question?.custom).toBe('')
    expect(typed.question?.custom).toBe('hi')
    // Typing focuses the custom row (index === options.length).
    expect(typed.question?.focused).toBe(3)
  })

  it('moveQuestionFocus clamps between the first option and the custom row', () => {
    const base = questionState()
    expect(moveQuestionFocus(base, -1).question?.focused).toBe(0)
    const down = moveQuestionFocus(base, 1)
    expect(down.question?.focused).toBe(1)
    const last = moveQuestionFocus(moveQuestionFocus(moveQuestionFocus(down, 1), 1), 1)
    // options.length (3) is the custom row; focus stops there.
    expect(last.question?.focused).toBe(3)
  })

  it('moveQuestionFocus is a no-op when no question is open', () => {
    const base = createInitialState()
    expect(moveQuestionFocus(base, 1)).toBe(base)
  })

  it('focusQuestionOption clamps into range', () => {
    const base = questionState()
    expect(focusQuestionOption(base, 99).question?.focused).toBe(3)
    expect(focusQuestionOption(base, -3).question?.focused).toBe(0)
    expect(focusQuestionOption(base, 2).question?.focused).toBe(2)
  })

  it('typeQuestionText appends and focuses the custom row', () => {
    const base = questionState({ focused: 0, custom: 'a' })
    const state = typeQuestionText(base, 'bc')
    expect(state.question?.custom).toBe('abc')
    expect(state.question?.focused).toBe(3)
  })

  it('backspaceQuestionText drops the last character and keeps focus on the custom row', () => {
    const base = questionState({ custom: 'abc', focused: 1 })
    const state = backspaceQuestionText(base)
    expect(state.question?.custom).toBe('ab')
    expect(state.question?.focused).toBe(3)
  })

  it('backspaceQuestionText on an empty buffer is a no-op', () => {
    const base = questionState({ custom: '' })
    expect(backspaceQuestionText(base)).toBe(base)
  })
})

const PICKER_ENTRIES: readonly CatalogEntryView[] = [
  { provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  { provider: 'deepseek-official', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  { provider: 'openai', id: 'gpt-5', name: 'GPT-5' },
]

function pickerState(overrides: Partial<ModelPickerView> = {}): TuiState {
  const picker: ModelPickerView = {
    entries: PICKER_ENTRIES,
    focused: 0,
    ...overrides,
  }
  return setModelPicker(createInitialState(), picker)
}

describe('model picker helpers', () => {
  it('setModelPicker parks the picker and drops the field when cleared', () => {
    const state = pickerState({ focused: 1 })
    expect(state.modelPicker?.entries).toBe(PICKER_ENTRIES)
    expect(state.modelPicker?.focused).toBe(1)
    const cleared = setModelPicker(state, undefined)
    expect(cleared.modelPicker).toBeUndefined()
    // Cleared state does not carry the dropped field at all.
    expect('modelPicker' in cleared).toBe(false)
  })

  it('setModelPicker does not mutate the original state', () => {
    const state = createInitialState()
    const parked = setModelPicker(state, { entries: PICKER_ENTRIES, focused: 0 })
    expect(state.modelPicker).toBeUndefined()
    expect(parked.modelPicker?.focused).toBe(0)
    expect(parked).not.toBe(state)
  })

  it('moveModelPickerFocus clamps focus to [0, entries.length-1]', () => {
    const base = pickerState({ focused: 0 })
    expect(moveModelPickerFocus(base, 1).modelPicker?.focused).toBe(1)
    // Clamp at the top — does not wrap to the bottom.
    expect(moveModelPickerFocus(base, -1).modelPicker?.focused).toBe(0)
    // Clamp at the bottom.
    const bottom = pickerState({ focused: 2 })
    expect(moveModelPickerFocus(bottom, 1).modelPicker?.focused).toBe(2)
  })

  it('moveModelPickerFocus is a no-op when no picker is open', () => {
    const base = createInitialState()
    expect(moveModelPickerFocus(base, 1)).toBe(base)
  })

  it('focusModelPicker clamps into range', () => {
    const base = pickerState({ focused: 0 })
    expect(focusModelPicker(base, 99).modelPicker?.focused).toBe(2)
    expect(focusModelPicker(base, -3).modelPicker?.focused).toBe(0)
    expect(focusModelPicker(base, 2).modelPicker?.focused).toBe(2)
  })

  it('focusModelPicker is a no-op when no picker is open', () => {
    const base = createInitialState()
    expect(focusModelPicker(base, 1)).toBe(base)
  })
})

describe('thinkingExpanded', () => {
  it('defaults to false on a fresh state', () => {
    expect(createInitialState().thinkingExpanded).toBe(false)
  })

  it('toggleThinking flips the flag', () => {
    const state = createInitialState()
    expect(toggleThinking(state).thinkingExpanded).toBe(true)
    expect(toggleThinking(toggleThinking(state)).thinkingExpanded).toBe(false)
  })

  it('does not mutate the original state', () => {
    const state = createInitialState()
    const next = toggleThinking(state)
    expect(state.thinkingExpanded).toBe(false)
    expect(next.thinkingExpanded).toBe(true)
    expect(next).not.toBe(state)
  })
})

describe('toolOutputExpanded / toggleGlobalCollapse', () => {
  it('defaults toolOutputExpanded to true (tool output expanded by default)', () => {
    expect(createInitialState().toolOutputExpanded).toBe(true)
  })

  it('collapses both flags only when everything is currently expanded', () => {
    // Fresh state: thinking collapsed + tools expanded -> everything expanded.
    const expanded = toggleGlobalCollapse(createInitialState())
    expect(expanded.thinkingExpanded).toBe(true)
    expect(expanded.toolOutputExpanded).toBe(true)
    // Everything expanded -> everything collapsed.
    const collapsed = toggleGlobalCollapse(expanded)
    expect(collapsed.thinkingExpanded).toBe(false)
    expect(collapsed.toolOutputExpanded).toBe(false)
    // Mixed (thinking collapsed, tools expanded) -> everything expanded, not
    // a per-flag flip.
    const mixed = createInitialState()
    const next = toggleGlobalCollapse(mixed)
    expect(next.thinkingExpanded).toBe(true)
    expect(next.toolOutputExpanded).toBe(true)
  })

  it('expands both flags from the fully-collapsed state', () => {
    let state = toggleGlobalCollapse(createInitialState()) // all expanded
    state = toggleGlobalCollapse(state) // all collapsed
    state = toggleGlobalCollapse(state) // back to all expanded
    expect(state.thinkingExpanded).toBe(true)
    expect(state.toolOutputExpanded).toBe(true)
  })

  it('does not mutate the original state', () => {
    const state = createInitialState()
    const next = toggleGlobalCollapse(state)
    expect(state.thinkingExpanded).toBe(false)
    expect(state.toolOutputExpanded).toBe(true)
    expect(next).not.toBe(state)
    expect(next.thinkingExpanded).toBe(true)
    expect(next.toolOutputExpanded).toBe(true)
  })
})

describe('todos helpers', () => {
  const todos = (items: readonly Partial<TodoItemView>[]): readonly TodoItemView[] =>
    items.map(item => ({
      content: item.content ?? 'task',
      status: item.status ?? 'pending',
    }))

  it('setTodos parks the list and drops the field when cleared', () => {
    const list = todos([{ content: 'a', status: 'pending' }])
    const state = setTodos(createInitialState(), list)
    expect(state.todos).toEqual([{ content: 'a', status: 'pending' }])
    const cleared = setTodos(state, undefined)
    expect(cleared.todos).toBeUndefined()
    // Cleared state does not carry the dropped field at all.
    expect('todos' in cleared).toBe(false)
  })

  it('setTodos(undefined) on a bare state is a same-reference no-op', () => {
    const base = createInitialState()
    expect(setTodos(base, undefined)).toBe(base)
  })

  it('setTodos does not mutate the original state', () => {
    const base = createInitialState()
    const parked = setTodos(base, todos([{ content: 'a' }]))
    expect(base.todos).toBeUndefined()
    expect(parked.todos).toHaveLength(1)
    expect(parked).not.toBe(base)
  })

  it('todoSummary is undefined without todos', () => {
    expect(todoSummary(createInitialState())).toBeUndefined()
    expect(todoSummary(setTodos(createInitialState(), []))).toBeUndefined()
  })

  it('todoSummary counts all-pending as done 0 with no active', () => {
    const state = setTodos(createInitialState(), todos([{ content: 'a' }, { content: 'b' }]))
    expect(todoSummary(state)).toEqual({ total: 2, done: 0 })
  })

  it('todoSummary reports the first in_progress content as active', () => {
    const state = setTodos(createInitialState(), todos([
      { content: 'first', status: 'completed' },
      { content: 'active one', status: 'in_progress' },
      { content: 'active two', status: 'in_progress' },
      { content: 'later' },
    ]))
    expect(todoSummary(state)).toEqual({ total: 4, done: 1, active: 'active one' })
  })

  it('todoSummary on all-done omits active', () => {
    const state = setTodos(createInitialState(), todos([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'completed' },
      { content: 'c', status: 'completed' },
    ]))
    expect(todoSummary(state)).toEqual({ total: 3, done: 3 })
  })
})

describe('todo panel helpers', () => {
  const todos: readonly TodoItemView[] = [
    { content: 'done thing', status: 'completed' },
    { content: 'active thing', status: 'in_progress' },
    { content: 'later thing', status: 'pending' },
  ]

  function panelState(): TuiState {
    return openTodoPanel(setTodos(createInitialState(), todos))
  }

  it('openTodoPanel parks the panel focused on the first row', () => {
    const state = panelState()
    expect(state.todoPanel).toEqual({ focused: 0 })
    expect(state.todos).toBe(todos)
  })

  it('openTodoPanel still opens on an empty list (the panel shows a placeholder)', () => {
    const state = openTodoPanel(createInitialState())
    expect(state.todoPanel).toEqual({ focused: 0 })
  })

  it('closeTodoPanel drops the field entirely', () => {
    const state = panelState()
    const closed = closeTodoPanel(state)
    expect(closed.todoPanel).toBeUndefined()
    // Cleared state does not carry the dropped field at all.
    expect('todoPanel' in closed).toBe(false)
  })

  it('closeTodoPanel on a bare state is a same-reference no-op', () => {
    const base = createInitialState()
    expect(closeTodoPanel(base)).toBe(base)
  })

  it('moveTodoPanelFocus moves and clamps to [0, todos.length-1] (no wrap)', () => {
    const base = panelState()
    expect(moveTodoPanelFocus(base, 1).todoPanel?.focused).toBe(1)
    // Clamp at the top — does not wrap to the bottom.
    expect(moveTodoPanelFocus(base, -1).todoPanel?.focused).toBe(0)
    // Clamp at the bottom.
    const atEnd = moveTodoPanelFocus(moveTodoPanelFocus(base, 1), 1)
    expect(atEnd.todoPanel?.focused).toBe(2)
    expect(moveTodoPanelFocus(atEnd, 1).todoPanel?.focused).toBe(2)
  })

  it('moveTodoPanelFocus is a no-op when no panel is open (same reference)', () => {
    const base = createInitialState()
    expect(moveTodoPanelFocus(base, 1)).toBe(base)
  })

  it('moveTodoPanelFocus is a no-op when the todo list is empty or absent', () => {
    const empty = openTodoPanel(setTodos(createInitialState(), []))
    expect(moveTodoPanelFocus(empty, 1)).toBe(empty)
    const absent = openTodoPanel(createInitialState())
    expect(moveTodoPanelFocus(absent, 1)).toBe(absent)
  })

  it('todo panel helpers never mutate the original state', () => {
    const base = panelState()
    const moved = moveTodoPanelFocus(base, 1)
    expect(base.todoPanel?.focused).toBe(0)
    expect(moved.todoPanel?.focused).toBe(1)
    expect(moved).not.toBe(base)

    const closed = closeTodoPanel(moved)
    expect(moved.todoPanel).toEqual({ focused: 1 })
    expect(closed.todoPanel).toBeUndefined()
  })
})

describe('subagent helpers', () => {
  it('createInitialState defaults subagents to an empty array', () => {
    expect(createInitialState().subagents).toEqual([])
  })

  it('upsertSubagent appends a new run', () => {
    const state = upsertSubagent(createInitialState(), {
      runId: 'r1', provider: 'openai', sessionId: 'tui-abcdef01', status: 'running',
    })
    expect(state.subagents).toHaveLength(1)
    expect(state.subagents[0]).toMatchObject({ runId: 'r1', status: 'running' })
  })

  it('upsertSubagent updates an existing run in place by runId (running → done)', () => {
    let state = upsertSubagent(createInitialState(), {
      runId: 'r1', provider: 'openai', sessionId: 'tui-abcdef01', status: 'running',
    })
    state = upsertSubagent(state, {
      runId: 'r1', provider: 'openai', sessionId: 'tui-abcdef01', status: 'done', stopReason: 'end_turn',
    })
    expect(state.subagents).toHaveLength(1)
    expect(state.subagents[0]!.status).toBe('done')
    expect(state.subagents[0]!.stopReason).toBe('end_turn')
  })

  it('upsertSubagent omits stopReason when not provided', () => {
    const state = upsertSubagent(createInitialState(), {
      runId: 'r1', provider: 'openai', sessionId: 'tui-abcdef01', status: 'running',
    })
    expect('stopReason' in (state.subagents[0]!)).toBe(false)
  })

  it('upsertSubagent does not mutate the original state', () => {
    const base = createInitialState()
    const next = upsertSubagent(base, {
      runId: 'r1', provider: 'openai', sessionId: 'tui-abcdef01', status: 'running',
    })
    expect(base.subagents).toEqual([])
    expect(next.subagents).toHaveLength(1)
    expect(next).not.toBe(base)
  })

  it('caps the list at 20, dropping oldest running when all are running', () => {
    let state = createInitialState()
    for (let i = 0; i < 21; i += 1) {
      state = upsertSubagent(state, {
        runId: `r${i}`, provider: 'p', sessionId: `s${i}`, status: 'running',
      })
    }
    expect(state.subagents).toHaveLength(20)
    expect(state.subagents.find(r => r.runId === 'r0')).toBeUndefined()
    expect(state.subagents.find(r => r.runId === 'r1')).toBeDefined()
    expect(state.subagents.find(r => r.runId === 'r20')).toBeDefined()
  })

  it('caps by dropping oldest done before oldest running', () => {
    let state = createInitialState()
    // 15 done (d0..d14) then 10 running (r0..r9) = 25; cap 20 → drop 5 oldest done.
    for (let i = 0; i < 15; i += 1) {
      state = upsertSubagent(state, {
        runId: `d${i}`, provider: 'p', sessionId: `s${i}`, status: 'done', stopReason: 'x',
      })
    }
    for (let i = 0; i < 10; i += 1) {
      state = upsertSubagent(state, {
        runId: `r${i}`, provider: 'p', sessionId: `s${i}`, status: 'running',
      })
    }
    expect(state.subagents).toHaveLength(20)
    expect(state.subagents.find(r => r.runId === 'd0')).toBeUndefined()
    expect(state.subagents.find(r => r.runId === 'd4')).toBeUndefined()
    expect(state.subagents.find(r => r.runId === 'd5')).toBeDefined()
    expect(state.subagents.find(r => r.runId === 'r0')).toBeDefined()
    expect(state.subagents.find(r => r.runId === 'r9')).toBeDefined()
  })

  it('drops oldest running only after all done are exhausted', () => {
    let state = createInitialState()
    // 1 done + 21 running = 22; cap 20 → drop the 1 done, then 1 oldest running.
    state = upsertSubagent(state, {
      runId: 'd0', provider: 'p', sessionId: 's0', status: 'done', stopReason: 'x',
    })
    for (let i = 0; i < 21; i += 1) {
      state = upsertSubagent(state, {
        runId: `r${i}`, provider: 'p', sessionId: `s${i}`, status: 'running',
      })
    }
    expect(state.subagents).toHaveLength(20)
    expect(state.subagents.find(r => r.runId === 'd0')).toBeUndefined()
    expect(state.subagents.find(r => r.runId === 'r0')).toBeUndefined()
    expect(state.subagents.find(r => r.runId === 'r1')).toBeDefined()
    expect(state.subagents.find(r => r.runId === 'r20')).toBeDefined()
  })

  it('countRunningSubagents counts only running runs', () => {
    let state = createInitialState()
    state = upsertSubagent(state, { runId: 'r1', provider: 'p', sessionId: 's1', status: 'running' })
    state = upsertSubagent(state, { runId: 'r2', provider: 'p', sessionId: 's2', status: 'done', stopReason: 'x' })
    state = upsertSubagent(state, { runId: 'r3', provider: 'p', sessionId: 's3', status: 'running' })
    expect(countRunningSubagents(state)).toBe(2)
  })

  it('countRunningSubagents is zero on an empty state', () => {
    expect(countRunningSubagents(createInitialState())).toBe(0)
  })

  it('SubagentRunView status is narrowed to running | done', () => {
    const view: SubagentRunView = {
      runId: 'r1', provider: 'p', sessionId: 's1', status: 'done', stopReason: 'end_turn',
    }
    expect(view.status === 'running' || view.status === 'done').toBe(true)
  })
})
