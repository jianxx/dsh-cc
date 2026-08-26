import { describe, expect, it } from 'vitest'
import { handleComposerInput, type InputSink } from '@jianxx/dsh-cc-tui/input.ts'
import { createInitialState, setApproval, setDraft, type TuiState } from '@jianxx/dsh-cc-tui/store.ts'

function sink(initial: TuiState = createInitialState()): InputSink & { submitted: string[] } {
  let state = initial
  const submitted: string[] = []
  return {
    submitted,
    get state() {
      return state
    },
    setDraft(draft) {
      state = setDraft(state, draft)
    },
    async submit() {
      submitted.push(state.draft)
      state = setDraft(state, '')
    },
    interrupt() {},
    cyclePermissionMode() {},
    answerApproval() {},
    answerQuestion() {},
    async dispose() {},
  }
}

describe('handleComposerInput', () => {
  it('appends printable keys onto the live draft, not a stale snapshot', () => {
    const driver = sink()
    handleComposerInput(driver, 'h', {})
    handleComposerInput(driver, 'i', {})
    expect(driver.state.draft).toBe('hi')
  })

  it('submits the live draft on return', () => {
    const driver = sink()
    handleComposerInput(driver, 'a', {})
    handleComposerInput(driver, 'b', {})
    const action = handleComposerInput(driver, '', { return: true })
    expect(action).toEqual({ kind: 'none' })
    expect(driver.submitted).toEqual(['ab'])
    expect(driver.state.draft).toBe('')
  })

  it('treats a raw carriage return as submit when Ink omits key.return', () => {
    const driver = sink()
    handleComposerInput(driver, 'hi', {})
    handleComposerInput(driver, '\r', {})
    expect(driver.submitted).toEqual(['hi'])
  })

  it('backspaces the live draft', () => {
    const driver = sink()
    handleComposerInput(driver, 'ab', {})
    handleComposerInput(driver, '', { backspace: true })
    expect(driver.state.draft).toBe('a')
  })

  it('treats /quit return as an exit', () => {
    const driver = sink()
    handleComposerInput(driver, '/quit', {})
    expect(handleComposerInput(driver, '', { return: true })).toEqual({ kind: 'quit' })
  })

  it('answers an approval overlay instead of typing into the draft', () => {
    let allowed: boolean | undefined
    const driver = sink(setApproval(createInitialState(), { toolName: 'Bash' }))
    driver.answerApproval = value => {
      allowed = value
    }
    handleComposerInput(driver, '1', {})
    expect(allowed).toBe(true)
    expect(driver.state.draft).toBe('')
  })
})
