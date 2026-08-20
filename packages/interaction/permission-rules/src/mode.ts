/**
 * Durable per-session permission-mode override, stored as `permission/mode`
 * session events (last-wins fold). Because plan mode is owned by plan-mode's own
 * `plan/mode` event, `plan` is never written here — it overlays at call time via
 * `foldPlanMode`. Entering `bypassPermissions` also records the prior sandbox
 * mode as `resumeSandbox` so leaving can restore the pre-bypass confinement.
 *
 * Cross-repo event registration: this module adds `permission/mode` to the
 * upstream `KNOWN_SESSION_EVENT_TYPES` set at load so the persistence layer
 * will resume logs containing it on harness builds whose catalog lacks it
 * (persistence refuses unknown types unless the type is registered there). The
 * set is typed `ReadonlySet` but is a live `Set`. The linked harness may already
 * declare `permission/mode` (a narrower shape predating `auto`/`resumeSandbox`);
 * in that case the `add` is a no-op and {@link PermissionModeEventData} carries
 * the field extensions that postdate the upstream session vocabulary.
 *
 * @module @jianxx/dsh-cc-permission-rules/mode
 */

import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { PLAN_READONLY_REASON, SWITCHABLE_PERMISSION_MODES, type SwitchablePermissionMode } from './types.ts'

;(KNOWN_SESSION_EVENT_TYPES as Set<string>).add('permission/mode')

export const PERMISSION_MODE_EVENT = 'permission/mode' as const

export { PLAN_READONLY_REASON }

/**
 * The `permission/mode` payload as written by this plugin. `auto` and
 * `resumeSandbox` postdate the upstream session event type (which declares a
 * narrower, `auto`-less shape with no resume field); events are persisted and
 * folded through this extended face. `resumeSandbox` is recorded only when
 * entering `bypassPermissions`.
 */
export interface PermissionModeEventData {
  mode: SwitchablePermissionMode
  resumeSandbox?: SandboxMode
}

/** Read a `permission/mode` event's payload through the extended face. */
function dataOf(event: SessionEvent): PermissionModeEventData {
  return event.data as unknown as PermissionModeEventData
}

/**
 * Fold the session's live permission mode: the last `permission/mode` value, or
 * undefined when the session never recorded one (callers apply the default).
 * @param events - session events in log order (other event types are skipped).
 * @returns the last recorded switchable mode, or undefined without one.
 */
export function foldPermissionMode(events: readonly SessionEvent[]): SwitchablePermissionMode | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.type === 'permission/mode') return dataOf(event).mode
  }
  return undefined
}

/**
 * Fold the sandbox mode a session should restore when it leaves `bypassPermissions`:
 * the `resumeSandbox` of the most recent bypass event, or undefined when no bypass
 * event recorded one.
 * @param events - session events in log order.
 * @returns the recorded resume mode, or undefined without one.
 */
export function foldResumeSandbox(events: readonly SessionEvent[]): SandboxMode | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.type === 'permission/mode' && dataOf(event).mode === 'bypassPermissions' && dataOf(event).resumeSandbox !== undefined) {
      return dataOf(event).resumeSandbox
    }
  }
  return undefined
}

/**
 * Append one durable `permission/mode` event. `plan` (and any unknown mode)
 * throws: those are not writable through this channel. `resumeSandbox`, when
 * given, is recorded alongside so a later leave restores the prior confinement.
 * @param session - the session the override belongs to.
 * @param mode - the new switchable permission mode.
 * @param resumeSandbox - the sandbox to restore on leaving bypass, recorded only
 *   when entering `bypassPermissions`.
 */
export function setPermissionMode(session: Session, mode: SwitchablePermissionMode, resumeSandbox?: SandboxMode): void {
  if (!(SWITCHABLE_PERMISSION_MODES as readonly string[]).includes(mode)) {
    throw new TypeError(`permission mode must be one of ${SWITCHABLE_PERMISSION_MODES.join(', ')}`)
  }
  const data: PermissionModeEventData = {
    mode,
    ...resumeSandbox !== undefined ? { resumeSandbox } : {},
  }
  session.append('permission/mode', data as never)
}
