import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { collect } from '../src/collect.ts'
import { CLOCK, fakeInvocation } from './helpers.ts'

type FetchFn = (req: { url: string }, signal?: AbortSignal) => Promise<unknown>

function errorWith(code: string): Error {
  return Object.assign(new Error(code), { code })
}

function checkOf(report: { checks: { id: string }[] }, id: string) {
  return report.checks.find(check => check.id === id)
}

describe('web checks', () => {
  it('skips the seam and emits no probe rows when web is not mounted', async () => {
    const ctx = new Context()
    const report = await collect(ctx, fakeInvocation(), CLOCK)
    expect(checkOf(report, 'web.seam')).toMatchObject({ status: 'skip', summary: 'web seam not mounted' })
    expect(checkOf(report, 'web.fetch-provider')).toBeUndefined()
    expect(checkOf(report, 'web.ssrf-gate')).toBeUndefined()
  })

  it('warns on fetch-provider and skips ssrf-gate when the probe is missing', async () => {
    const ctx = new Context()
    const fetch: FetchFn = async () => { throw errorWith('WEB_PROVIDER_UNAVAILABLE') }
    ctx.provide('web', { fetch })
    const report = await collect(ctx, fakeInvocation(), CLOCK)
    expect(checkOf(report, 'web.seam')).toMatchObject({ status: 'ok' })
    expect(checkOf(report, 'web.fetch-provider')).toMatchObject({ status: 'warn' })
    expect(checkOf(report, 'web.ssrf-gate')).toMatchObject({
      status: 'skip',
      summary: 'fetch provider not mounted',
    })
  })

  it('reports provider ok and ssrf-gate ok when the gate blocks loopback', async () => {
    const ctx = new Context()
    const fetch: FetchFn = async (req) => {
      if (req.url === 'not-a-url') throw errorWith('WEB_INVALID_URL')
      if (req.url === 'http://127.0.0.1/') throw errorWith('WEB_BLOCKED_URL')
      throw errorWith('WEB_ABORTED')
    }
    ctx.provide('web', { fetch })
    const report = await collect(ctx, fakeInvocation(), CLOCK)
    expect(checkOf(report, 'web.fetch-provider')).toMatchObject({ status: 'ok' })
    expect(checkOf(report, 'web.ssrf-gate')).toMatchObject({ status: 'ok' })
  })

  it('warns ssrf-gate when a present provider does not block loopback', async () => {
    const ctx = new Context()
    const fetch: FetchFn = async (req) => {
      if (req.url === 'not-a-url') throw errorWith('WEB_INVALID_URL')
      throw errorWith('WEB_ABORTED')
    }
    ctx.provide('web', { fetch })
    const report = await collect(ctx, fakeInvocation(), CLOCK)
    expect(checkOf(report, 'web.fetch-provider')).toMatchObject({ status: 'ok' })
    const gate = checkOf(report, 'web.ssrf-gate')
    expect(gate).toMatchObject({ status: 'warn' })
    expect(gate?.summary).toContain('SSRF gate off or bypassed')
  })

  it('reports haiku inherit as info for the summarizer', async () => {
    const ctx = new Context()
    ctx.provide('web', { fetch: async () => { throw errorWith('WEB_PROVIDER_UNAVAILABLE') } })
    ctx.provide('ccModelRoutes', { inspect: () => ({ kind: 'inherit', via: 'builtin' }) })
    const report = await collect(ctx, fakeInvocation(), CLOCK)
    expect(checkOf(report, 'web.haiku-summarizer')).toMatchObject({
      status: 'info',
      summary: 'raw WebFetch OK; prompt summarization unavailable',
    })
  })

  it('reports the full haiku route as ok', async () => {
    const ctx = new Context()
    ctx.provide('ccModelRoutes', {
      inspect: () => ({ kind: 'route', route: { provider: 'deepseek', model: 'm-lite' }, via: 'configured' }),
    })
    const report = await collect(ctx, fakeInvocation(), CLOCK)
    expect(checkOf(report, 'web.haiku-summarizer')).toMatchObject({ status: 'ok' })
  })
})
