import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { defaultDshHome } from '@deepseek-ai/dsh-home-paths'
import { resolveMemoryHome } from '../src/paths.ts'

/**
 * Regression coverage for the default memdir resolution: the default must be
 * `<dsh home>/memory`, NEVER the harness home itself. `apply()` regressed this
 * once by forwarding `defaultDshHome()` as the configured root, which pinned
 * memory writes (MEMORY.md and topic files) into the harness home root.
 */
describe('resolveMemoryHome', () => {
  it('resolves the default to the memory subdirectory of the harness home', () => {
    expect(resolveMemoryHome(undefined)).toBe(join(defaultDshHome(), 'memory'))
    expect(resolveMemoryHome('')).toBe(join(defaultDshHome(), 'memory'))
  })

  it('never returns the bare harness home', () => {
    expect(resolveMemoryHome(undefined)).not.toBe(defaultDshHome())
  })

  it('honors an explicit root verbatim', () => {
    expect(resolveMemoryHome('/tmp/mem')).toBe('/tmp/mem')
  })
})
