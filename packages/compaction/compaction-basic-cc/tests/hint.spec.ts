import { describe, expect, it } from 'vitest'
import {
  applyCompactHint,
  setCompactHint,
  takeCompactHint,
} from '../src/hint.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

describe('compact hint store', () => {
  it('setCompactHint parks and takeCompactHint consumes (read + clear)', () => {
    const agent = { id: 'a' }
    expect(takeCompactHint(agent)).toBeUndefined()
    setCompactHint(agent, 'keep the migration plan')
    expect(takeCompactHint(agent)).toBe('keep the migration plan')
    // Consumed: a second take is empty.
    expect(takeCompactHint(agent)).toBeUndefined()
  })

  it('hints are per-agent — A never leaks onto B', () => {
    const a = { id: 'a' }
    const b = { id: 'b' }
    setCompactHint(a, 'only for a')
    expect(takeCompactHint(b)).toBeUndefined()
    expect(takeCompactHint(a)).toBe('only for a')
  })

  it('setCompactHint overwrites a previous hint (last write wins)', () => {
    const agent = { id: 'a' }
    setCompactHint(agent, 'first')
    setCompactHint(agent, 'second')
    expect(takeCompactHint(agent)).toBe('second')
  })
})

describe('applyCompactHint', () => {
  const base = {
    system: 'system prompt',
    messages: [
      createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }),
    ],
  }

  it('returns the SAME reference for an empty hint', () => {
    expect(applyCompactHint(base, '')).toBe(base)
  })

  it('returns the SAME reference for a whitespace-only hint', () => {
    expect(applyCompactHint(base, '   \n\t ')).toBe(base)
  })

  it('appends exactly one extra user message carrying the hint', () => {
    const next = applyCompactHint(base, 'keep the auth migration plan')
    expect(next).not.toBe(base)
    expect(next.messages).toHaveLength(base.messages.length + 1)
    const last = next.messages.at(-1) as { role: string; content: { type: string; text: string }[] }
    expect(last.role).toBe('user')
    expect(last.content).toHaveLength(1)
    expect(last.content[0]!.type).toBe('text')
    expect(last.content[0]!.text).toContain('Additional preservation instructions from the user:')
    expect(last.content[0]!.text).toContain('keep the auth migration plan')
  })

  it('leaves the original messages array untouched (pure copy)', () => {
    const before = [...base.messages]
    applyCompactHint(base, 'hint')
    expect([...base.messages]).toEqual(before)
    expect(base.messages).toHaveLength(1)
  })
})
