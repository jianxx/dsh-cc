import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDriver } from '@jianxx/dsh-cc-tui/harness/driver.ts'

/**
 * Minimal ctx stub: only the surface `createDriver` touches at boot. Optional
 * seams (tools, userQuestions, llm, commands, …) stay absent so their branches
 * degrade without extra wiring. `agents.create`/`resume` are spies that
 * capture the options and return a no-op handle.
 */
function makeCtx(capture: {
  create?: unknown
  resume?: unknown
  resumeEvents?: unknown[]
  resumeStatus?: string
}): Record<string, unknown> {
  return {
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
      create: async (opts: unknown) => {
        capture.create = opts
        const agentOpts = (opts as { agentOptions?: Record<string, unknown> })?.agentOptions ?? {}
        return {
          agent: {
            options: agentOpts,
            session: { id: 's-test', header: {}, events: [] },
            id: 'a-test',
            status: 'idle',
            followup() {},
            cancel() {},
          },
          dispose: async () => {},
        }
      },
      resume: async (opts: unknown) => {
        capture.resume = opts
        const agentOpts = (opts as { agentOptions?: Record<string, unknown> })?.agentOptions ?? {}
        return {
          agent: {
            options: agentOpts,
            session: { id: 's-test', header: {}, events: capture.resumeEvents ?? [] },
            id: 'a-test',
            status: capture.resumeStatus ?? 'idle',
            followup() {},
            cancel() {},
          },
          dispose: async () => {},
        }
      },
    },
  }
}

describe('createDriver agentOptions passthrough', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-cfg-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('forwards provider+model as agentOptions on a fresh create', async () => {
    const capture: { create?: { agentOptions?: unknown } } = {}
    await createDriver(makeCtx(capture) as never, {
      provider: 'mock',
      model: 'e2e-1',
    })
    expect(capture.create?.agentOptions).toEqual({ provider: 'mock', model: 'e2e-1' })
  })

  it('omits agentOptions when provider/model are unset', async () => {
    const capture: { create?: { agentOptions?: unknown } } = {}
    await createDriver(makeCtx(capture) as never, {})
    expect(capture.create?.agentOptions).toBeUndefined()
  })

  it('forwards provider+model on a resume (sessionId set)', async () => {
    const capture: { resume?: { agentOptions?: unknown } } = {}
    await createDriver(makeCtx(capture) as never, {
      sessionId: 'prior-session',
      provider: 'mock',
      model: 'e2e-1',
    })
    expect(capture.resume?.agentOptions).toEqual({ provider: 'mock', model: 'e2e-1' })
  })

  it('does not forward when only one of provider/model is set', async () => {
    const capture: { create?: { agentOptions?: unknown } } = {}
    await createDriver(makeCtx(capture) as never, { provider: 'mock' })
    expect(capture.create?.agentOptions).toBeUndefined()
  })

  it('replays session.events on resume so prior rows appear in state', async () => {
    const resumeEvents = [
      { type: 'user/message', data: { content: [{ type: 'text', text: 'remember this' }], source: { kind: 'user' } } },
      { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'ack' } } },
      // No turn/end: the process crashed mid-turn.
    ]
    const capture: { resumeEvents?: unknown[]; resumeStatus?: string } = {
      resumeEvents,
      resumeStatus: 'running',
    }
    const driver = await createDriver(makeCtx(capture) as never, { sessionId: 'prior-session' })
    expect(driver.state.rows).toContainEqual({ kind: 'user', text: 'remember this' })
    expect(driver.state.rows).toContainEqual({ kind: 'assistant', text: 'ack' })
    // busy synced from the ground-truth status after the fold.
    expect(driver.state.busy).toBe(true)
  })

  it('syncs busy to idle when agent.status is idle after resume', async () => {
    const resumeEvents = [
      { type: 'user/message', data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } },
      { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hi' } } },
    ]
    const capture: { resumeEvents?: unknown[]; resumeStatus?: string } = {
      resumeEvents,
      resumeStatus: 'idle',
    }
    const driver = await createDriver(makeCtx(capture) as never, { sessionId: 'prior-session' })
    expect(driver.state.rows).toContainEqual({ kind: 'user', text: 'hello' })
    // The chunk set busy=true during the fold, but agent.status=idle overrides it.
    expect(driver.state.busy).toBe(false)
  })

  it('emits a boot banner status row with cwd on a fresh create', async () => {
    const capture: { create?: unknown } = {}
    const driver = await createDriver(makeCtx(capture) as never, { cwd: '/fake/path' })
    const banner = driver.state.rows.find(r => r.kind === 'status')
    expect(banner).toBeDefined()
    expect((banner as { text: string }).text).toMatch(/dsh cc-mode/)
    expect((banner as { text: string }).text).toContain('/fake/path')
    expect((banner as { text: string }).text).toContain('/tui-help')
  })

  it('labels the banner with the resolved model when agentOptions are set', async () => {
    const capture: { create?: unknown } = {}
    const driver = await createDriver(makeCtx(capture) as never, {
      provider: 'mock',
      model: 'e2e-1',
    })
    const banner = driver.state.rows.find(r => r.kind === 'status') as { text: string } | undefined
    expect(banner).toBeDefined()
    expect(banner!.text).toContain('e2e-1')
  })

  it('labels the banner "default model" when no model is resolved', async () => {
    const capture: { create?: unknown } = {}
    const driver = await createDriver(makeCtx(capture) as never, {})
    const banner = driver.state.rows.find(r => r.kind === 'status') as { text: string } | undefined
    expect(banner).toBeDefined()
    expect(banner!.text).toContain('default model')
  })

  it('places the boot banner as the first row above replayed history on resume', async () => {
    const resumeEvents = [
      { type: 'user/message', data: { content: [{ type: 'text', text: 'remember this' }], source: { kind: 'user' } } },
      { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'ack' } } },
    ]
    const capture: { resumeEvents?: unknown[]; resumeStatus?: string } = {
      resumeEvents,
      resumeStatus: 'idle',
    }
    const driver = await createDriver(makeCtx(capture) as never, { sessionId: 'prior-session' })
    expect(driver.state.rows[0]).toMatchObject({ kind: 'status' })
    expect((driver.state.rows[0] as { text: string }).text).toMatch(/dsh cc-mode/)
    // Replayed history follows the banner.
    expect(driver.state.rows[1]).toMatchObject({ kind: 'user', text: 'remember this' })
  })

  it('toggleThinking flips thinkingExpanded and notifies subscribers', async () => {
    const driver = await createDriver(makeCtx({}) as never, {})
    expect(driver.state.thinkingExpanded).toBe(false)
    let emissions = 0
    const unsub = driver.subscribe(() => { emissions++ }) // initial emit -> 1
    expect(emissions).toBe(1)
    driver.toggleThinking() // -> 2
    expect(driver.state.thinkingExpanded).toBe(true)
    expect(emissions).toBe(2)
    driver.toggleThinking() // -> 3
    expect(driver.state.thinkingExpanded).toBe(false)
    expect(emissions).toBe(3)
    unsub()
  })
})

/**
 * A ctx stub with a controllable commands service: `list(agent)` returns the
 * current catalog and the test can fire `commands/change` to simulate
 * register/unregister. `on` captures the commands/change listener.
 */
function makeCommandsCtx(commands: {
  list(agent: unknown): { name: string; description?: string; input?: { hint?: string } }[]
}) {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>()
  return {
    ctx: {
      get(key: string) {
        if (key === 'agentPresets') {
          return {
            defaultId: 'cc',
            resolve: async () => ({ id: 'cc' }),
            mount: async () => ({ id: 'cc' }),
          }
        }
        if (key === 'commands') return commands
        return undefined
      },
      on(event: string, handler: (...args: unknown[]) => void) {
        let set = handlers.get(event)
        if (set === undefined) {
          set = new Set()
          handlers.set(event, set)
        }
        set.add(handler)
        return () => {
          handlers.get(event)?.delete(handler)
        }
      },
      agents: {
        create: async () => ({
          agent: {
            options: {},
            session: { id: 's-test', header: {}, events: [] },
            id: 'a-test',
            status: 'idle',
            followup() {},
            cancel() {},
          },
          dispose: async () => {},
        }),
      },
    },
    fire(event: string, ...args: unknown[]) {
      for (const h of handlers.get(event) ?? []) h(...args)
    },
  }
}

describe('createDriver listCommands catalog', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-cmd-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('merges local + harness commands, deduped (local wins)', async () => {
    const { ctx } = makeCommandsCtx({
      list: () => [
        { name: 'status', description: 'harness status' },
        { name: 'model', description: 'SHADOWED — local wins' }, // dedupe: local keeps its own
        { name: 'permissions', description: 'rules', input: { hint: '<mode>' } },
      ],
    })
    const driver = await createDriver(ctx as never, {})
    const catalog = driver.listCommands()
    const names = catalog.map(c => c.name)

    // Local commands come first.
    expect(names.indexOf('quit')).toBeLessThan(names.indexOf('status'))
    // Harness entries appear.
    expect(names).toContain('status')
    expect(names).toContain('permissions')
    // argumentHint maps from input.hint.
    const perm = catalog.find(c => c.name === 'permissions')
    expect(perm?.argumentHint).toBe('<mode>')
    // 'model' appears once (local wins, no duplicate harness entry).
    expect(names.filter(n => n === 'model')).toHaveLength(1)
    // 'quit' is local-only and present.
    expect(names).toContain('quit')
  })

  it('returns local-only catalog when no commands service is mounted', async () => {
    const driver = await createDriver(makeCtx({}) as never, {})
    const catalog = driver.listCommands()
    const names = catalog.map(c => c.name).sort()
    expect(names).toEqual(['agents', 'clear', 'cost', 'exit', 'model', 'quit', 'resume', 'tui-help'])
  })

  it('refreshes the catalog when commands/change fires', async () => {
    let catalog = [
      { name: 'status', description: 'v1' },
    ]
    const { ctx, fire } = makeCommandsCtx({
      list: () => catalog,
    })
    const driver = await createDriver(ctx as never, {})
    expect(driver.listCommands().map(c => c.name)).toContain('status')
    const before = driver.listCommands()

    // Mutate the harness catalog and fire the change event.
    catalog = [{ name: 'status', description: 'v2' }, { name: 'fresh', description: 'new' }]
    fire('commands/change')

    const refreshed = driver.listCommands()
    expect(refreshed.map(c => c.name)).toContain('fresh')
    // The returned array identity changes after a refresh (so root.ts can
    // detect a change by reference and rebuild the provider).
    expect(refreshed).not.toBe(before)
  })

  it('exposes the session cwd', async () => {
    const { ctx } = makeCommandsCtx({ list: () => [] })
    const driver = await createDriver(ctx as never, { cwd: '/some/dir' })
    expect(driver.cwd).toBe('/some/dir')
  })
})
