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

  it('submit while busy routes through agent.steer (not followup) and enqueues without a user row', async () => {
    const agent = makeFakeAgent('running')
    const { ctx } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})
    expect(driver.state.busy).toBe(true)

    await driver.submit('steer me')
    expect(agent.steer).toHaveBeenCalledOnce()
    expect(agent.followup).not.toHaveBeenCalled()
    expect(driver.state.queued).toEqual(['steer me'])
    // No optimistic user row on the steer path.
    expect(driver.state.rows.filter(r => r.kind === 'user')).toHaveLength(0)
  })

  it('submit while idle routes through agent.followup, enqueues, and sets busy without an optimistic user row', async () => {
    const agent = makeFakeAgent('idle')
    const { ctx } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})
    expect(driver.state.busy).toBe(false)

    await driver.submit('hello')
    expect(agent.followup).toHaveBeenCalledOnce()
    expect(agent.steer).not.toHaveBeenCalled()
    expect(driver.state.queued).toEqual(['hello'])
    expect(driver.state.busy).toBe(true)
    // No optimistic user row; the row lands on the durable event.
    expect(driver.state.rows.filter(r => r.kind === 'user')).toHaveLength(0)
  })

  it('a subsequent user/message event clears the matching queue entry and adds the user row', async () => {
    const agent = makeFakeAgent('idle')
    const { ctx, emitSession } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})

    await driver.submit('hello')
    expect(driver.state.queued).toEqual(['hello'])

    emitSession({ type: 'user/message', data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } })
    expect(driver.state.queued).toEqual([])
    expect(driver.state.rows).toContainEqual({ kind: 'user', text: 'hello' })
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
