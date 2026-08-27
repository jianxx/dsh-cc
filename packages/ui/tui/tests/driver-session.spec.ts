import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriver } from '@jianxx/dsh-cc-tui/harness/driver.ts'
import { readResumeTarget } from '@jianxx/dsh-cc-tui/resume-target.ts'

/**
 * Fake session shape — one entry per persisted session the harness knows.
 */
interface FakeSession {
  id: string
  events?: unknown[]
  status?: string
  provider?: string
  model?: string
}

/**
 * Minimal ctx stub that supports in-process session switching:
 * - `agents.create` returns the boot session
 * - `agents.resume({ resumeSessionId })` returns a NEW agent for that id
 * - `dispose` on each handle is a spy so tests assert the old handle was torn down
 * - `sessionPersistence.list()` returns the configured session headers
 */
function makeSwitchableCtx(opts: {
  createSession?: FakeSession
  resumeSessions?: Record<string, FakeSession>
  sessionList?: { id: string; cwd?: string; createdAt: number }[]
}): {
  ctx: Record<string, unknown>
  disposed: string[]
  resumeCalls: { resumeSessionId: string; agentOptions?: unknown }[]
} {
  const disposed: string[] = []
  const resumeCalls: { resumeSessionId: string; agentOptions?: unknown }[] = []
  const createSession = opts.createSession ?? { id: 's-a', events: [], status: 'idle' }

  const makeAgent = (s: FakeSession): Record<string, unknown> => ({
    options: s.provider !== undefined && s.model !== undefined
      ? { provider: s.provider, model: s.model }
      : {},
    session: { id: s.id, header: s.cwd === undefined ? {} : { cwd: s.cwd }, events: s.events ?? [] },
    id: `agent-${s.id}`,
    status: s.status ?? 'idle',
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
  })

  const makeHandle = (s: FakeSession) => ({
    agent: makeAgent(s),
    dispose: async () => { disposed.push(s.id) },
  })

  const ctx: Record<string, unknown> = {
    get(key: string) {
      if (key === 'agentPresets') {
        return {
          defaultId: 'cc',
          resolve: async () => ({ id: 'cc' }),
          mount: async () => ({ id: 'cc' }),
        }
      }
      if (key === 'sessionPersistence') {
        return { list: async () => opts.sessionList ?? [] }
      }
      return undefined
    },
    on: () => () => {},
    agents: {
      create: async () => makeHandle(createSession),
      resume: async (req: { resumeSessionId: string; agentOptions?: unknown }) => {
        resumeCalls.push(req)
        const s = opts.resumeSessions?.[req.resumeSessionId]
        if (s === undefined) throw new Error(`unknown session: ${req.resumeSessionId}`)
        return makeHandle(s)
      },
    },
  }

  return { ctx, disposed, resumeCalls }
}

describe('createDriver switchSession', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-switch-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('disposes the old handle, resumes the new id, and rebuilds the transcript', async () => {
    const newEvents = [
      { type: 'user/message', data: { content: [{ type: 'text', text: 'switched history' }], source: { kind: 'user' } } },
    ]
    const { ctx, disposed, resumeCalls } = makeSwitchableCtx({
      createSession: { id: 's-a', events: [], status: 'idle' },
      resumeSessions: { 's-b': { id: 's-b', events: newEvents, status: 'running' } },
    })
    const driver = await createDriver(ctx as never, {})
    // Boot session is s-a
    expect(driver.state.rows[0]).toMatchObject({ kind: 'status' })
    expect((driver.state.rows[0] as { text: string }).text).toMatch(/dsh cc-mode/)

    await driver.switchSession('s-b')

    // Old handle disposed
    expect(disposed).toEqual(['s-a'])
    // Resume called with the right id
    expect(resumeCalls).toHaveLength(1)
    expect(resumeCalls[0]!.resumeSessionId).toBe('s-b')
    // Transcript = banner + folded new history
    expect(driver.state.rows[0]).toMatchObject({ kind: 'status' })
    expect((driver.state.rows[0] as { text: string }).text).toMatch(/dsh cc-mode/)
    expect(driver.state.rows).toContainEqual({ kind: 'user', text: 'switched history' })
    // Busy synced from the new agent's status
    expect(driver.state.busy).toBe(true)
    // Resume target written
    expect(readResumeTarget()).toBe('s-b')
  })

  it('is a no-op when switching to the current session (dispose NOT called)', async () => {
    const { ctx, disposed, resumeCalls } = makeSwitchableCtx({
      createSession: { id: 's-a', events: [], status: 'idle' },
      resumeSessions: { 's-a': { id: 's-a', events: [], status: 'idle' } },
    })
    const driver = await createDriver(ctx as never, {})

    await driver.switchSession('s-a')

    expect(disposed).toEqual([])
    expect(resumeCalls).toHaveLength(0)
  })

  it('on a failed resume emits a notice and keeps the old session alive', async () => {
    const { ctx, disposed, resumeCalls } = makeSwitchableCtx({
      createSession: { id: 's-a', events: [], status: 'idle' },
      resumeSessions: {}, // 's-b' not registered → resume throws
    })
    const driver = await createDriver(ctx as never, {})
    const originalRows = [...driver.state.rows]

    await driver.switchSession('s-b')

    // Resume was attempted
    expect(resumeCalls).toHaveLength(1)
    // Old handle NOT disposed (resume-first ordering)
    expect(disposed).toEqual([])
    // Notice row emitted
    const last = driver.state.rows.at(-1)
    expect(last?.kind).toBe('status')
    expect((last as { text: string }).text).toMatch(/Resume failed/)
    // Old transcript intact (the notice is appended, not replacing)
    expect(driver.state.rows.slice(0, originalRows.length)).toEqual(originalRows)
  })

  it('clears pending approval/question/modelPicker/queue before switching', async () => {
    // We need a ctx that can fire approval/request — but for simplicity, we
    // can set the overlay state directly via the driver and verify it clears.
    // Instead, use a ctx with session/event + approval/request handlers.
    const sessionHandlers = new Set<(session: unknown, event: unknown) => void>()
    const approvalHandlers = new Set<(req: unknown, next: () => void) => void>()
    const disposed: string[] = []
    const resumeCalls: { resumeSessionId: string }[] = []
    const createSession = { id: 's-a', events: [], status: 'idle' }
    const newSession = { id: 's-b', events: [], status: 'idle' }

    const makeAgent = (s: FakeSession): Record<string, unknown> => ({
      options: {},
      session: { id: s.id, header: {}, events: s.events ?? [] },
      id: `agent-${s.id}`,
      status: s.status ?? 'idle',
      followup: vi.fn(),
      steer: vi.fn(),
      cancel: vi.fn(),
    })
    const makeHandle = (s: FakeSession) => ({
      agent: makeAgent(s),
      dispose: async () => { disposed.push(s.id) },
    })

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
          sessionHandlers.add(handler as (session: unknown, event: unknown) => void)
        } else if (event === 'approval/request') {
          approvalHandlers.add(handler as (req: unknown, next: () => void) => void)
        }
        return () => {}
      },
      agents: {
        create: async () => makeHandle(createSession),
        resume: async (req: { resumeSessionId: string }) => {
          resumeCalls.push(req)
          return makeHandle(newSession)
        },
      },
    }

    const driver = await createDriver(ctx as never, {})

    // Simulate a pending approval by firing the approval/request event.
    const fakeReq = {
      agent: { id: 'agent-s-a', session: { id: 's-a', events: [] } },
      toolName: 'Bash',
      callId: undefined,
      reason: undefined,
      signal: { addEventListener: () => {}, removeEventListener: () => {} },
    }
    for (const handler of approvalHandlers) {
      handler(fakeReq, () => {})
    }
    // Approval overlay should be open
    expect(driver.state.approval).toBeDefined()

    await driver.switchSession('s-b')

    // Approval cleared
    expect(driver.state.approval).toBeUndefined()
    // Old handle disposed
    expect(disposed).toEqual(['s-a'])
    // Resume called
    expect(resumeCalls).toHaveLength(1)
    expect(resumeCalls[0]!.resumeSessionId).toBe('s-b')
  })

  it('listSessions wraps sessionPersistence.list()', async () => {
    const { ctx } = makeSwitchableCtx({
      sessionList: [
        { id: 's-1', createdAt: 1000 },
        { id: 's-2', cwd: '/tmp', createdAt: 2000 },
      ],
    })
    const driver = await createDriver(ctx as never, {})
    const sessions = await driver.listSessions()
    expect(sessions).toHaveLength(2)
    expect(sessions.map(s => s.id)).toEqual(['s-1', 's-2'])
    expect(sessions[1]!.cwd).toBe('/tmp')
  })

  it('listSessions returns [] when no sessionPersistence is mounted', async () => {
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
      on: () => () => {},
      agents: {
        create: async () => ({
          agent: {
            options: {},
            session: { id: 's-a', header: {}, events: [] },
            id: 'a-a',
            status: 'idle',
            followup() {},
            cancel() {},
          },
          dispose: async () => {},
        }),
        resume: async () => ({
          agent: {
            options: {},
            session: { id: 's-a', header: {}, events: [] },
            id: 'a-a',
            status: 'idle',
            followup() {},
            cancel() {},
          },
          dispose: async () => {},
        }),
      },
    }
    const driver = await createDriver(ctx as never, {})
    const sessions = await driver.listSessions()
    expect(sessions).toEqual([])
  })
})

describe('createDriver /resume session switcher overlay', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-sw-overlay-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('opens the switcher on /resume (no args) with sessions newest-first and current marked', async () => {
    const { ctx } = makeSwitchableCtx({
      createSession: { id: 's-current', events: [], status: 'idle' },
      sessionList: [
        { id: 's-old', createdAt: 1000 },
        { id: 's-current', createdAt: 2000 },
        { id: 's-newest', createdAt: 3000 },
      ],
    })
    const driver = await createDriver(ctx as never, {})

    await driver.submit('/resume')
    const sw = driver.state.sessionSwitcher
    expect(sw).toBeDefined()
    // Newest-first
    expect(sw!.sessions.map(s => s.id)).toEqual(['s-newest', 's-current', 's-old'])
    // Current session marked
    expect(sw!.currentId).toBe('s-current')
    // Focus on the current session
    expect(sw!.focused).toBe(1)
    // Not switching
    expect(sw!.switching).toBe(false)
  })

  it('focuses index 0 when the current session is not in the list', async () => {
    const { ctx } = makeSwitchableCtx({
      createSession: { id: 's-ghost', events: [], status: 'idle' },
      sessionList: [
        { id: 's-a', createdAt: 1000 },
        { id: 's-b', createdAt: 2000 },
      ],
    })
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/resume')
    expect(driver.state.sessionSwitcher?.focused).toBe(0)
  })

  it('falls back to a status-row notice when no sessions exist', async () => {
    const { ctx } = makeSwitchableCtx({
      createSession: { id: 's-a', events: [], status: 'idle' },
      sessionList: [],
    })
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/resume')
    expect(driver.state.sessionSwitcher).toBeUndefined()
    const last = driver.state.rows.at(-1)
    expect(last?.kind).toBe('status')
    expect((last as { text: string }).text).toMatch(/No sessions are available/)
  })

  it('move clamps at the bounds (no wrap)', async () => {
    const { ctx } = makeSwitchableCtx({
      createSession: { id: 's-b', events: [], status: 'idle' },
      sessionList: [
        { id: 's-a', createdAt: 1000 },
        { id: 's-b', createdAt: 2000 },
        { id: 's-c', createdAt: 3000 },
      ],
    })
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/resume')
    // Focus starts at 1 (current = s-b)
    driver.sessionSwitcherMove(-1) // → 0
    expect(driver.state.sessionSwitcher?.focused).toBe(0)
    driver.sessionSwitcherMove(-1) // clamp at top
    expect(driver.state.sessionSwitcher?.focused).toBe(0)
    driver.sessionSwitcherMove(1)
    driver.sessionSwitcherMove(1) // → 2
    expect(driver.state.sessionSwitcher?.focused).toBe(2)
    driver.sessionSwitcherMove(1) // clamp at bottom
    expect(driver.state.sessionSwitcher?.focused).toBe(2)
  })

  it('cancel closes the overlay without switching', async () => {
    const { ctx, disposed } = makeSwitchableCtx({
      createSession: { id: 's-a', events: [], status: 'idle' },
      sessionList: [{ id: 's-b', createdAt: 1000 }],
    })
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/resume')
    driver.sessionSwitcherCancel()
    expect(driver.state.sessionSwitcher).toBeUndefined()
    expect(disposed).toEqual([])
  })

  it('submit switches to the focused session and closes the overlay', async () => {
    const { ctx, disposed, resumeCalls } = makeSwitchableCtx({
      createSession: { id: 's-a', events: [], status: 'idle' },
      resumeSessions: {
        's-b': { id: 's-b', events: [{ type: 'user/message', data: { content: [{ type: 'text', text: 'hello from s-b' }], source: { kind: 'user' } } }], status: 'idle' },
      },
      sessionList: [
        { id: 's-a', createdAt: 1000 },
        { id: 's-b', createdAt: 2000 },
      ],
    })
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/resume')
    // Focus starts at 1 (current = s-a, sorted newest-first: s-b, s-a)
    expect(driver.state.sessionSwitcher?.focused).toBe(1)
    // Move up to s-b (index 0)
    driver.sessionSwitcherMove(-1)
    expect(driver.state.sessionSwitcher?.focused).toBe(0)

    await driver.sessionSwitcherSubmit()

    // Overlay closed
    expect(driver.state.sessionSwitcher).toBeUndefined()
    // Old handle disposed
    expect(disposed).toEqual(['s-a'])
    // Resume called for s-b
    expect(resumeCalls).toHaveLength(1)
    expect(resumeCalls[0]!.resumeSessionId).toBe('s-b')
    // New session's folded history is on screen
    expect(driver.state.rows).toContainEqual({ kind: 'user', text: 'hello from s-b' })
  })

  it('/resume <id> switches directly without opening the overlay', async () => {
    const { ctx, disposed, resumeCalls } = makeSwitchableCtx({
      createSession: { id: 's-a', events: [], status: 'idle' },
      resumeSessions: {
        's-b': { id: 's-b', events: [{ type: 'user/message', data: { content: [{ type: 'text', text: 'direct switch' }], source: { kind: 'user' } } }], status: 'idle' },
      },
    })
    const driver = await createDriver(ctx as never, {})

    await driver.submit('/resume s-b')

    // No overlay opened
    expect(driver.state.sessionSwitcher).toBeUndefined()
    // Old handle disposed
    expect(disposed).toEqual(['s-a'])
    // Resume called
    expect(resumeCalls).toHaveLength(1)
    expect(resumeCalls[0]!.resumeSessionId).toBe('s-b')
    // Folded history visible
    expect(driver.state.rows).toContainEqual({ kind: 'user', text: 'direct switch' })
  })

  it('/resume <id> with unknown id emits a failure notice without disposing', async () => {
    const { ctx, disposed } = makeSwitchableCtx({
      createSession: { id: 's-a', events: [], status: 'idle' },
      resumeSessions: {}, // 's-unknown' not registered
    })
    const driver = await createDriver(ctx as never, {})

    await driver.submit('/resume s-unknown')

    expect(disposed).toEqual([])
    const last = driver.state.rows.at(-1)
    expect(last?.kind).toBe('status')
    expect((last as { text: string }).text).toMatch(/Resume failed/)
  })

  it('does not leave any "Restart with" text (regression)', async () => {
    const { ctx } = makeSwitchableCtx({
      createSession: { id: 's-a', events: [], status: 'idle' },
      sessionList: [{ id: 's-b', createdAt: 1000 }],
    })
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/resume')
    // The old restart notice must not appear anywhere in the transcript.
    for (const row of driver.state.rows) {
      if (row.kind === 'status') {
        expect(row.text).not.toMatch(/Restart with/)
      }
    }
  })
})
