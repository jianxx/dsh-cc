import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriver } from '@jianxx/dsh-cc-tui/harness/driver.ts'
import { loadHistory, saveHistory } from '@jianxx/dsh-cc-tui/history.ts'

/**
 * Minimal ctx stub that captures `session/event` and `approval/request`
 * handlers so tests can drive durable events through the live fold. The
 * agent exposes followup/steer/cancel spies so submit/interrupt routing is
 * observable without a real harness.
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

function makeFakeAgent(status: string): FakeAgent {
  return {
    options: {},
    session: { id: 's-busy', header: {}, events: [] },
    id: 'a-busy',
    status,
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
  }
}

function makeCtx(agent: FakeAgent): { ctx: Record<string, unknown>; emitSession: (event: unknown) => void } {
  const sessionHandlers = new Set<(session: unknown, event: unknown) => void>()
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
  return { ctx, emitSession }
}

describe('createDriver busy input semantics', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-busy-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  /**
   * Extract the joined text blocks from a captured createUserMessage argument
   * so the followup/steer call order is assertable.
   */
  const sentTexts = (calls: readonly unknown[][]): string[] =>
    calls.map(call => {
      const message = call[0] as { content?: readonly { type?: string; text?: string }[] }
      return (message.content ?? [])
        .filter(block => block.type === 'text')
        .map(block => block.text ?? '')
        .join('')
    })

  it('submit while busy parks the text in the outbox without steering or a user row', async () => {
    const agent = makeFakeAgent('running')
    const { ctx } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})
    expect(driver.state.busy).toBe(true)

    await driver.submit('steer me')
    // Outbox semantics: a busy submit queues only — nothing is injected into
    // the running turn until turn/end (or an explicit Ctrl+S).
    expect(agent.steer).not.toHaveBeenCalled()
    expect(agent.followup).not.toHaveBeenCalled()
    expect(driver.state.queued).toEqual(['steer me'])
    // No optimistic user row on the queue path.
    expect(driver.state.rows.filter(r => r.kind === 'user')).toHaveLength(0)
  })

  it('submit while idle routes through agent.followup without enqueueing', async () => {
    const agent = makeFakeAgent('idle')
    const { ctx } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})
    expect(driver.state.busy).toBe(false)

    await driver.submit('hello')
    expect(agent.followup).toHaveBeenCalledOnce()
    expect(agent.steer).not.toHaveBeenCalled()
    // Idle sends bypass the outbox entirely — nothing to recall once sent.
    expect(driver.state.queued).toEqual([])
    expect(driver.state.busy).toBe(true)
    // No optimistic user row; the row lands on the durable event.
    expect(driver.state.rows.filter(r => r.kind === 'user')).toHaveLength(0)
  })

  it('a durable user/message adds the user row and leaves queued chips untouched', async () => {
    const agent = makeFakeAgent('running')
    const { ctx, emitSession } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})

    await driver.submit('hello')
    expect(driver.state.queued).toEqual(['hello'])

    emitSession({ type: 'user/message', data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } })
    // The fold only renders the row; chip clearing is driver-side and
    // synchronous (flush / Ctrl+S / interrupt / recall), never event-driven.
    expect(driver.state.queued).toEqual(['hello'])
    expect(driver.state.rows).toContainEqual({ kind: 'user', text: 'hello' })
  })

  it('turn/end flushes the outbox FIFO through followup and optimistically sets busy', async () => {
    const agent = makeFakeAgent('running')
    const { ctx, emitSession } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})

    await driver.submit('one')
    await driver.submit('two')
    expect(driver.state.queued).toEqual(['one', 'two'])

    emitSession({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    expect(sentTexts(agent.followup.mock.calls)).toEqual(['one', 'two'])
    expect(agent.steer).not.toHaveBeenCalled()
    // Dispatched and cleared in the same synchronous stroke.
    expect(driver.state.queued).toEqual([])
    // Optimistic busy: the flushed followups start a new turn immediately.
    expect(driver.state.busy).toBe(true)
  })

  it('an errored turn/end still flushes the outbox', async () => {
    const agent = makeFakeAgent('running')
    const { ctx, emitSession } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})

    await driver.submit('retry me')
    emitSession({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { message: 'boom' } } },
    })
    expect(sentTexts(agent.followup.mock.calls)).toEqual(['retry me'])
    expect(driver.state.queued).toEqual([])
    expect(driver.state.busy).toBe(true)
  })

  it('steerQueued injects every queued entry through agent.steer and clears the queue', async () => {
    const agent = makeFakeAgent('running')
    const { ctx } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})

    await driver.submit('one')
    await driver.submit('two')
    driver.steerQueued()
    // Queue-jump: steer, not followup, and cleared synchronously.
    expect(sentTexts(agent.steer.mock.calls)).toEqual(['one', 'two'])
    expect(agent.followup).not.toHaveBeenCalled()
    expect(driver.state.queued).toEqual([])
  })

  it('a turn/end after interrupt finds an empty queue and does not flush', async () => {
    const agent = makeFakeAgent('running')
    const { ctx, emitSession } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})

    await driver.submit('doomed entry')
    driver.interrupt()
    expect(driver.state.queued).toEqual([])

    emitSession({ type: 'turn/end', data: { reason: { kind: 'aborted' } } })
    expect(agent.followup).not.toHaveBeenCalled()
    expect(driver.state.queued).toEqual([])
  })

  it('recallQueued pops the most recent queued entry for editing', async () => {
    const agent = makeFakeAgent('running')
    const { ctx } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})

    await driver.submit('one')
    await driver.submit('two')
    expect(driver.recallQueued()).toBe('two')
    expect(driver.state.queued).toEqual(['one'])
  })

  it('recallQueued on an empty queue returns undefined and leaves the state alone', async () => {
    const agent = makeFakeAgent('running')
    const { ctx } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})

    expect(driver.recallQueued()).toBeUndefined()
    expect(driver.state.queued).toEqual([])
  })

  it('interrupt calls agent.cancel({kind:"user"}), clears queued, sets busy false, and notes the interruption', async () => {
    const agent = makeFakeAgent('running')
    const { ctx } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})
    await driver.submit('pending steer')
    expect(driver.state.queued).toEqual(['pending steer'])
    expect(driver.state.busy).toBe(true)

    driver.interrupt()
    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' })
    expect(driver.state.queued).toEqual([])
    expect(driver.state.busy).toBe(false)
    // The boot banner is also a status row; pin the interruption row specifically.
    const interrupted = driver.state.rows.filter(r => r.kind === 'status' && r.text.includes('Interrupted'))
    expect(interrupted).toHaveLength(1)
  })
})

describe('createDriver composer history persistence', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-hist-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('persists a submitted prompt and surfaces it via promptHistory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cc-histdrv-'))
    const agent = makeFakeAgent('idle')
    const { ctx } = makeCtx(agent)
    const driver = await createDriver(ctx as never, { historyDir: dir })
    expect(driver.promptHistory).toEqual([])

    await driver.submit('hello world')
    expect(driver.promptHistory).toEqual(['hello world'])
    // Persisted to disk — a fresh load reads it back.
    expect(loadHistory(dir)).toEqual(['hello world'])
  })

  it('does not persist slash commands (local or harness)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cc-histdrv-'))
    const agent = makeFakeAgent('idle')
    const { ctx } = makeCtx(agent)
    const driver = await createDriver(ctx as never, { historyDir: dir })

    await driver.submit('/quit')
    expect(driver.promptHistory).toEqual([])
    expect(loadHistory(dir)).toEqual([])
  })

  it('suppresses a consecutive-duplicate prompt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cc-histdrv-'))
    const agent = makeFakeAgent('idle')
    const { ctx } = makeCtx(agent)
    const driver = await createDriver(ctx as never, { historyDir: dir })

    await driver.submit('same')
    await driver.submit('same')
    expect(driver.promptHistory).toEqual(['same'])
    expect(loadHistory(dir)).toEqual(['same'])
  })

  it('reflects the boot-loaded history file in promptHistory (oldest→newest)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cc-histdrv-'))
    saveHistory(['old prompt', 'newer prompt'], dir)
    const agent = makeFakeAgent('idle')
    const { ctx } = makeCtx(agent)
    const driver = await createDriver(ctx as never, { historyDir: dir })
    expect(driver.promptHistory).toEqual(['old prompt', 'newer prompt'])
  })
})
