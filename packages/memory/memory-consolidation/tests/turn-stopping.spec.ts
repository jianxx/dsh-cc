import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply } from '../src/index.ts'

/**
 * Regression coverage for the turn-stopping listener. Upstream
 * `Subagents.start` is async (`Promise<SubagentRun>`), so every mock here is
 * async too — a synchronous mock is exactly what let the missing `await` on
 * `run.result` ship as "Cannot read properties of undefined (reading 'then')"
 * at the end of every turn.
 */

function fakeAgent(cwd: string): Agent {
  return { session: { events: [], header: { cwd } } } as unknown as Agent
}

function mount(config: { memoryHome: string; dreamEnabled?: boolean }) {
  const ctx = new Context()
  const jobs = { start: vi.fn() }
  const subagents = { start: vi.fn() }
  // Provide on the root context so the plugin under test (mounted on the same
  // root) sees the services through ctx.get.
  ctx.provide('jobs' as never, jobs as never)
  ctx.provide('subagents' as never, subagents as never)
  apply(ctx, config)
  return { ctx, jobs, subagents }
}

/** Dispatch turn-stopping the way the agent loop does: serially, awaiting listeners. */
async function stopTurn(ctx: Context, agent: Agent): Promise<void> {
  const signal = new AbortController().signal
  await ctx.serial('agent/turn-stopping' as never, { agent, signal } as never)
}

describe('agent/turn-stopping listener', () => {
  it('awaits the async subagents.start before reading run.result', async () => {
    const { ctx, jobs, subagents } = mount({ memoryHome: '/tmp/mem', dreamEnabled: false })
    subagents.start.mockImplementation(async () => ({ result: Promise.resolve({ status: 'completed' }) }))

    await stopTurn(ctx, fakeAgent('/tmp'))

    await vi.waitFor(() => expect(jobs.start).toHaveBeenCalledTimes(1))
    expect(subagents.start).toHaveBeenCalledWith('fork', expect.objectContaining({
      label: 'extract-memories',
      parent: expect.anything(),
    }))
  })

  it('never fails the turn when the subagent run rejects', async () => {
    const { ctx, jobs, subagents } = mount({ memoryHome: '/tmp/mem', dreamEnabled: false })
    subagents.start.mockImplementation(async () => ({ result: Promise.reject(new Error('model exploded')) }))

    await expect(stopTurn(ctx, fakeAgent('/tmp'))).resolves.toBeUndefined()
    await vi.waitFor(() => expect(jobs.start).toHaveBeenCalledTimes(1))
  })

  it('never fails the turn when subagents.start itself rejects', async () => {
    const { ctx, jobs, subagents } = mount({ memoryHome: '/tmp/mem', dreamEnabled: false })
    subagents.start.mockRejectedValue(new Error('no such provider'))

    await expect(stopTurn(ctx, fakeAgent('/tmp'))).resolves.toBeUndefined()
  })
})
