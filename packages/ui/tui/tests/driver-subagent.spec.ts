import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriver } from '@jianxx/dsh-cc-tui/harness/driver.ts'

/**
 * Minimal ctx stub that captures `session/event`, `subagent/start`, and
 * `subagent/end` handlers so tests can drive the live lifecycle fold. The
 * agent exposes followup/steer/cancel spies so submit routing is observable
 * without a real harness. Subagent events are global (process-scoped), so
 * the handlers receive a single payload — no session filter.
 */
interface FakeAgent extends Record<string, unknown> {
  options: Record<string, unknown>
  session: { id: string; header: Record<string, unknown>; events: unknown[] }
  id: string
  status: string
  followup: ReturnType<typeof vi.fn>
  steer: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
}

function makeFakeAgent(): FakeAgent {
  return {
    options: {},
    session: { id: 's-sub', header: {}, events: [] },
    id: 'a-sub',
    status: 'idle',
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
  }
}

function makeCtx(agent: FakeAgent) {
  const sessionHandlers = new Set<(session: unknown, event: unknown) => void>()
  const startHandlers = new Set<(info: unknown) => void>()
  const endHandlers = new Set<(info: unknown) => void>()
  const ctx: Record<string, unknown> = {
    get(key: string) {
      if (key === 'agentPresets') {
        return {
          defaultId: 'cc',
          resolve: async () => ({ id: 'cc' }),
          mount: async () => ({ id: 'cc' }),
        }
      }
      return undefined
    },
    on(event: string, handler: (...args: unknown[]) => void) {
      if (event === 'session/event') {
        const fn = handler as (session: unknown, event: unknown) => void
        sessionHandlers.add(fn)
        return () => { sessionHandlers.delete(fn) }
      }
      if (event === 'subagent/start') {
        const fn = handler as (info: unknown) => void
        startHandlers.add(fn)
        return () => { startHandlers.delete(fn) }
      }
      if (event === 'subagent/end') {
        const fn = handler as (info: unknown) => void
        endHandlers.add(fn)
        return () => { endHandlers.delete(fn) }
      }
      return () => {}
    },
    agents: {
      create: async () => ({ agent, dispose: async () => {} }),
      resume: async () => ({ agent, dispose: async () => {} }),
    },
  }
  const emitSession = (event: unknown): void => {
    for (const handler of sessionHandlers) handler(agent.session, event)
  }
  const emitStart = (info: unknown): void => {
    for (const handler of startHandlers) handler(info)
  }
  const emitEnd = (info: unknown): void => {
    for (const handler of endHandlers) handler(info)
  }
  return { ctx, emitSession, emitStart, emitEnd }
}

describe('createDriver subagent tracking', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-sub-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('folds subagent/start into a running view and subagent/end into a done view', async () => {
    const agent = makeFakeAgent()
    const { ctx, emitStart, emitEnd } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})

    emitStart({ runId: 'r1', provider: 'openai', id: 'tui-abcdef01-dead-beef', local: true })
    expect(driver.state.subagents).toHaveLength(1)
    expect(driver.state.subagents[0]).toMatchObject({
      runId: 'r1',
      provider: 'openai',
      sessionId: 'tui-abcdef01-dead-beef',
      status: 'running',
    })
    expect('stopReason' in driver.state.subagents[0]!).toBe(false)

    emitEnd({
      runId: 'r1',
      provider: 'openai',
      id: 'tui-abcdef01-dead-beef',
      local: true,
      stopReason: 'end_turn',
    })
    expect(driver.state.subagents).toHaveLength(1)
    expect(driver.state.subagents[0]!.status).toBe('done')
    expect(driver.state.subagents[0]!.stopReason).toBe('end_turn')
  })

  it('pairs start and end by runId without duplicating', async () => {
    const agent = makeFakeAgent()
    const { ctx, emitStart, emitEnd } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})

    emitStart({ runId: 'r1', provider: 'openai', id: 'tui-aaaaaaaa', local: true })
    emitStart({ runId: 'r2', provider: 'anthropic', id: 'tui-bbbbbbbb', local: true })
    expect(driver.state.subagents).toHaveLength(2)

    emitEnd({ runId: 'r1', provider: 'openai', id: 'tui-aaaaaaaa', local: true, stopReason: 'stop' })
    expect(driver.state.subagents).toHaveLength(2)
    expect(driver.state.subagents.find(r => r.runId === 'r1')!.status).toBe('done')
    expect(driver.state.subagents.find(r => r.runId === 'r2')!.status).toBe('running')
  })

  it('/agents with no runs shows the empty message', async () => {
    const agent = makeFakeAgent()
    const { ctx } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})

    await driver.submit('/agents')
    const row = driver.state.rows.at(-1)
    expect(row?.kind).toBe('status')
    if (row?.kind === 'status') {
      expect(row.text).toBe('No subagent activity this session.')
    }
  })

  it('/agents with runs lists provider, short id, and stop reason', async () => {
    const agent = makeFakeAgent()
    const { ctx, emitStart, emitEnd } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})

    emitStart({ runId: 'r1', provider: 'openai', id: 'tui-abcdef01-dead-beef', local: true })
    await driver.submit('/agents')
    const running = driver.state.rows.at(-1)
    expect(running?.kind).toBe('status')
    if (running?.kind === 'status') {
      expect(running.text).toContain('Subagent activity:')
      expect(running.text).toContain('●')
      expect(running.text).toContain('openai')
      // short id follows the statusline shortenSession convention (prefix + first 8 hex).
      expect(running.text).toContain('tui-abcdef01')
      expect(running.text).not.toContain('end_turn')
    }

    emitEnd({
      runId: 'r1',
      provider: 'openai',
      id: 'tui-abcdef01-dead-beef',
      local: true,
      stopReason: 'end_turn',
    })
    await driver.submit('/agents')
    const done = driver.state.rows.at(-1)
    expect(done?.kind).toBe('status')
    if (done?.kind === 'status') {
      expect(done.text).toContain('✓')
      expect(done.text).toContain('end_turn')
    }
  })

  it('/tui-help mentions /agents', async () => {
    const agent = makeFakeAgent()
    const { ctx } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})

    await driver.submit('/tui-help')
    const row = driver.state.rows.at(-1)
    expect(row?.kind).toBe('status')
    if (row?.kind === 'status') {
      expect(row.text).toContain('/agents')
    }
  })
})
