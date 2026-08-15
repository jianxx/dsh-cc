/**
 * Package-owned invariant companion for `@jianxx/dsh-cc-mcp-config`.
 * @module @jianxx/dsh-cc-mcp-config/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@jianxx/dsh-cc-mcp-config'

/** Cordis companion plugin name. */
export const name = 'mcp-config-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: mcp-config is a pure loader that produces registrations
 * and introduces no live registries of its own to reconcile.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
