import { describe, expect, it, vi } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecution } from '@jianxx/dsh-cc-tools'
import type { RiskAssessment } from '../src/classifier.ts'
import type { DecidedCall } from '../src/decide.ts'
import type { PermissionDecision, PermissionMode } from '../src/types.ts'
import {
  CLASSIFIER_EVENT,
  createAutoStage,
  foldClassifiers,
  appendSessionClassifier,
  type AutoStageDeps,
} from '../src/auto-stage.ts'

function exec(opts: { name?: string; args?: unknown; session?: Session; signal?: AbortSignal } = {}): ToolExecution {
  const signal = opts.signal ?? new AbortController().signal
  const agent = opts.session === undefined ? undefined : { id: 'a1', session: opts.session } as unknown as ToolExecution['agent']
  return {
    signal,
    callId: 'c1',
    name: opts.name ?? 'Bash',
    arguments: opts.args ?? { command: 'ls' },
    ...(agent === undefined ? {} : { agent }),
  } as unknown as ToolExecution
}

function sessionOf(id: string): Session {
  return Session.create(SessionId(id), undefined, { version: 0, id: SessionId(id), createdAt: Date.now(), cwd: '/work' })
}

function decided(overrides: Partial<DecidedCall> = {}): DecidedCall {
  const decision: PermissionDecision = overrides.decision ?? { kind: 'ask', reason: 'rule ask' }
  const risk: RiskAssessment = overrides.risk ?? { level: 'LOW', reasons: [] }
  const mode: PermissionMode = overrides.mode ?? 'auto'
  return { decision, risk, mode }
}

interface Harness {
  deps: AutoStageDeps
  settings: { value: Record<string, unknown> }
  streams: number
  scripted: string[]
  warnings: string[]
  route: { provider: string; model: string } | undefined
  settingsWrites: number
}

function harness(overrides: Partial<Harness> = {}): Harness {
  const h: Harness = {
    settings: { value: {} },
    streams: 0,
    scripted: [],
    warnings: [],
    route: { provider: 'fake', model: 'classifier-model' },
    settingsWrites: 0,
    ...overrides,
  }
  h.deps = {
    settingsRead: () => h.settings.value,
    stream: async () => { h.streams += 1; return h.scripted.shift() ?? '{"verdict":"allow","reason":"ok"}' },
    resolveRoute: () => h.route,
    warn: (message: string) => { h.warnings.push(message) },
    audit: vi.fn(),
  } as AutoStageDeps
  return h
}

describe('auto-stage arming (per call)', () => {
  it('disarmed (classifier disabled): never consults the LLM, never warns', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: false } } }
    const stage = createAutoStage(h.deps)
    const out = await stage.maybeEscalate(decided(), exec())
    expect(out).toBeUndefined()
    expect(h.streams).toBe(0)
    expect(h.warnings).toHaveLength(0)
    expect(h.deps.audit).not.toHaveBeenCalled()
  })

  it('no autoMode section at all: disarmed, silent', async () => {
    const h = harness()
    const stage = createAutoStage(h.deps)
    expect(await stage.maybeEscalate(decided(), exec())).toBeUndefined()
    expect(h.streams).toBe(0)
    expect(h.warnings).toHaveLength(0)
  })

  it('armed: consults the classifier only for auto + LOW + ask/passthrough (verdict allow ⇒ allow)', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    const stage = createAutoStage(h.deps)
    expect(await stage.maybeEscalate(decided(), exec())).toBe('allow')
    expect(h.streams).toBe(1)
  })

  it('armed: ask verdict ⇒ ask with the classifier reason (escalate-only)', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    h.scripted = ['{"verdict":"ask","reason":"terraform apply"}']
    const stage = createAutoStage(h.deps)
    expect(await stage.maybeEscalate(decided(), exec())).toEqual({ kind: 'ask', reason: 'terraform apply' })
  })

  it('malformed model output ⇒ ask (I4; failure parsing lives in the classifier core)', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    h.scripted = ['not json at all']
    const stage = createAutoStage(h.deps)
    const out = await stage.maybeEscalate(decided(), exec())
    expect(out).toMatchObject({ kind: 'ask' })
    expect(String((out as { reason: string }).reason)).toMatch(/unparseable/)
  })
})

describe('auto-stage eligibility gates (invariants I1–I3, I5)', () => {
  it('I1: classifier-HIGH ⇒ no escalation — the LLM is never invoked', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    const stage = createAutoStage(h.deps)
    const out = await stage.maybeEscalate(decided({ risk: { level: 'HIGH', reasons: ['x'] }, decision: { kind: 'deny', reason: 'blocked' } }), exec())
    expect(out).toBeUndefined()
    expect(h.streams).toBe(0)
  })

  it('I2: rule deny ⇒ no escalation, LLM never invoked', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    const stage = createAutoStage(h.deps)
    const out = await stage.maybeEscalate(decided({ decision: { kind: 'deny', reason: 'deny rule' } }), exec())
    expect(out).toBeUndefined()
    expect(h.streams).toBe(0)
  })

  it('I3: plan mode ⇒ no escalation, LLM never invoked', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    const stage = createAutoStage(h.deps)
    const out = await stage.maybeEscalate(decided({ mode: 'plan' }), exec())
    expect(out).toBeUndefined()
    expect(h.streams).toBe(0)
  })

  it('I5: MEDIUM risk ⇒ no escalation regardless of stage state', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    const stage = createAutoStage(h.deps)
    const out = await stage.maybeEscalate(decided({ risk: { level: 'MEDIUM', reasons: ['outside cwd'] } }), exec())
    expect(out).toBeUndefined()
    expect(h.streams).toBe(0)
  })

  it('armed but mode=default ⇒ no escalation (N1: only auto is vetted)', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    const stage = createAutoStage(h.deps)
    expect(await stage.maybeEscalate(decided({ mode: 'default' }), exec())).toBeUndefined()
    expect(h.streams).toBe(0)
  })

  it('armed but decision already allow/deny ⇒ no escalation', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    const stage = createAutoStage(h.deps)
    expect(await stage.maybeEscalate(decided({ decision: { kind: 'allow' } }), exec())).toBeUndefined()
    expect(await stage.maybeEscalate(decided({ decision: { kind: 'deny', reason: 'x' } }), exec())).toBeUndefined()
    expect(h.streams).toBe(0)
  })
})

describe('enabled-but-unarmable ⇒ disarm + warn ONCE + unarmed audit', () => {
  it('no resolvable route: warns once per process, appends one unarmed audit event, falls back to legacy', async () => {
    const h = harness()
    h.route = undefined
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    const session = sessionOf('unarmed-1')
    const stage = createAutoStage(h.deps)
    const execWithSession = exec({ session })
    expect(await stage.maybeEscalate(decided(), execWithSession)).toBeUndefined()
    expect(await stage.maybeEscalate(decided(), execWithSession)).toBeUndefined()
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0]).toMatch(/classifier|route|unarm/i)
    // The unarmed audit event is per call (each fell back to the legacy path);
    // the warning is the once-per-process half.
    expect(h.deps.audit).toHaveBeenCalledTimes(2)
    expect(h.deps.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ failure: 'unarmed' }))
  })

  it('no llm stream capability mounted: disarmed with one warning', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    h.deps.stream = undefined
    const stage = createAutoStage(h.deps)
    expect(await stage.maybeEscalate(decided(), exec())).toBeUndefined()
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0]).toMatch(/classifier|route|unarm/i)
  })
})

describe('classifier memoization (settings-slice rebuild)', () => {
  it('reuses the classifier across calls with an unchanged autoMode slice (cache holds)', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    const stage = createAutoStage(h.deps)
    const e = exec()
    await stage.maybeEscalate(decided(), e)
    await stage.maybeEscalate(decided(), e)
    // Same tool + input + soft-deny list ⇒ cache hit ⇒ only one stream call.
    expect(h.streams).toBe(1)
  })

  it('rebuilds when the autoMode slice changes (changed soft_deny busts the cache)', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    const stage = createAutoStage(h.deps)
    const e = exec()
    await stage.maybeEscalate(decided(), e)
    h.settingsWrites += 1
    h.settings.value = { autoMode: { classifier: { enabled: true }, soft_deny: ['never touch prod'] } }
    stage.rebuild()
    await stage.maybeEscalate(decided(), e)
    expect(h.streams).toBe(2)
  })

  it('rebuild() with an unchanged slice keeps the memoized classifier', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    const stage = createAutoStage(h.deps)
    const e = exec()
    await stage.maybeEscalate(decided(), e)
    stage.rebuild()
    await stage.maybeEscalate(decided(), e)
    expect(h.streams).toBe(1)
  })
})

describe('concurrent maybeEscalate audit attribution', () => {
  it('two in-flight calls on different sessions land each verdict audit on its own session', async () => {
    const h = harness()
    h.settings.value = { autoMode: { classifier: { enabled: true } } }
    // Deferred streams: each call's in-flight promise resolves only when we release it.
    const gates: Array<(value: string) => void> = []
    h.deps.stream = () => new Promise<string>(resolve => { gates.push(resolve) })
    const sessionA = sessionOf('conc-a')
    const sessionB = sessionOf('conc-b')
    const eA = exec({ session: sessionA, args: { command: 'cmd-a' } })
    const eB = exec({ session: sessionB, args: { command: 'cmd-b' } })
    const stage = createAutoStage(h.deps)
    const pA = stage.maybeEscalate(decided(), eA)
    const pB = stage.maybeEscalate(decided(), eB)
    // B's stream settles first, then A's — the interleaving that scrambled the old ambient fields.
    gates[1]!('{"verdict":"ask","reason":"from-b"}')
    gates[0]!('{"verdict":"allow","reason":"from-a"}')
    expect(await pA).toBe('allow')
    expect(await pB).toEqual({ kind: 'ask', reason: 'from-b' })
    const calls = (h.deps.audit as ReturnType<typeof vi.fn>).mock.calls as Array<[Session, { verdict: string; failure?: string }]>
    expect(calls).toHaveLength(2)
    const verdictFor = (session: Session): string | undefined =>
      calls.filter(([s]) => s === session).map(([, e]) => e.verdict)[0]
    expect(verdictFor(sessionA)).toBe('allow')
    expect(verdictFor(sessionB)).toBe('ask')
  })
})

describe('permission/classifier audit event (fold/replay round-trip)', () => {
  it('registers the event type and round-trips appended events through the fold', () => {
    const session = sessionOf('audit-1')
    appendSessionClassifier(session, {
      tool: 'Bash',
      digest: 'a'.repeat(64),
      verdict: 'allow',
      route: 'fake/classifier-model',
      provider: 'fake',
      model: 'classifier-model',
      latencyMs: 12,
      cacheHit: false,
    })
    appendSessionClassifier(session, {
      tool: 'Bash',
      digest: 'b'.repeat(64),
      verdict: 'ask',
      failure: 'timeout',
      latencyMs: 5001,
      cacheHit: false,
    })
    const folded = foldClassifiers(session.events)
    expect(folded).toHaveLength(2)
    expect(folded[0]).toMatchObject({ tool: 'Bash', verdict: 'allow', cacheHit: false })
    expect(folded[0]?.digest).toBe('a'.repeat(64))
    expect(folded[1]).toMatchObject({ tool: 'Bash', verdict: 'ask', failure: 'timeout' })
    // The session log never carries raw input — only the digest.
    const raw = JSON.stringify(session.events)
    expect(raw).not.toContain('command')
    expect(folded.every(record => record.digest === undefined || /^[0-9a-f]{64}$/.test(record.digest))).toBe(true)
  })

  it('skips foreign event types', () => {
    const session = sessionOf('audit-2')
    session.append('permission/mode', { mode: 'auto' })
    appendSessionClassifier(session, { tool: 'Bash', digest: 'c'.repeat(64), verdict: 'ask', latencyMs: 1, cacheHit: false })
    expect(foldClassifiers(session.events)).toHaveLength(1)
  })
})
