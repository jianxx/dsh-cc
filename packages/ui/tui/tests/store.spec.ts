import { describe, expect, it } from 'vitest'
import {
  backspaceQuestionText,
  clearQueue,
  createInitialState,
  dequeue,
  enqueue,
  focusQuestionOption,
  focusModelPicker,
  moveModelPickerFocus,
  moveQuestionFocus,
  setModelPicker,
  setQuestion,
  toggleQuestionOption,
  toggleThinking,
  typeQuestionText,
  type CatalogEntryView,
  type ModelPickerView,
  type QuestionView,
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
