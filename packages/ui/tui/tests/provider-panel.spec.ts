import { describe, expect, it } from 'vitest'
import {
  backFromWizard,
  backToList,
  cancelRemove,
  enterDetail,
  moveCursor,
  openProviderPanel,
  setMessage,
  startRemove,
  startWizardFor,
  wizardBack,
  wizardNext,
  wizardSetAnswer,
  type ProviderRow,
} from '../src/store/provider-panel.ts'

const ROWS: ProviderRow[] = [
  { route: 'deepseek', displayName: 'DeepSeek', section: 'configured', isCurrent: true },
  { route: 'moonshotai', displayName: 'Kimi API (global)', section: 'available', isCurrent: false },
]

describe('provider panel transitions', () => {
  it('open starts on the list at cursor 0; close is the caller dropping state', () => {
    const s = openProviderPanel(ROWS)
    expect(s).toMatchObject({ phase: 'list', cursor: 0 })
    expect(s.rows).toBe(ROWS)
  })

  it('move clamps without wrapping', () => {
    let s = openProviderPanel(ROWS)
    s = moveCursor(s, 1)
    expect(s.cursor).toBe(1)
    s = moveCursor(s, 5)
    expect(s.cursor).toBe(1)
    s = moveCursor(s, -5)
    expect(s.cursor).toBe(0)
    expect(s.phase).toBe('list')
  })

  it('enterDetail selects the focused route; backToList clears it', () => {
    let s = openProviderPanel(ROWS)
    s = moveCursor(s, 1)
    s = enterDetail(s)
    expect(s.phase).toBe('detail')
    expect(s.selected).toBe('moonshotai')
    s = startRemove(s)
    expect(s.phase).toBe('confirm-remove')
    s = cancelRemove(s)
    expect(s.phase).toBe('detail')
    s = setMessage(s, 'saved')
    expect(s.message).toBe('saved')
    s = backToList(s)
    expect(s.phase).toBe('list')
    expect(s.selected).toBeUndefined()
  })

  it('startWizardFor seeds ordered steps and empty answers', () => {
    let s = startWizardFor(openProviderPanel(ROWS), 'moonshotai', ['credential', 'verify', 'done'])
    expect(s.phase).toBe('wizard')
    expect(s.wizard).toMatchObject({ route: 'moonshotai', stepIndex: 0 })
    expect(s.wizard!.steps).toEqual(['credential', 'verify', 'done'])
    expect(s.wizard!.answers).toEqual({})
  })

  it('wizardSetAnswer accumulates without mutating prior state', () => {
    const s0 = startWizardFor(openProviderPanel(ROWS), 'moonshotai', ['credential', 'done'])
    const s1 = wizardSetAnswer(s0, 'apiKey', 'sk-1')
    expect(s0.wizard!.answers).toEqual({})
    const s2 = wizardSetAnswer(s1, 'apiKey', 'sk-2')
    expect(s2.wizard!.answers).toEqual({ apiKey: 'sk-2' })
  })

  it('wizardNext / wizardBack clamp at the ends; back past first returns to list (esc path)', () => {
    let s = startWizardFor(openProviderPanel(ROWS), 'moonshotai', ['credential', 'verify', 'done'])
    s = wizardBack(s)
    expect(s.phase).toBe('wizard')
    expect(s.wizard!.stepIndex).toBe(0)
    s = wizardNext(s)
    s = wizardNext(s)
    expect(s.wizard!.stepIndex).toBe(2)
    s = wizardNext(s)
    expect(s.wizard!.stepIndex).toBe(2)
    expect(s.phase).toBe('wizard')
    s = backFromWizard(s)
    expect(s.phase).toBe('list')
  })

  it('esc from detail returns to list', () => {
    const s = backToList(enterDetail(moveCursor(openProviderPanel(ROWS), 1)))
    expect(s.phase).toBe('list')
  })
})
