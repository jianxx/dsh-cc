import { describe, expect, it } from 'vitest'
import {
  analyzeSessionCache,
  compareForkPrefix,
  type SessionLogEvent,
} from '../src/index.ts'

/**
 * Session-log cache forensics (2026-09 subagent cache investigation): folds a
 * durable session event log into per-request cache usage attributed to the
 * route that served it, and classifies the dominant cache pattern observed in
 * production logs — healthy accumulation, single-slot delta-only caching
 * (read(N) tracks input(N-1), ceiling ~50%), and no-cache-accounting segments
 * (provider failover with read=0 and write=0).
 * TDD red layer — pins the API before the module exists.
 */

/** assistant/message event carrying usage, at time t. */
const REQ = (t: number, input: number, read: number, write = 0): SessionLogEvent => ({
  type: 'assistant/message',
  time: t,
  data: { usage: { inputTokens: input, cacheReadTokens: read, cacheWriteTokens: write } },
})

/** request/context route attribution event. */
const ROUTE = (provider: string, model: string): SessionLogEvent => ({
  type: 'request/context',
  data: { provider, model },
})

const MIN = 60_000

describe('analyzeSessionCache', () => {
  it('classifies accumulating prefixes as healthy and excludes the structural first request', () => {
    // Signature of a healthy kimi-k3 session: first request all-miss, then
    // readShare climbs toward 1 as the prefix accumulates.
    const events = [
      ROUTE('orchestrix', 'llmbox_ant/kimi-k3'),
      REQ(0, 1495, 0, 18432),
      REQ(30_000, 556, 19968),
      REQ(60_000, 461, 226048),
      REQ(90_000, 514, 226304),
    ]
    const analysis = analyzeSessionCache(events)
    expect(analysis.pattern).toBe('healthy')
    expect(analysis.requestCount).toBe(4)
    expect(analysis.firstRequestPromptTotal).toBe(1495 + 18432)
    // steady = requests[1:]: read 268240 / total 268? — read dominates.
    expect(analysis.steadyReadShare).toBeGreaterThan(0.95)
    expect(analysis.routes).toEqual([
      expect.objectContaining({ provider: 'orchestrix', model: 'llmbox_ant/kimi-k3', requests: 4 }),
    ])
  })

  it('detects single-slot delta-only caching where read(N) tracks input(N-1)', () => {
    // Signature of the grok-4.6 sessions: readShare pinned near 0.5 while the
    // prompt grows; each request reads only the previous request's fresh span.
    const events = [
      ROUTE('orchestrix', 'xai_oauth/grok-4.6'),
      REQ(0, 25797, 128),
      REQ(40_000, 30775, 128),
      REQ(80_000, 34080, 30720),
      REQ(120_000, 36492, 34048),
      REQ(160_000, 38009, 36480),
      REQ(200_000, 48243, 38000),
    ]
    const analysis = analyzeSessionCache(events)
    expect(analysis.pattern).toBe('single-slot')
    expect(analysis.findings.some(f => f.includes('single-slot'))).toBe(true)
    // Healthy accumulation would read ~the whole previous prompt, not the
    // previous input span; the steady share must stay far below 1.
    expect(analysis.steadyReadShare).toBeLessThan(0.6)
  })

  it('flags zero-accounting segments and attributes them to their route', () => {
    // Signature of the kimi-coding failover tail: read=0 AND write=0 while the
    // prompt is huge — the provider neither reads nor writes cache.
    const events = [
      ROUTE('orchestrix', 'llmbox_ant/kimi-k3'),
      REQ(0, 447, 0, 12288),
      REQ(30_000, 2554, 164352),
      ROUTE('kimi-coding', 'k3-256k'),
      REQ(60_000, 167738, 0, 0),
      REQ(90_000, 167990, 0, 0),
      REQ(120_000, 168353, 0, 0),
    ]
    const analysis = analyzeSessionCache(events)
    expect(analysis.pattern).toBe('no-cache-accounting')
    expect(analysis.findings.some(f => f.includes('kimi-coding/k3-256k'))).toBe(true)
    expect(analysis.findings.some(f => f.includes('route changed'))).toBe(true)
    const failover = analysis.routes.find(r => r.provider === 'kimi-coding')
    expect(failover).toEqual(expect.objectContaining({ requests: 3, cacheReadTokens: 0 }))
  })

  it('reports per-gap-bucket read shares so TTL decay is visible without flipping the verdict', () => {
    // Healthy short-gap requests plus one long-gap request that lost its cache
    // entry (TTL) — pattern stays healthy, the >15m bucket exposes the decay.
    const events = [
      ROUTE('orchestrix', 'llmbox_ant/kimi-k3'),
      REQ(0, 1000, 0, 18000),
      REQ(30_000, 500, 19000),
      REQ(60_000, 500, 19500),
      REQ(60_000 + 20 * MIN, 14000, 6000),
    ]
    const analysis = analyzeSessionCache(events)
    expect(analysis.pattern).toBe('healthy')
    const longGap = analysis.gapBuckets.find(b => b.label === '>15m')
    expect(longGap).toEqual(expect.objectContaining({ requests: 1 }))
    expect(longGap?.readShare).toBeLessThan(0.5)
    expect(analysis.findings.some(f => f.includes('>15m'))).toBe(true)
  })

  it('returns insufficient-data below three requests with usage', () => {
    const analysis = analyzeSessionCache([ROUTE('p', 'm'), REQ(0, 10, 0, 5)])
    expect(analysis.pattern).toBe('insufficient-data')
    expect(analysis.requestCount).toBe(1)
  })

  it('reports mixed when no signature dominates and the steady share is middling', () => {
    // A route that mostly runs without cache accounting but not ≥60% of
    // requests, with the rest healthy — no single story, so no clean verdict.
    const events = [
      ROUTE('orchestrix', 'llmbox_ant/glm-5.2'),
      REQ(0, 1000, 0, 18000),
      REQ(30_000, 19000, 0, 0),
      REQ(60_000, 19500, 0, 0),
      REQ(90_000, 20000, 3000),
      REQ(120_000, 500, 39500),
    ]
    const analysis = analyzeSessionCache(events)
    expect(analysis.pattern).toBe('mixed')
    expect(analysis.findings.some(f => f.includes('zero cache accounting'))).toBe(true)
  })

  it('skips assistant messages without usage and leaves route undefined before any context event', () => {
    const events = [
      { type: 'assistant/message', time: 0, data: {} },
      REQ(10_000, 100, 0, 50),
      REQ(20_000, 60, 150),
      REQ(30_000, 70, 210),
    ]
    const analysis = analyzeSessionCache(events)
    expect(analysis.requestCount).toBe(3)
    expect(analysis.requests[0]?.route).toBeUndefined()
    expect(analysis.pattern).toBe('healthy')
  })
})

describe('compareForkPrefix', () => {
  const HEADER = (provider: string, model: string, system: string): SessionLogEvent => ({
    type: 'request/header',
    data: { header: { config: { provider, model }, system } },
  })

  it('pins the plain-fork invariant: child head is byte-identical to the parent', () => {
    const parent = [HEADER('orchestrix', 'llmbox_ant/kimi-k3', 'SYSTEM-V1')]
    const child = [HEADER('orchestrix', 'llmbox_ant/kimi-k3', 'SYSTEM-V1')]
    const comparison = compareForkPrefix(parent, child)
    expect(comparison).toEqual(expect.objectContaining({
      sameRoute: true,
      systemIdentical: true,
      divergenceByte: undefined,
    }))
  })

  it('locates the first divergence byte when a persona section shadows the head', () => {
    const parent = [HEADER('orchestrix', 'llmbox_ant/kimi-k3', 'AAAA deployment persona BBBB')]
    const child = [HEADER('orchestrix', 'llmbox_ant/kimi-k3', 'AAAA child persona BBBB')]
    const comparison = compareForkPrefix(parent, child)
    expect(comparison?.systemIdentical).toBe(false)
    expect(comparison?.divergenceByte).toBe(5)
    expect(comparison?.divergenceExcerpt).toContain('child persona')
  })

  it('reports a route change (cache namespaces never share across models)', () => {
    const parent = [HEADER('orchestrix', 'llmbox_ant/kimi-k3', 'S')]
    const child = [HEADER('orchestrix', 'zai/glm-5.3', 'S')]
    const comparison = compareForkPrefix(parent, child)
    expect(comparison?.sameRoute).toBe(false)
    expect(comparison?.systemIdentical).toBe(true)
  })

  it('is undefined when either side never recorded a request header', () => {
    expect(compareForkPrefix([], [HEADER('p', 'm', 'S')])).toBeUndefined()
    expect(compareForkPrefix([HEADER('p', 'm', 'S')], [])).toBeUndefined()
  })
})
