import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

/**
 * Mirrors cordis-plugin-loader `Loader.unwrapExports`: a default export wins
 * over the module namespace. The cc preset mounts this package as a plugin
 * row, so the unwrapped value must be a function or `{ apply }`.
 */
function unwrapExports(exports: { default?: unknown, __esModule?: boolean } | null | undefined) {
  if (exports == null) return exports
  let next: { default?: unknown, __esModule?: boolean, apply?: unknown } =
    (exports.default ?? exports) as { default?: unknown, __esModule?: boolean, apply?: unknown }
  if (!next.__esModule) return next
  return next.default ?? next
}

function isCordisPlugin(plugin: unknown): boolean {
  return typeof plugin === 'function'
    || (plugin != null && typeof plugin === 'object' && typeof (plugin as { apply?: unknown }).apply === 'function')
}

describe('plugin face', () => {
  it('unwraps to a cordis plugin (named apply, not a default object without apply)', async () => {
    const mod = await import('../src/index.ts')
    const plugin = unwrapExports(mod)
    expect(isCordisPlugin(plugin), `unwrapped ${typeof plugin}`).toBe(true)
    const ctx = new Context()
    await ctx.plugin(plugin as { apply: (ctx: Context) => void })
  })
})
