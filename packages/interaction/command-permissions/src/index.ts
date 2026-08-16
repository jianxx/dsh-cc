/**
 * Human-facing `/permissions` command: render the effective permission rule
 * state (allow/deny/ask counts per source). READ-ONLY — this command never
 * switches the permission mode in this version.
 * @module @jianxx/dsh-cc-command-permissions
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@jianxx/dsh-cc-permission-rules'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { renderPermissions } from './permissions.ts'

export const name = 'command-permissions'
/**
 * `commands` is required; the `permissionRules` engine is read optionally via
 * `ctx.get` so the command loads (and reports a friendly message) even when the
 * engine is not composed, mirroring `/status`'s optional permission-preset read.
 */
export const inject = ['commands']

/** Execute `/permissions` against the mounted permission-rules engine. */
function executePermissions(ctx: Context): CommandResult {
  const service = ctx.get('permissionRules') as
    | { readonly ruleSet: { readonly allow: readonly unknown[]; readonly deny: readonly unknown[]; readonly ask: readonly unknown[]; readonly bypassImmune: readonly unknown[] } } | undefined
  if (service === undefined) {
    return { kind: 'success', text: 'The permission-rules engine is not mounted in this composition.' }
  }
  return {
    kind: 'success',
    text: renderPermissions(service.ruleSet as never, service.ruleSet.bypassImmune.length),
  }
}

/**
 * Register the `/permissions` command for every composed command adapter.
 * @param ctx - context carrying the command registry and permission engine.
 */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'permissions',
    description: 'show effective permission rules (counts by source)',
    handler: (_invocation: CommandInvocation) => executePermissions(ctx),
  })
}
