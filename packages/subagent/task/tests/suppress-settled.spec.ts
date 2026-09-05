/**
 * Tests for the duplicate-notice suppression pre-step listener (collector doc
 * §5): a pop-once "collected" set keyed by senderSessionId that DROPs pending
 * `subagent-settled` messages for inline-collected children, while promoted
 * children and later epochs of the same child deliver normally.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import {
  isSubagentSettledNotice,
  mountSettledNoticeSuppression,
} from '../src/suppress-settled.ts'
import {
  isCollectedForSuppression,
  markCollectedForSuppression,
  releaseCollectedForSuppression,
} from '../src/epoch-collector.ts'

interface FakeInbox {
  nextStep: { id: string; content: unknown; source?: { kind?: string; senderSessionId?: string } }[]
  remove: (id: string) => boolean
  removed: string[]
}

function fakeInbox(messages: FakeInbox['nextStep'] = []): FakeInbox {
  const removed: string[] = []
  return {
    nextStep: messages,
    removed,
    remove(id: string) {
      removed.push(id)
      return true
    },
  } satisfies FakeInbox
}

function agentWith(inbox: FakeInbox): Agent {
  return {
    session: { header: { cwd: '/work/repo', delegationDepth: 0 } },
    options: {},
    inbox,
  } as unknown as Agent
}

function settledNotice(id: string, senderSessionId: string): FakeInbox['nextStep'][number] {
  return {
    id,
    content: [{ type: 'text', text: 'subagent settled' }],
    source: { kind: 'subagent-settled', form: 'notice', summary: 'done', senderSessionId },
  }
}

const taskPrompt = {
  id: 'task-1',
  content: [{ type: 'text', text: 'do the task' }],
  source: { kind: 'user' },
}

/** Register the suppression listener and drive the pre-step waterfall. */
async function drive(agent: Agent, inner: PreStepDecision): Promise<PreStepDecision> {
  const ctx = new Context()
  mountSettledNoticeSuppression(ctx)
  return await ctx.waterfall(
    ctx as never,
    'agent/pre-step',
    { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve(inner),
  )
}

describe('isSubagentSettledNotice', () => {
  it('matches only the subagent-settled source kind', () => {
    expect(isSubagentSettledNotice(settledNotice('a', 'child-a'))).toBe(true)
    expect(isSubagentSettledNotice(taskPrompt)).toBe(false)
    expect(isSubagentSettledNotice({ source: { kind: 'agent-instructions' } })).toBe(false)
  })
})

describe('duplicate-notice suppression (pop-once collected set)', () => {
  it('drops a collected child\'s settled notice from the inbox and pops the entry', async () => {
    markCollectedForSuppression('child-a')
    const inbox = fakeInbox([settledNotice('n1', 'child-a'), taskPrompt])
    const decision = await drive(agentWith(inbox), { kind: 'enter', messages: [taskPrompt] })
    expect(inbox.removed).toEqual(['n1'])
    expect(decision).toEqual({ kind: 'enter', messages: [taskPrompt] })
    // Pop-once: the entry was consumed.
    expect(isCollectedForSuppression('child-a')).toBe(false)
  })

  it('a later epoch of the same child delivers normally after the pop', async () => {
    markCollectedForSuppression('child-b')
    const first = fakeInbox([settledNotice('n1', 'child-b')])
    await drive(agentWith(first), { kind: 'enter', messages: [] })
    const second = fakeInbox([settledNotice('n2', 'child-b')])
    const decision = await drive(agentWith(second), { kind: 'enter', messages: [taskPrompt] })
    expect(second.removed).toEqual([])
    expect(decision).toEqual({ kind: 'enter', messages: [taskPrompt] })
  })

  it('passes through notices for children that were never collected', async () => {
    const inbox = fakeInbox([settledNotice('n1', 'never-collected')])
    const notice = inbox.nextStep[0]!
    const decision = await drive(agentWith(inbox), { kind: 'enter', messages: [taskPrompt, notice] })
    expect(inbox.removed).toEqual([])
    expect(decision).toEqual({ kind: 'enter', messages: [taskPrompt, notice] })
  })

  it('a promoted child (removed from the set) delivers its notice normally', async () => {
    markCollectedForSuppression('child-c')
    releaseCollectedForSuppression('child-c')
    const inbox = fakeInbox([settledNotice('n1', 'child-c')])
    const notice = inbox.nextStep[0]!
    const decision = await drive(agentWith(inbox), { kind: 'enter', messages: [notice] })
    expect(inbox.removed).toEqual([])
    expect(decision).toEqual({ kind: 'enter', messages: [notice] })
  })

  it('filters collected children\'s notices out of the enter batch too', async () => {
    markCollectedForSuppression('child-d')
    const notice = settledNotice('n1', 'child-d')
    const decision = await drive(agentWith(fakeInbox()), { kind: 'enter', messages: [taskPrompt, notice] })
    expect(decision).toEqual({ kind: 'enter', messages: [taskPrompt] })
  })
})
