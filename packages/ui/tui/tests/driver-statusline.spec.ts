import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriver } from '@jianxx/dsh-cc-tui/harness/driver.ts'

/**
 * Slice 4 — driver wiring for the custom status line (plan §4/Slice 4).
 * Fake projections feed + fake shell executor + fake in-process settings
 * service (the shape the approvals path consumes), per the plan's D8 pin.
 */

type ProjectionListener = (session: { id: string }, key: string, value: unknown, seq: number) => void

function makeProjections(statesBySession: Record<string, Record<string, unknown>> = {}) {
  const listeners = new Set<ProjectionListener>()
  const service = {
    onChanged(listener: ProjectionListener): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    stateOf(session: { id: string }, key: string): unknown {
      return statesBySession[session.id]?.[key]
    },
  }
  const fire = (sessionId: string, key: string, value: unknown): void => {
    // Mirror the real registry: onChanged also updates the live stateOf read.
    const states = statesBySession[sessionId] ?? (statesBySession[sessionId] = {})
    states[key] = value
    for (const listener of listeners) listener({ id: sessionId }, key, value, 0)
  }
  return { service, fire }
}

/**
 * Fake settings service: `register(ns, schema, { base })` returns a scope with
 * `get()`/`watch()`; `commit(section)` simulates an in-process settings commit
 * (the only change channel that retriggers mid-session — plan D5/S4).
 */
function makeSettings(initial: Record<string, unknown>) {
  const regs = new Map<string, {
    watchers: Set<(value: unknown) => void>
    value: unknown
    bases: unknown
  }>()
  const service = {
    register(ns: unknown, _schema: unknown, opts: { base: unknown }) {
      const reg = { watchers: new Set<(value: unknown) => void>(), value: initial, bases: opts.base }
      regs.set(String(ns), reg)
      return {
        get: () => reg.value,
        watch: (cb: (value: unknown) => void) => {
          reg.watchers.add(cb)
          return () => { reg.watchers.delete(cb) }
        },
      }
    },
  }
  const commit = (section: Record<string, unknown>): void => {
    for (const reg of regs.values()) {
      reg.value = section
      for (const watcher of [...reg.watchers]) watcher(reg.value)
    }
  }
  return { service, commit, regs }
}

interface FakeRunResult {
  exitCode: number | null
  timedOut: boolean
  stdout: { text: string }
  stderr: { text: string }
}

/**
 * Fake shell executor (resolve→run seam): records every resolved spec the
 * runner hands over, with a swappable settle handler. Deferred mode parks the
 * run's settle until `settle()` is called (in-flight / dispose tests).
 */
function makeExecutor() {
  const specs: {
    command: string
    stdin?: string
    workdir?: string
    signal?: AbortSignal
    env?: Record<string, string>
    timeoutMs?: number
    stdoutMaxBytes?: number
  }[] = []
  let handler: (spec: (typeof specs)[number]) => Promise<FakeRunResult> =
    async () => ({ exitCode: 0, timedOut: false, stdout: { text: 'HELLO FROM CMD\n' }, stderr: { text: '' } })
  let parked: ((result: FakeRunResult) => void) | undefined
  const service = {
    resolve: (req: (typeof specs)[number]) => req,
    run: (spec: (typeof specs)[number]): Promise<FakeRunResult> => {
      specs.push(spec)
      if (deferred) return new Promise<FakeRunResult>((resolvePromise) => { parked = resolvePromise })
      return handler(spec)
    },
  }
  let deferred = false
  return {
    service,
    specs,
    deferred(value: boolean): void { deferred = value },
    settle(result: FakeRunResult): void {
      const resolvePromise = parked
      parked = undefined
      resolvePromise?.(result)
    },
    setHandler(next: (spec: (typeof specs)[number]) => Promise<FakeRunResult>): void { handler = next },
  }
}

/**
 * Minimal ctx stub with the services the statusline wiring + driver consume.
 * `inject` only invokes its callback when a settings service is mounted — the
 * no-settings case must keep the whole feature inert (plan R2).
 */
function makeStatusLineCtx(opts: {
  projections?: ReturnType<typeof makeProjections>
  settings?: ReturnType<typeof makeSettings>
  executor?: ReturnType<typeof makeExecutor>
  persistence?: { locate(header: unknown): { path?: string } | undefined }
  createSession?: { id: string; provider?: string; model?: string; createdAt?: number; cwd?: string }
  resumeSessions?: Record<string, { id: string; cwd?: string }>
}) {
  const createSession = opts.createSession ?? { id: 's-a', provider: 'p', model: 'm1', createdAt: 1_000_000 }
  const services: Record<string, unknown> = {
    sessionProjections: opts.projections?.service,
    shell: opts.executor?.service,
    sessionPersistence: opts.persistence,
    // The permission-rules engine the permission-mode writepath needs.
    permissionRules: {
      ruleSet: { allow: [], deny: [], ask: [], bypassImmune: [] },
      setMode: () => {},
    },
  }
  if (opts.settings !== undefined) services.settings = opts.settings.service
  const makeAgent = (s: { id: string; provider?: string; model?: string; createdAt?: number; cwd?: string }) => ({
    options: s.provider === undefined ? {} : { provider: s.provider, model: s.model },
    session: {
      id: s.id,
      header: {
        ...(s.cwd === undefined ? {} : { cwd: s.cwd }),
        ...(s.createdAt === undefined ? {} : { createdAt: s.createdAt }),
      },
      events: [],
    },
    id: `agent-${s.id}`,
    status: 'idle',
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
  })
  const makeHandle = (s: { id: string; provider?: string; model?: string; createdAt?: number; cwd?: string }) => ({
    agent: makeAgent(s),
    dispose: async () => {},
  })
  const ctx: Record<string, unknown> = {
    get(key: string) {
      if (key === 'agentPresets') {
        return { defaultId: 'cc', resolve: async () => ({ id: 'cc' }), mount: async () => ({ id: 'cc' }) }
      }
      return services[key]
    },
    inject(_deps: string[], cb: (sctx: Record<string, unknown>) => void): void {
      if (services.settings === undefined) return
      cb({
        settings: services.settings,
        fiber: { state: 0 },
        effect: (factory: () => unknown) => { void factory() },
      })
    },
    on: () => () => {},
    fiber: { state: 0 },
    agents: {
      create: async () => makeHandle(createSession),
      resume: async (req: { resumeSessionId: string }) => {
        const s = opts.resumeSessions?.[req.resumeSessionId]
        if (s === undefined) throw new Error(`unknown session: ${req.resumeSessionId}`)
        return makeHandle({ ...s, provider: 'p', model: 'm1', createdAt: 1_000_000 })
      },
    },
  }
  return { ctx }
}

const usageState = (input: number, output: number) => ({
  totals: { uncachedInputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0 },
  last: null,
})

const activeSection = (overrides: Record<string, unknown> = {}) => ({
  type: 'command',
  command: 'statusline.sh',
  ...overrides,
})

async function bootActiveDriver(executor = makeExecutor(), section = activeSection()) {
  const settings = makeSettings(section)
  const projections = makeProjections()
  const { ctx } = makeStatusLineCtx({ projections, settings, executor })
  const driver = await createDriver(ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })
  return { driver, settings, projections, executor }
}

describe('createDriver custom statusLine wiring', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-statusline-'))
    process.env.DSH_HOME = tempHome
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('configured output replaces driver.statusLine and the payload rides stdin', async () => {
    const { driver, executor } = await bootActiveDriver(makeExecutor(), activeSection({ padding: 2 }))
    await vi.advanceTimersByTimeAsync(0)

    expect(executor.specs).toHaveLength(1)
    expect(driver.statusLine).toBe('  HELLO FROM CMD')
    expect(driver.statusLine).not.toContain('shift+tab')

    const spec = executor.specs[0]!
    const payload = JSON.parse(spec.stdin!) as Record<string, unknown>
    expect(payload).toMatchObject({
      session_id: 's-a',
      cwd: '/w/proj',
      model: { id: 'm1', display_name: 'm1' },
      cost: { total_duration_ms: expect.any(Number) },
    })
    expect('version' in payload).toBe(false)
    expect('output_style' in payload).toBe(false)
    expect('worktree' in payload).toBe(false)
    expect((payload.workspace as Record<string, unknown>).git_worktree).toBeUndefined()
    expect(spec.workdir).toBe('/w/proj')
    expect(spec.env!.COLUMNS).toBeDefined()
    expect(spec.env!.LINES).toBeDefined()
  })

  it('unconfigured sessions keep the built-in HUD byte-identical and create zero timers', async () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval')
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout')
    const bareCtx = makeStatusLineCtx({ projections: makeProjections() })
    const emptyCtx = makeStatusLineCtx({
      projections: makeProjections(),
      settings: makeSettings({}),
      executor: makeExecutor(),
    })
    const bare = await createDriver(bareCtx.ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })
    const empty = await createDriver(emptyCtx.ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })
    await vi.advanceTimersByTimeAsync(0)

    // Byte-identical to today's built-in value (driver-hud.spec semantics).
    expect(empty.statusLine).toBe(bare.statusLine)
    expect(empty.statusLine).toContain('shift+tab')
    // Zero polling: the statusline wiring never arms a refresh interval, and
    // the runner never exists so it schedules no debounce either.
    expect(setIntervalSpy).not.toHaveBeenCalled()
    const statuslineTimeouts = setTimeoutSpy.mock.calls.filter((args) => typeof args[0] === 'function'
      && String(args[0]).includes('spawn'))
    expect(statuslineTimeouts).toHaveLength(0)
    setIntervalSpy.mockRestore()
    setTimeoutSpy.mockRestore()
  })

  it('a tokenUsage projection change re-runs the command with fresh stdin JSON', async () => {
    const { driver, projections, executor } = await bootActiveDriver()
    await vi.advanceTimersByTimeAsync(0)
    expect(executor.specs).toHaveLength(1)

    projections.fire('s-a', 'tokenUsage', usageState(1234, 345))
    await vi.advanceTimersByTimeAsync(300)
    expect(executor.specs).toHaveLength(2)
    const payload = JSON.parse(executor.specs[1]!.stdin!) as Record<string, unknown>
    expect((payload.context_window as Record<string, unknown>).total_input_tokens).toBe(1234)
    expect((payload.context_window as Record<string, unknown>).total_output_tokens).toBe(345)
    // Fresh JSON, not a stale echo of the boot payload.
    expect(JSON.parse(executor.specs[0]!.stdin!).context_window).toBeUndefined()
    expect(driver.statusLine).toBe('HELLO FROM CMD')
  })

  it('a failing command (exit 3) blanks the line', async () => {
    const executor = makeExecutor()
    executor.setHandler(async () => ({ exitCode: 3, timedOut: false, stdout: { text: '' }, stderr: { text: 'boom' } }))
    const { driver } = await bootActiveDriver(executor, activeSection({ padding: 0 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(driver.statusLine).toBe('')
  })

  it('flipping the section inactive mid-session restores the built-in HUD; a command swap runs immediately', async () => {
    const { driver, settings, executor } = await bootActiveDriver()
    await vi.advanceTimersByTimeAsync(0)
    expect(executor.specs).toHaveLength(1)

    // Deactivate: built-in returns mid-session, no further runs.
    settings.commit({ type: 'none' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(driver.statusLine).toContain('shift+tab')
    expect(executor.specs).toHaveLength(1)

    // Reactivate with a different command: the command change skips the
    // debounce — the spawn happens synchronously with the commit (C5); only
    // the child's settle is a microtask away.
    executor.setHandler(async () => ({ exitCode: 0, timedOut: false, stdout: { text: 'SECOND\n' }, stderr: { text: '' } }))
    settings.commit(activeSection({ command: 'other.sh' }))
    expect(executor.specs).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(0)
    expect(driver.statusLine).toBe('SECOND')
  })

  it('a /resume-style rebind re-runs with the new session id', async () => {
    const settings = makeSettings(activeSection())
    const projections = makeProjections()
    const executor = makeExecutor()
    const { ctx } = makeStatusLineCtx({
      projections,
      settings,
      executor,
      resumeSessions: { 's-b': { id: 's-b', cwd: '/other/dir' } },
    })
    const driver = await createDriver(ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })
    await vi.advanceTimersByTimeAsync(0)
    expect(executor.specs).toHaveLength(1)

    await driver.switchSession('s-b')
    await vi.advanceTimersByTimeAsync(300)
    const payload = JSON.parse(executor.specs.at(-1)!.stdin!) as Record<string, unknown>
    expect(payload.session_id).toBe('s-b')
  })

  it('a permission-mode change triggers a re-run via the emit-diff wrapper', async () => {
    const { driver, executor } = await bootActiveDriver()
    await vi.advanceTimersByTimeAsync(0)
    expect(executor.specs).toHaveLength(1)

    driver.cyclePermissionMode()
    await vi.advanceTimersByTimeAsync(300)
    expect(executor.specs.length).toBeGreaterThanOrEqual(2)
  })

  it('refreshInterval:1 arms exactly one interval while active; deactivate and dispose clear it', async () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval')
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval')
    const { driver, settings, executor } = await bootActiveDriver(makeExecutor(), activeSection({ refreshInterval: 1 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(setIntervalSpy).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5000)
    // 1s interval over 5s → at least 4 extra runs (first tick lands at 1s).
    const intervalRuns = executor.specs.length - 1
    expect(intervalRuns).toBeGreaterThanOrEqual(4)

    // Deactivation clears the interval; reactivation arms exactly one again.
    const clearsBefore = clearIntervalSpy.mock.calls.length
    settings.commit({ type: 'none' })
    expect(clearIntervalSpy.mock.calls.length).toBe(clearsBefore + 1)
    const specsAfterDeactivate = executor.specs.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(executor.specs.length).toBe(specsAfterDeactivate)

    settings.commit(activeSection({ refreshInterval: 1 }))
    expect(setIntervalSpy).toHaveBeenCalledTimes(2)

    await driver.dispose()
    expect(clearIntervalSpy.mock.calls.length).toBeGreaterThan(clearsBefore + 1)
    setIntervalSpy.mockRestore()
    clearIntervalSpy.mockRestore()
  })

  it('dispose() during an in-flight run leaves no timers behind and the late settle is ignored', async () => {
    const executor = makeExecutor()
    executor.deferred(true)
    const { driver } = await bootActiveDriver(executor)
    await vi.advanceTimersByTimeAsync(0)
    expect(executor.specs).toHaveLength(1)

    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout')
    await driver.dispose()
    // No debounce timer survives the dispose (S3): the runner was aborted and
    // every pending timeout cleared.
    expect(clearTimeoutSpy).toHaveBeenCalled()
    // A late settle after dispose must not resurrect the line.
    executor.settle({ exitCode: 0, timedOut: false, stdout: { text: 'LATE\n' }, stderr: { text: '' } })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(driver.statusLine).not.toBe('LATE')
    clearTimeoutSpy.mockRestore()
  })
})
