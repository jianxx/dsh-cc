/**
 * Human-facing `/permissions` command: render the effective permission rule
 * state (allow/deny/ask counts per source), or switch the session's permission
 * mode with `/permissions <mode>`. Switching is durable — it routes through the
 * permission-rules engine's `setMode` (and plan-mode's `set` for `plan`).
 *
 * The host command remains the write path. A client decoration (see
 * `./client`) hangs the same popupSelect on the BARE invocation, mirroring the
 * `/permission` preset pattern — a pick submits `/permissions <mode>` through
 * here, so both surfaces write through one path.
 *
 * `/permission` (host, sandbox+approval presets) and `/permissions` (this
 * package, CC rule-engine modes) drive different knobs. A CC session's slash
 * menu should show only `/permissions`: `commands.list` drops the host
 * `/permission` row when `/permissions` is in the same view, while
 * `find`/`execute` stay on the global handler so the composer chip can still
 * switch sandbox presets.
 * @module @jianxx/dsh-cc-command-permissions
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@jianxx/dsh-cc-permission-rules'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { foldPlanMode } from '@deepseek-ai/dsh-plan-mode'
import { PERMISSION_COMMAND_MODES } from './modes.ts'
import { renderPermissions } from './permissions.ts'

export const name = 'command-permissions'
/**
 * `commands` is required; the `permissionRules` engine and `planMode` are read
 * optionally via `ctx.get` so the command loads (and reports a friendly message)
 * even when the engine is not composed, mirroring `/status`'s optional
 * permission-preset read.
 */
export const inject = ['commands']

/** Structural face of the permission-rules engine the command drives. */
type PermissionRulesLike = {
  readonly ruleSet: { readonly allow: readonly unknown[]; readonly deny: readonly unknown[]; readonly ask: readonly unknown[]; readonly bypassImmune: readonly unknown[] }
  setMode(agent: Agent, mode: string): void
}

/** The shared modes list — the switch list and the client popup both read it. */
const MODES = PERMISSION_COMMAND_MODES

/** Render the current rule state from a mounted engine. */
function renderState(service: PermissionRulesLike): CommandResult {
  return {
    kind: 'success',
    text: renderPermissions(service.ruleSet as never, service.ruleSet.bypassImmune.length),
  }
}

/** Execute `/permissions` against the mounted permission-rules engine. */
function executePermissions(ctx: Context, invocation: CommandInvocation): CommandResult {
  const service = ctx.get('permissionRules') as PermissionRulesLike | undefined
  const raw = invocation.rawInput.trim()
  if (raw === '') {
    if (service === undefined) {
      return { kind: 'success', text: 'The permission-rules engine is not mounted in this composition.' }
    }
    return renderState(service)
  }
  if (service === undefined) {
    return { kind: 'error', text: 'The permission-rules engine is not mounted in this composition.' }
  }
  const [mode = ''] = raw.split(/\s+/)
  if (!(MODES as readonly string[]).includes(mode)) {
    return { kind: 'error', text: `unknown permission mode "${mode}"; available: ${MODES.join(', ')}` }
  }
  const agent = invocation.agent
  try {
    if (mode === 'plan') {
      const planMode = ctx.get('planMode') as { set(agent: Agent, active: boolean): unknown } | undefined
      if (planMode === undefined) {
        return { kind: 'error', text: 'plan mode is not mounted in this composition' }
      }
      planMode.set(agent, true)
    } else {
      if (foldPlanMode(agent.session.events)) {
        const planMode = ctx.get('planMode') as { set(agent: Agent, active: boolean): unknown } | undefined
        if (planMode === undefined) {
          return { kind: 'error', text: 'leave plan mode with /plan off first' }
        }
        planMode.set(agent, false)
      }
      service.setMode(agent, mode)
    }
    return { kind: 'success', text: `Permission mode is now "${mode}".` }
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Register the `/permissions` command, and hide the host `/permission` row
 * from `commands.list` for agents that can see `/permissions`. `find` and
 * `execute` are not wrapped, so `/permission workspace-write` and the
 * composer chip keep driving the sandbox-preset switcher.
 * @param ctx - context carrying the command registry and permission engine.
 */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'permissions',
    description: 'show or switch the permission mode (default|acceptEdits|plan|auto|bypassPermissions)',
    input: { hint: '[mode]' },
    handler: (invocation: CommandInvocation) => executePermissions(ctx, invocation),
  })
  const commands = ctx.commands
  const originalList = commands.list
  const wrappedList = function list(this: typeof commands, agent: Agent): ReturnType<typeof commands.list> {
    const listed = originalList.call(this, agent)
    if (this.find(agent, 'permissions') === undefined) return listed
    const filtered = listed.filter(entry => entry.name !== 'permission')
    return filtered.length === listed.length ? listed : Object.freeze(filtered)
  }
  commands.list = wrappedList as typeof commands.list
  ctx.effect(() => () => {
    if (commands.list === wrappedList) commands.list = originalList
  }, 'command-permissions: hide /permission from the CC catalog')
}
