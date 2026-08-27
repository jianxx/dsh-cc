import { describe, expect, it } from 'vitest'
import { handleComposerInput, type InputSink } from '@jianxx/dsh-cc-tui/input.ts'
import { createInitialState, setApproval, setQuestion, setBusy, type TuiState } from '@jianxx/dsh-cc-tui/store.ts'

function sink(initial: TuiState = createInitialState()): InputSink & { disposed: boolean; interrupted: boolean; cycled: boolean } {
  let state = initial
  return {
    disposed: false,
    interrupted: false,
    cycled: false,
    get state() {
      return state
    },
    interrupt() {
      this.interrupted = true
    },
    cyclePermissionMode() {
      this.cycled = true
    },
    answerApproval() {},
    answerQuestion() {},
    async dispose() {
      this.disposed = true
    },
  }
}

describe('handleComposerInput', () => {
  it('answers an approval overlay with yes on 1', () => {
    let allowed: boolean | undefined
    const driver = sink(setApproval(createInitialState(), { toolName: 'Bash' }))
    driver.answerApproval = value => {
      allowed = value
    }
    handleComposerInput(driver, '1')
    expect(allowed).toBe(true)
  })

  it('answers an approval overlay with no on 2 or escape', () => {
    let allowed: boolean | undefined
    const driver = sink(setApproval(createInitialState(), { toolName: 'Bash' }))
    driver.answerApproval = value => {
      allowed = value
    }
    handleComposerInput(driver, '2')
    expect(allowed).toBe(false)
    handleComposerInput(driver, '\x1b')
    expect(allowed).toBe(false)
  })

  it('answers a question overlay by digit', () => {
    let selected: string | undefined
    const driver = sink(setQuestion(createInitialState(), { header: 'Pick', options: ['a', 'b', 'c'] }))
    driver.answerQuestion = value => {
      selected = value
    }
    handleComposerInput(driver, '2')
    expect(selected).toBe('b')
  })

  it('answers a question overlay with the first option on escape', () => {
    let selected: string | undefined
    const driver = sink(setQuestion(createInitialState(), { header: 'Pick', options: ['a', 'b'] }))
    driver.answerQuestion = value => {
      selected = value
    }
    handleComposerInput(driver, '\x1b')
    expect(selected).toBe('a')
  })

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
})
