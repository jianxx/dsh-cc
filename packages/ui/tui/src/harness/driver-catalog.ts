/**
 * Slash-command catalog + subagent lifecycle listeners extracted from
 * harness/driver.ts. Free-function collaborator: takes a
 * {@link DriverCatalogCtx} instead of closing over createDriver's locals, so
 * the harness factory stays out of this leaf.
 * @module @jianxx/dsh-cc-tui/harness/driver-catalog
 */

import { upsertSubagent, type SubagentRunView } from '../store.ts'
import type { SubagentRunEndInfoLike, SubagentRunInfoLike } from '../state/driver-types.ts'
import { LOCAL_COMMANDS } from '../slash.ts'
import type { DriverCatalogCtx } from './driver-ctx.ts'

/** Duck-typed surface for the mounted commands service (matches CommandsLike). */
export interface CommandsLike {
  list(agent: unknown): { name: string; description?: string; input?: { hint?: string } }[]
}

/**
 * Build the slash-command catalog section: merges LOCAL_COMMANDS with the
 * harness registry and subscribes to subagent lifecycle events. The cached
 * array identity stays stable between refreshes so root.ts can detect a change
 * by reference equality and rebuild the autocomplete provider only when needed.
 */
export function createCatalogSection(rt: DriverCatalogCtx): { listCommands(): readonly { name: string; description?: string; argumentHint?: string }[] } {
  const commandsService = rt.ctx.get('commands') as CommandsLike | undefined
  let commandCatalog: readonly { name: string; description?: string; argumentHint?: string }[] = []
  const refreshCommandCatalog = (): void => {
    const localNames = new Set(LOCAL_COMMANDS.map(c => c.name))
    const merged: { name: string; description?: string; argumentHint?: string }[] =
      LOCAL_COMMANDS.map(c => ({
        name: c.name,
        description: c.description,
        ...c.argumentHint === undefined ? {} : { argumentHint: c.argumentHint },
      }))
    if (commandsService !== undefined) {
      try {
        const harnessList = commandsService.list(rt.current.agent)
        for (const cmd of harnessList) {
          if (localNames.has(cmd.name)) continue // local wins, dedupe
          merged.push({
            name: cmd.name,
            ...cmd.description === undefined ? {} : { description: cmd.description },
            ...cmd.input?.hint === undefined ? {} : { argumentHint: cmd.input.hint },
          })
        }
      } catch {
        // A failing list() degrades to local-only; don't poison the catalog.
      }
    }
    commandCatalog = merged
  }
  refreshCommandCatalog()
  if (commandsService !== undefined) {
    // `commands/change` is declared via module augmentation in
    // @deepseek-ai/dsh-commands, but the tui package doesn't import that
    // package directly, so the augmentation isn't in tsc's view here. The
    // event exists at runtime (the commands service dispatches it on
    // register/unregister); cast through the Events map to subscribe without
    // pulling a new dep into the type graph.
    const changeEvent = 'commands/change' as Parameters<typeof rt.ctx.on>[0]
    rt.ctx.on(changeEvent, () => {
      refreshCommandCatalog()
    })
  }

  // Subagent lifecycle: `subagent/start`|`subagent/end` are global,
  // process-scoped observe-only snapshots paired by `runId` (declared via
  // module augmentation in @deepseek-ai/subagent, which tui doesn't import).
  // Same cast pattern as `commands/change` above. Tracking is event-only —
  // no `SubagentRuntime.listChildren` call — so the driver stays
  // composition-agnostic (tool-cordis may be absent). Events are NOT
  // session-filtered: per-session parentage isn't on the payload, so the
  // list tracks all runs observed this process; `/agents` labels it
  // accordingly and does not overclaim parentage.
  const subagentStart = 'subagent/start' as Parameters<typeof rt.ctx.on>[0]
  const subagentEnd = 'subagent/end' as Parameters<typeof rt.ctx.on>[0]
  rt.ctx.on(subagentStart, (info: SubagentRunInfoLike) => {
    rt.emit(upsertSubagent(rt.state(), {
      runId: String(info.runId),
      provider: String(info.provider),
      sessionId: String(info.id),
      status: 'running',
    }))
  })
  rt.ctx.on(subagentEnd, (info: SubagentRunEndInfoLike) => {
    const view: SubagentRunView = {
      runId: String(info.runId),
      provider: String(info.provider),
      sessionId: String(info.id),
      status: 'done',
      ...(info.stopReason === undefined ? {} : { stopReason: String(info.stopReason) }),
    }
    rt.emit(upsertSubagent(rt.state(), view))
  })

  return {
    listCommands() {
      return commandCatalog
    },
  }
}
