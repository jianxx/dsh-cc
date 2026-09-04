import { describe, expect, it } from 'vitest'
import { gateAndRewrite, isBlockedDestination } from '../src/ssrf.ts'
import type { GatePolicy } from '../src/ssrf.ts'

/** The production default policy (matches the plugin Config defaults). */
function policy(overrides: Partial<GatePolicy> = {}): GatePolicy {
  return { maxUrlLength: 2048, blockPrivateNetwork: true, upgradeInsecure: true, ...overrides }
}

describe('gateAndRewrite — invalid URLs', () => {
  it('rejects an empty URL', () => {
    expect(() => gateAndRewrite('', policy())).toThrow(expect.objectContaining({ code: 'WEB_INVALID_URL' }))
  })

  it('rejects a non-string URL at runtime', () => {
    expect(() => gateAndRewrite(42 as unknown as string, policy())).toThrow(
      expect.objectContaining({ code: 'WEB_INVALID_URL' }),
    )
  })

  it('rejects an unparsable URL', () => {
    expect(() => gateAndRewrite('not a url', policy())).toThrow(expect.objectContaining({ code: 'WEB_INVALID_URL' }))
  })

  it('rejects a non-http(s) scheme', () => {
    expect(() => gateAndRewrite('ftp://example.com', policy())).toThrow(
      expect.objectContaining({ code: 'WEB_INVALID_URL' }),
    )
  })

  it('rejects a URL over maxUrlLength', () => {
    const long = `https://example.com/${'a'.repeat(2100)}`
    expect(() => gateAndRewrite(long, policy({ maxUrlLength: 2048 }))).toThrow(
      expect.objectContaining({ code: 'WEB_INVALID_URL' }),
    )
  })
})

describe('gateAndRewrite — blocked URLs', () => {
  it('rejects credentials in the URL', () => {
    expect(() => gateAndRewrite('https://user:pass@example.com', policy())).toThrow(
      expect.objectContaining({ code: 'WEB_BLOCKED_URL' }),
    )
  })

  it('rejects a username-only URL', () => {
    expect(() => gateAndRewrite('https://user@example.com', policy())).toThrow(
      expect.objectContaining({ code: 'WEB_BLOCKED_URL' }),
    )
  })

  it('blocks private and loopback destinations with the documented message', () => {
    for (const url of [
      'http://127.0.0.1/',
      'http://localhost/',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/',
      'http://192.168.1.1/',
      'http://172.16.5.4/',
      'http://100.64.0.1/',
      'http://[::1]/',
      'http://[fe80::1]/',
      'http://[fc00::1]/',
      'http://[ff02::1]/',
      'http://0.0.0.0/',
      'http://[::]/',
      'http://224.0.0.1/',
      'http://2130706433/',
    ]) {
      expect(() => gateAndRewrite(url, policy()), url).toThrow(
        expect.objectContaining({ code: 'WEB_BLOCKED_URL', message: 'blocked: private or non-public destination' }),
      )
    }
  })

  it('blocks a loopback subdomain and a trailing-dot localhost', () => {
    expect(() => gateAndRewrite('http://api.localhost/', policy())).toThrow(
      expect.objectContaining({ code: 'WEB_BLOCKED_URL' }),
    )
    expect(() => gateAndRewrite('http://localhost./', policy())).toThrow(
      expect.objectContaining({ code: 'WEB_BLOCKED_URL' }),
    )
  })

  it('blocks an IPv4-mapped loopback address', () => {
    expect(() => gateAndRewrite('http://[::ffff:127.0.0.1]/', policy())).toThrow(
      expect.objectContaining({ code: 'WEB_BLOCKED_URL' }),
    )
  })

  it('blocks a decimal-folded IPv4 loopback (WHATWG hostname is already 127.0.0.1)', () => {
    const url = new URL('http://2130706433/')
    expect(url.hostname).toBe('127.0.0.1')
    expect(isBlockedDestination(url)).toBe(true)
  })

  it('does not block a private host when the gate is off', () => {
    const off = policy({ blockPrivateNetwork: false, upgradeInsecure: false })
    expect(gateAndRewrite('http://127.0.0.1/', off)).toBe('http://127.0.0.1/')
  })
})

describe('gateAndRewrite — rewrite and pass-through', () => {
  it('allows a public https URL unchanged', () => {
    expect(gateAndRewrite('https://example.com/path?q=1#frag', policy())).toBe('https://example.com/path?q=1#frag')
  })

  it('upgrades a public http URL to https', () => {
    expect(gateAndRewrite('http://example.com/x?q=1#h', policy())).toBe('https://example.com/x?q=1#h')
  })

  it('does not upgrade a private http host even when the gate is off', () => {
    const off = policy({ blockPrivateNetwork: false, upgradeInsecure: true })
    expect(gateAndRewrite('http://127.0.0.1/x', off)).toBe('http://127.0.0.1/x')
  })

  it('does not upgrade when upgradeInsecure is off', () => {
    expect(gateAndRewrite('http://example.com/x', policy({ upgradeInsecure: false }))).toBe('http://example.com/x')
  })

  it('allows a public IPv4 host that is not in any blocked range', () => {
    expect(gateAndRewrite('https://8.8.8.8/', policy())).toBe('https://8.8.8.8/')
    expect(gateAndRewrite('https://172.32.0.1/', policy())).toBe('https://172.32.0.1/')
    expect(gateAndRewrite('https://100.128.0.1/', policy())).toBe('https://100.128.0.1/')
  })

  it('allows a public IPv6 host', () => {
    expect(gateAndRewrite('https://[2606:2800:220:1:248:1893:25c8:1946]/', policy())).toBe(
      'https://[2606:2800:220:1:248:1893:25c8:1946]/',
    )
  })
})
