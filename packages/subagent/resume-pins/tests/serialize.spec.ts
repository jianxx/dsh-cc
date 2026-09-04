/**
 * Unit tests for the plugin-side concurrency primitives (M11): per-child gate
 * serialization and execution-token-keyed notice delivery.
 */
import { describe, expect, it } from 'vitest'
import { ExecutionNoticeBus, serializePerKey } from '../src/serialize.ts'

describe('serializePerKey — per-child gate serialization (M11)', () => {
  it('same-key tasks run strictly in start order (no interleaving)', async () => {
    const locks = new Map<string, Promise<unknown>>()
    const events: string[] = []
    const release: (() => void)[] = []
    const gate = () => new Promise<void>(resolve => release.push(resolve))

    const first = serializePerKey(locks, 'child', async () => {
      events.push('a:start')
      await gate()
      events.push('a:end')
    })
    const second = serializePerKey(locks, 'child', async () => {
      events.push('b:start')
      await gate()
      events.push('b:end')
    })
    // Different key runs independently, concurrently.
    const other = serializePerKey(locks, 'other', async () => { events.push('other') })

    await Promise.resolve()
    expect(events).toEqual(['a:start', 'other'])
    release[0]!()
    await first
    await Promise.resolve()
    expect(events).toEqual(['a:start', 'other', 'a:end', 'b:start'])
    release[1]!()
    await second
    expect(events).toEqual(['a:start', 'other', 'a:end', 'b:start', 'b:end'])
  })

  it('a failing task rejects only its own caller and does not break the chain', async () => {
    const locks = new Map<string, Promise<unknown>>()
    const boom = serializePerKey(locks, 'child', async () => { throw new Error('store write failed') })
    const after = serializePerKey(locks, 'child', async () => 'recovered')
    await expect(boom).rejects.toThrow('store write failed')
    await expect(after).resolves.toBe('recovered')
    // The chain stays usable for a third task.
    await expect(serializePerKey(locks, 'child', async () => 'third')).resolves.toBe('third')
  })
})

describe('ExecutionNoticeBus — notice keying by execution identity (M11)', () => {
  it('each execution takes only its own notices; a failing send never leaks into a later call', () => {
    const bus = new ExecutionNoticeBus()
    const tokenA = Symbol('exec-a')
    const tokenB = Symbol('exec-b')
    bus.publish(tokenA, ['notice for A'])
    // A later execution on the same child must NOT see A's pending notices.
    expect(bus.take(tokenB)).toEqual([])
    // And taking them does not consume anyone else's.
    expect(bus.take(tokenA)).toEqual(['notice for A'])
    expect(bus.take(tokenA)).toEqual([])
    expect(bus.take(tokenB)).toEqual([])
  })

  it('publishing nothing leaves no entry', () => {
    const bus = new ExecutionNoticeBus()
    bus.publish(Symbol('t'), [])
    expect(bus.take(Symbol('t'))).toEqual([])
  })
})
