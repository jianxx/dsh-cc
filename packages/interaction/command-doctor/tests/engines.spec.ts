import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { nodeSatisfiesEngines, readEngines, readVersion } from '../src/version.ts'

describe('nodeSatisfiesEngines', () => {
  it('fails below the 22.19 floor', () => {
    expect(nodeSatisfiesEngines('22.18.0')).toBe(false)
  })
  it('passes the 22.19 floor', () => {
    expect(nodeSatisfiesEngines('22.19.0')).toBe(true)
    expect(nodeSatisfiesEngines('22.23.2')).toBe(true)
  })
  it('fails all of Node 23', () => {
    expect(nodeSatisfiesEngines('23.0.0')).toBe(false)
    expect(nodeSatisfiesEngines('23.9.1')).toBe(false)
  })
  it('passes Node 24 and later', () => {
    expect(nodeSatisfiesEngines('24.0.0')).toBe(true)
    expect(nodeSatisfiesEngines('26.1.0')).toBe(true)
  })
  it('accepts v-prefixed versions and rejects garbage', () => {
    expect(nodeSatisfiesEngines('v22.19.0')).toBe(true)
    expect(nodeSatisfiesEngines('v23.0.0')).toBe(false)
    expect(nodeSatisfiesEngines('garbage')).toBe(false)
  })
})

describe('manifest reads', () => {
  it('reads a version and the engines range from this package manifest', () => {
    // The version moves every release, so assert it against the manifest
    // itself (read independently) instead of pinning a literal.
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version?: string }
    expect(manifest.version).toBeTruthy()
    expect(readVersion()).toBe(manifest.version)
    expect(readEngines()).toBe('^22.19 || >=24')
  })
})
