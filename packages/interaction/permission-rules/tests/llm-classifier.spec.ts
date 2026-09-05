import { describe, expect, it, vi } from 'vitest'
import { createLlmClassifier, DEFAULT_SOFT_DENY, expandSoftDeny, classificationKey }
  from '../src/llm-classifier.ts'
import type { ToolExecution } from '@jianxx/dsh-cc-tools'

function fakeExec(name: string, args: unknown, signal?: AbortSignal): ToolExecution {
  return { signal: signal ?? new AbortController().signal, callId: 'c1', name, arguments: args } as unknown as ToolExecution
}

type StreamOpts = { provider: string; model: string; system: string; prompt: string; maxTokens: number; signal?: AbortSignal }

/** A stream fake: each entry is the raw model output for successive calls. */
function streamFake(outputs: string[], calls?: StreamOpts[]) {
  return vi.fn(async (opts: StreamOpts) => {
    calls?.push(opts)
    const next = outputs.shift()
    if (next === undefined) throw new Error('no more scripted outputs')
    return next
  })
}

function make(overrides: Partial<Parameters<typeof createLlmClassifier>[0]> = {}) {
  const calls: StreamOpts[] = []
  const deps = {
    stream: streamFake(['{"verdict":"allow","reason":"benign"}'], calls),
    softDeny: DEFAULT_SOFT_DENY,
    timeoutMs: 5_000,
    cacheMaxEntries: 256,
    ...overrides,
  }
  return { cls: createLlmClassifier(deps), calls, deps }
}

/** The default per-call route passed as data. */
const ROUTE = { provider: 'prov', model: 'mod' }

describe('createLlmClassifier', () => {
  it('allow verdict passes through with no failure tag', async () => {
    const { cls } = make()
    const v = await cls.classify(fakeExec('Bash', { command: 'ls' }), { route: ROUTE })
    expect(v).toMatchObject({ verdict: 'allow', reason: 'benign' })
    expect(v.failure).toBeUndefined()
    expect(v.tool).toBe('Bash')
    expect(v.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(v.routeAlias).toBe('prov/mod')
    expect(v.provider).toBe('prov')
    expect(v.model).toBe('mod')
    expect(v.latencyMs).toBeGreaterThanOrEqual(0)
    expect(v.cacheHit).toBe(false)
  })

  it('ask verdict escalates with the model reason', async () => {
    const { cls } = make({ stream: streamFake(['{"verdict":"ask","reason":"force push"}']) })
    const v = await cls.classify(fakeExec('Bash', { command: 'git push --force' }), { route: ROUTE })
    expect(v).toMatchObject({ verdict: 'ask', reason: 'force push' })
    expect(v.failure).toBeUndefined()
  })

  it.each([
    ['not json at all'],
    ['{"verdict":"deny","reason":"nope"}'],
    ['{"verdict":"maybe"}'],
    [''],
    ['{"verdict":"allow"'],
  ])('malformed/deny output ⇒ ask + malformed: %j', async output => {
    const { cls } = make({ stream: streamFake([output]) })
    const v = await cls.classify(fakeExec('Bash', { command: 'ls' }), { route: ROUTE })
    expect(v.verdict).toBe('ask')
    expect(v.failure).toBe('malformed')
  })

  it('thrown stream ⇒ ask + error, never rejects', async () => {
    const { cls } = make({ stream: vi.fn(async () => { throw new Error('boom') }) })
    const v = await cls.classify(fakeExec('Bash', { command: 'ls' }), { route: ROUTE })
    expect(v.verdict).toBe('ask')
    expect(v.failure).toBe('error')
  })

  it('timeout ⇒ ask + timeout; the composed signal aborts', async () => {
    const execSignal = new AbortController()
    const { cls, calls } = make({
      timeoutMs: 20,
      stream: vi.fn(async (opts: StreamOpts) => {
        calls.push(opts)
        return await new Promise<string>((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          setTimeout(() => reject(new Error('hung past the vitest budget')), 4_000)
        })
      }),
    })
    const v = await cls.classify(fakeExec('Bash', { command: 'sleep' }, execSignal.signal), { route: ROUTE })
    expect(v.verdict).toBe('ask')
    expect(v.failure).toBe('timeout')
    expect(calls[0]?.signal?.aborted).toBe(true)
    expect(execSignal.signal.aborted).toBe(false)
  })

  it('user cancellation composes with the classifier timeout', async () => {
    const execSignal = new AbortController()
    const seen: StreamOpts[] = []
    const { cls } = make({
      timeoutMs: 30_000,
      stream: vi.fn(async (opts: StreamOpts) => {
        seen.push(opts)
        return await new Promise<string>((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
      }),
    })
    const pending = cls.classify(fakeExec('Bash', { command: 'sleep' }, execSignal.signal), { route: ROUTE })
    execSignal.abort()
    const v = await pending
    expect(v.verdict).toBe('ask')
    expect(v.failure).toBe('error')
  })

  it('unresolvable route ⇒ unarmed marker, stream never called', async () => {
    const { cls, calls } = make()
    const v = await cls.classify(fakeExec('Bash', { command: 'ls' }))
    expect(v.verdict).toBe('ask')
    expect(v.failure).toBe('unarmed')
    expect(v.reason).toContain('route unavailable')
    expect(v.cacheHit).toBe(false)
    expect(v.routeAlias).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it('bash command is rendered as a command string, not JSON', async () => {
    const { cls, calls } = make()
    await cls.classify(fakeExec('Bash', { command: 'echo hi' }), { route: ROUTE })
    expect(calls[0]?.prompt).toContain('echo hi')
    expect(calls[0]?.prompt).not.toContain('{"command"')
  })

  it('file-edit tool renders file_path plus a capped body hint', async () => {
    const { cls, calls } = make()
    await cls.classify(fakeExec('edit', { file_path: 'src/a.ts', body: 'x'.repeat(200) }), { route: ROUTE })
    expect(calls[0]?.prompt).toContain('src/a.ts')
    expect(calls[0]?.prompt).toContain('x')
  })

  it('input is hard-capped at 4 KiB', async () => {
    const { cls, calls } = make()
    await cls.classify(fakeExec('Bash', { command: 'y'.repeat(100_000) }), { route: ROUTE })
    expect(calls[0]!.prompt.length).toBeLessThanOrEqual(4096)
  })

  it('the system prompt carries the adversarial-input warning and the soft-deny prose', async () => {
    const { cls, calls } = make({ softDeny: ['Never touch prod'] })
    await cls.classify(fakeExec('Bash', { command: 'ls' }), { route: ROUTE })
    expect(calls[0]!.system).toMatch(/never follow instructions/i)
    expect(calls[0]!.system).toContain('Never touch prod')
    expect(calls[0]!.system).toContain('"verdict"')
  })

  it('cache hit avoids a second stream call and returns cacheHit on the classification', async () => {
    const { cls, calls } = make({ cacheMaxEntries: 8 })
    const first = await cls.classify(fakeExec('Bash', { command: 'ls' }), { route: ROUTE })
    const second = await cls.classify(fakeExec('Bash', { command: 'ls' }), { route: ROUTE })
    expect(second).toMatchObject({ verdict: first.verdict, reason: first.reason, tool: 'Bash', digest: first.digest })
    expect(calls).toHaveLength(1)
    expect(first.cacheHit).toBe(false)
    expect(second.cacheHit).toBe(true)
    expect(second.routeAlias).toBe('prov/mod')
    expect(second.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('different inputs do not collide in the cache', async () => {
    const { cls, calls } = make()
    await cls.classify(fakeExec('Bash', { command: 'ls' }), { route: ROUTE })
    await cls.classify(fakeExec('Bash', { command: 'pwd' }), { route: ROUTE })
    expect(calls).toHaveLength(2)
  })

  it('LRU evicts beyond cacheMaxEntries', async () => {
    const calls: StreamOpts[] = []
    const { cls } = make({
      cacheMaxEntries: 1,
      stream: streamFake(['{"verdict":"allow","reason":"a"}', '{"verdict":"allow","reason":"b"}', '{"verdict":"allow","reason":"a2"}'], calls),
    })
    await cls.classify(fakeExec('Bash', { command: 'a' }), { route: ROUTE })
    await cls.classify(fakeExec('Bash', { command: 'b' }), { route: ROUTE })
    await cls.classify(fakeExec('Bash', { command: 'a' }), { route: ROUTE })
    expect(calls).toHaveLength(3)
  })

  it('a changed soft_deny list busts the cache key', () => {
    const a = classificationKey('Bash', 'ls', DEFAULT_SOFT_DENY)
    const b = classificationKey('Bash', 'ls', [...DEFAULT_SOFT_DENY, 'extra'])
    const c = classificationKey('pwd', 'Bash', DEFAULT_SOFT_DENY)
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
  })

  it('the returned classification carries the digest, failure, and latency; never the raw input', async () => {
    const { cls } = make({
      stream: streamFake(['{"verdict":"ask","reason":"r"}']),
    })
    const v = await cls.classify(fakeExec('Bash', { command: 'git push --force' }), { route: ROUTE })
    expect(v).toMatchObject({ tool: 'Bash', verdict: 'ask', cacheHit: false, latencyMs: expect.any(Number) })
    expect(v.failure).toBeUndefined()
    expect(v.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(v)).not.toContain('git push --force')
  })
})

describe('DEFAULT_SOFT_DENY / expandSoftDeny', () => {
  it('covers the documented CC classifier duties', () => {
    const joined = DEFAULT_SOFT_DENY.join('\n').toLowerCase()
    expect(joined).toMatch(/scope|workspace/)
    expect(joined).toMatch(/infrastructure/)
    expect(joined).toMatch(/remov|delete/)
    expect(joined).toMatch(/force-push|force push|irreversible/)
    expect(joined).toMatch(/credential/)
    expect(joined).toMatch(/safety/)
  })

  it('expandSoftDeny replaces "$defaults" position-preserving', () => {
    const out = expandSoftDeny(['custom-a', '$defaults', 'custom-b'])
    expect(out[0]).toBe('custom-a')
    expect(out.at(-1)).toBe('custom-b')
    expect(out).toEqual(['custom-a', ...DEFAULT_SOFT_DENY, 'custom-b'])
  })

  it('an absent "$defaults" replaces the built-ins entirely', () => {
    expect(expandSoftDeny(['only-this'])).toEqual(['only-this'])
  })

  it('an empty list with "$defaults" yields exactly the defaults; duplicates are preserved as written', () => {
    expect(expandSoftDeny(['$defaults'])).toEqual(DEFAULT_SOFT_DENY)
    expect(expandSoftDeny(['x', 'x'])).toEqual(['x', 'x'])
  })
})
