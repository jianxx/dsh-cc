import { describe, expect, it } from 'vitest'
import { handleComposerInput, type InputSink } from '@jianxx/dsh-cc-tui/input.ts'
import {
  createInitialState,
  setApproval,
  setBusy,
  setModelPicker,
  setQuestion,
  type CatalogEntryView,
  type ModelPickerView,
  type QuestionView,
  type TuiState,
} from '@jianxx/dsh-cc-tui/store.ts'

interface QuestionCalls {
  moved: number[]
  toggled: number
  picked: number[]
  typed: string[]
  backspaced: number
  submitted: number
  cancelled: number
}

interface ModelPickerCalls {
  moved: number[]
  submitted: number
  cancelled: number
}

function sink(initial: TuiState = createInitialState()): InputSink & {
  disposed: boolean
  interrupted: boolean
  cycled: boolean
  toggled: boolean
  questionCalls: QuestionCalls
  modelPickerCalls: ModelPickerCalls
} {
  let state = initial
  const questionCalls: QuestionCalls = {
    moved: [],
    toggled: 0,
    picked: [],
    typed: [],
    backspaced: 0,
    submitted: 0,
    cancelled: 0,
  }
  const modelPickerCalls: ModelPickerCalls = {
    moved: [],
    submitted: 0,
    cancelled: 0,
  }
  return {
    disposed: false,
    interrupted: false,
    cycled: false,
    toggled: false,
    questionCalls,
    modelPickerCalls,
    get state() {
      return state
    },
    interrupt() {
      this.interrupted = true
    },
    cyclePermissionMode() {
      this.cycled = true
    },
    toggleThinking() {
      this.toggled = true
      state = { ...state, thinkingExpanded: !state.thinkingExpanded }
    },
    answerApproval() {},
    questionMove(delta) {
      questionCalls.moved.push(delta)
    },
    questionToggle() {
      questionCalls.toggled += 1
    },
    questionPick(index) {
      questionCalls.picked.push(index)
    },
    questionType(text) {
      questionCalls.typed.push(text)
    },
    questionBackspace() {
      questionCalls.backspaced += 1
    },
    questionSubmit() {
      questionCalls.submitted += 1
    },
    questionCancel() {
      questionCalls.cancelled += 1
    },
    modelPickerMove(delta) {
      modelPickerCalls.moved.push(delta)
    },
    modelPickerSubmit() {
      modelPickerCalls.submitted += 1
    },
    modelPickerCancel() {
      modelPickerCalls.cancelled += 1
    },
    async dispose() {
      this.disposed = true
    },
  }
}

function questionState(overrides: Partial<QuestionView> = {}): TuiState {
  return setQuestion(createInitialState(), {
    header: 'Pick',
    question: 'Which?',
    options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }],
    multiSelect: false,
    focused: 0,
    selected: [],
    custom: '',
    ...overrides,
  })
}

describe('handleComposerInput', () => {
  it('answers an approval overlay with yes on 1 or y/Y', () => {
    let allowed: boolean | undefined
    const driver = sink(setApproval(createInitialState(), { toolName: 'Bash' }))
    driver.answerApproval = value => {
      allowed = value
    }
    for (const key of ['1', 'y', 'Y']) {
      handleComposerInput(driver, key)
      expect(allowed).toBe(true)
    }
  })

  it('answers an approval overlay with no on 2, n/N, or escape', () => {
    let allowed: boolean | undefined
    const driver = sink(setApproval(createInitialState(), { toolName: 'Bash' }))
    driver.answerApproval = value => {
      allowed = value
    }
    for (const key of ['2', 'n', 'N', '\x1b']) {
      handleComposerInput(driver, key)
      expect(allowed).toBe(false)
    }
  })

  it('does not toggle thinking while an approval overlay is open (overlay wins)', () => {
    const driver = sink(setApproval(createInitialState(), { toolName: 'Bash' }))
    handleComposerInput(driver, '\x0f')
    expect(driver.toggled).toBe(false)
  })

  it('an approval overlay outranks an open question (input goes to the approval)', () => {
    let allowed: boolean | undefined
    let state = setApproval(createInitialState(), { toolName: 'Bash' })
    state = setQuestion(state, {
      header: 'Pick',
      question: 'Which?',
      options: [{ label: 'a' }],
      multiSelect: false,
      focused: 0,
      selected: [],
      custom: '',
    })
    const driver = sink(state)
    driver.answerApproval = value => {
      allowed = value
    }
    handleComposerInput(driver, '1')
    expect(allowed).toBe(true)
    expect(driver.questionCalls.submitted).toBe(0)
    expect(driver.questionCalls.picked).toEqual([])
  })
})

describe('handleComposerInput question routing', () => {
  it('arrow up moves focus up (-1)', () => {
    const driver = sink(questionState({ focused: 2 }))
    const action = handleComposerInput(driver, '\x1b[A')
    expect(driver.questionCalls.moved).toEqual([-1])
    expect(action).toEqual({ kind: 'none' })
  })

  it('arrow down moves focus down (+1)', () => {
    const driver = sink(questionState())
    handleComposerInput(driver, '\x1b[B')
    expect(driver.questionCalls.moved).toEqual([1])
  })

  it('space toggles the focused option', () => {
    const driver = sink(questionState({ multiSelect: true }))
    handleComposerInput(driver, ' ')
    expect(driver.questionCalls.toggled).toBe(1)
  })

  it('enter submits', () => {
    const driver = sink(questionState())
    handleComposerInput(driver, '\r')
    expect(driver.questionCalls.submitted).toBe(1)
  })

  it('backspace edits the custom buffer', () => {
    const driver = sink(questionState())
    handleComposerInput(driver, '\x7f')
    expect(driver.questionCalls.backspaced).toBe(1)
  })

  it('escape cancels (dismisses with the first option)', () => {
    const driver = sink(questionState())
    handleComposerInput(driver, '\x1b')
    expect(driver.questionCalls.cancelled).toBe(1)
  })

  it('digits jump to (and pick/toggle) the numbered option', () => {
    const driver = sink(questionState())
    handleComposerInput(driver, '2')
    expect(driver.questionCalls.picked).toEqual([1])
  })

  it('printable characters type into the free-text buffer', () => {
    const driver = sink(questionState())
    handleComposerInput(driver, 'h')
    handleComposerInput(driver, 'i')
    expect(driver.questionCalls.typed).toEqual(['h', 'i'])
  })

  it('a digit beyond the option count is consumed and routed; the driver bounds-checks', () => {
    const driver = sink(questionState())
    const action = handleComposerInput(driver, '9')
    // Routed as pick(8) — the real driver ignores out-of-range indexes
    // (covered in driver-question.spec); the key is still consumed.
    expect(driver.questionCalls.picked).toEqual([8])
    expect(driver.questionCalls.typed).toEqual([])
    expect(action).toEqual({ kind: 'none' })
  })

  it('unknown sequences are consumed (never fall through to the editor)', () => {
    const driver = sink(questionState())
    // paste-like multi-char payload: not a key we understand, still consumed
    const action = handleComposerInput(driver, 'abc')
    expect(action).toEqual({ kind: 'none' })
    expect(driver.questionCalls.typed).toEqual([])
  })

  it('all question keys are consumed, not passed to the editor path', () => {
    const driver = sink(questionState())
    for (const key of ['\x1b[A', '\x1b[B', ' ', '\r', '\x7f', 'h', '2', '\x1b']) {
      expect(handleComposerInput(driver, key)).toEqual({ kind: 'none' })
    }
    expect(driver.questionCalls.moved).toEqual([-1, 1])
    expect(driver.questionCalls.toggled).toBe(1)
    expect(driver.questionCalls.submitted).toBe(1)
    expect(driver.questionCalls.backspaced).toBe(1)
    expect(driver.questionCalls.typed).toEqual(['h'])
    expect(driver.questionCalls.picked).toEqual([1])
    expect(driver.questionCalls.cancelled).toBe(1)
  })
})

const PICKER_ENTRIES: readonly CatalogEntryView[] = [
  { provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'Flash' },
  { provider: 'openai', id: 'gpt-5', name: 'GPT-5' },
]

function pickerState(overrides: Partial<ModelPickerView> = {}): TuiState {
  return setModelPicker(createInitialState(), {
    entries: PICKER_ENTRIES,
    focused: 0,
    ...overrides,
  })
}

describe('handleComposerInput model picker routing', () => {
  it('arrow up moves focus up (-1)', () => {
    const driver = sink(pickerState({ focused: 1 }))
    const action = handleComposerInput(driver, '\x1b[A')
    expect(driver.modelPickerCalls.moved).toEqual([-1])
    expect(action).toEqual({ kind: 'none' })
  })

  it('arrow down moves focus down (+1)', () => {
    const driver = sink(pickerState())
    handleComposerInput(driver, '\x1b[B')
    expect(driver.modelPickerCalls.moved).toEqual([1])
  })

  it('enter submits the focused entry', () => {
    const driver = sink(pickerState())
    handleComposerInput(driver, '\r')
    expect(driver.modelPickerCalls.submitted).toBe(1)
  })

  it('escape cancels the picker', () => {
    const driver = sink(pickerState())
    handleComposerInput(driver, '\x1b')
    expect(driver.modelPickerCalls.cancelled).toBe(1)
  })

  it('all other keys are consumed and never reach the editor (modal)', () => {
    const driver = sink(pickerState())
    for (const key of ['h', ' ', '2', '\x7f', 'abc']) {
      expect(handleComposerInput(driver, key)).toEqual({ kind: 'none' })
    }
    // Nothing routed to question handlers (no question open).
    expect(driver.questionCalls.moved).toEqual([])
    expect(driver.questionCalls.typed).toEqual([])
    // Nothing routed to global handlers.
    expect(driver.cycled).toBe(false)
    expect(driver.toggled).toBe(false)
    expect(driver.interrupted).toBe(false)
  })

  it('a question overlay outranks the model picker (precedence: approval > question > modelPicker)', () => {
    let state = setQuestion(createInitialState(), {
      header: 'Pick',
      question: 'Which?',
      options: [{ label: 'a' }],
      multiSelect: false,
      focused: 0,
      selected: [],
      custom: '',
    })
    state = setModelPicker(state, { entries: PICKER_ENTRIES, focused: 0 })
    const driver = sink(state)
    handleComposerInput(driver, '\r')
    expect(driver.questionCalls.submitted).toBe(1)
    expect(driver.modelPickerCalls.submitted).toBe(0)
  })

  it('does not toggle thinking while a model picker is open (overlay wins)', () => {
    const driver = sink(pickerState())
    handleComposerInput(driver, '\x0f')
    expect(driver.toggled).toBe(false)
  })

  it('does not interrupt on escape while a model picker is open (cancel wins)', () => {
    const driver = sink(setBusy(pickerState(), true))
    handleComposerInput(driver, '\x1b')
    expect(driver.interrupted).toBe(false)
    expect(driver.modelPickerCalls.cancelled).toBe(1)
  })
})

describe('handleComposerInput global keys', () => {
  it('cycles permission mode on shift+tab', () => {
    const driver = sink()
    handleComposerInput(driver, '\x1b[Z')
    expect(driver.cycled).toBe(true)
  })

  it('interrupts on escape when busy', () => {
    const driver = sink(setBusy(createInitialState(), true))
    handleComposerInput(driver, '\x1b')
    expect(driver.interrupted).toBe(true)
  })

  it('treats ctrl+c as an exit', () => {
    const driver = sink()
    const action = handleComposerInput(driver, '\x03')
    expect(action).toEqual({ kind: 'quit' })
    expect(driver.disposed).toBe(true)
  })

  it('toggles thinking on ctrl+o and consumes the key', () => {
    const driver = sink()
    const action = handleComposerInput(driver, '\x0f') // ctrl+o
    expect(driver.toggled).toBe(true)
    expect(driver.state.thinkingExpanded).toBe(true)
    expect(action).toEqual({ kind: 'none' })
  })
})
