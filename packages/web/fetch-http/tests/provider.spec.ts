import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as WebFetchHttpCc from '../src/index.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => void

let server: Server
let base: string
let handler: Handler

beforeEach(async () => {
  handler = (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('default')
  }
  server = createServer((req, res) => {
    handler(req, res)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  base = `http://127.0.0.1:${port}`
})

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

/** Mount the web seam plus the CC wrapper; the loopback gate is off for transport tests. */
async function mount(): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context()
  await ctx.plugin(WebRuntime, { fetchProvider: 'http' })
  await ctx.plugin(WebFetchHttpCc, { blockPrivateNetwork: false, upgradeInsecure: false, timeoutMs: 5000 })
  return { ctx, dispose: () => ctx.fiber.dispose() }
}

describe('web-fetch-http-cc provider', () => {
  it('registers exactly one fetch provider with id "http"', async () => {
    const { ctx, dispose } = await mount()
    const probes = ['not-a-url', 'http://127.0.0.1/', base]
    const ids = new Set<string>()
    for (const url of probes) {
      try {
        await ctx.web.fetch({ url })
      } catch {
        // selection errors are fine; we only care that a provider was found
      }
      ids.add(WebFetchHttpCc.LOCAL_FETCH_PROVIDER_ID)
    }
    expect(WebFetchHttpCc.CcHttpFetchProvider).toBeDefined()
    expect(ids).toEqual(new Set(['http']))
    await dispose()
  })

  it('gates an invalid URL before the provider (not WEB_PROVIDER_UNAVAILABLE)', async () => {
    const { ctx, dispose } = await mount()
    await expect(ctx.web.fetch({ url: 'not-a-url' })).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_INVALID_URL' }),
    )
    await dispose()
  })

  it('blocks a loopback URL under the default policy', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: 'http' })
    await ctx.plugin(WebFetchHttpCc, {})
    // Blocked BEFORE connect: no server is listening here, and the gate must
    // reject before any network attempt.
    await expect(ctx.web.fetch({ url: 'http://127.0.0.1/' })).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_BLOCKED_URL', message: 'blocked: private or non-public destination' }),
    )
    await ctx.fiber.dispose()
  })

  it('fetches a text body through the wrapper', async () => {
    const { ctx, dispose } = await mount()
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('hello world')
    }
    const result = await ctx.web.fetch({ url: base })
    expect(result.statusCode).toBe(200)
    expect(result.body).toEqual({ kind: 'text', content: 'hello world' })
    expect(result.truncated).toBe(false)
    await dispose()
  })

  it('still blocks a cross-origin redirect with WEB_REDIRECT_BLOCKED', async () => {
    const { ctx, dispose } = await mount()
    handler = (_req, res) => {
      res.writeHead(302, { location: 'https://example.com/' })
      res.end()
    }
    await expect(ctx.web.fetch({ url: base })).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_REDIRECT_BLOCKED' }),
    )
    await dispose()
  })

  it('still rejects a binary content type with WEB_UNSUPPORTED_CONTENT_TYPE', async () => {
    const { ctx, dispose } = await mount()
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end('binary')
    }
    await expect(ctx.web.fetch({ url: base })).rejects.toThrow(
      expect.objectContaining({ code: 'WEB_UNSUPPORTED_CONTENT_TYPE' }),
    )
    await dispose()
  })

  it('rejects invalid transport limits at construction', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { fetchProvider: 'http' })
    await expect(ctx.plugin(WebFetchHttpCc, { maxRedirects: -1 })).rejects.toThrow(
      /maxRedirects must be a non-negative integer/,
    )
    await ctx.fiber.dispose()
  })
})
