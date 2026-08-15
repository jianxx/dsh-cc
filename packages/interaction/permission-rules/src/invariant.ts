/**
 * Package-owned invariant companion for `@jianxx/dsh-cc-permission-rules`.
 * @module @jianxx/dsh-cc-permission-rules/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@jianxx/dsh-cc-permission-rules'

/** Cordis companion plugin name. */
export const name = 'cc-permission-rules-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: rule settings fail loud at the settings boundary and
 * the engine no longer writes session events (out-of-repo plugins cannot
 * extend the upstream session vocabulary).
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
