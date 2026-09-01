/**
 * Slash-command catalog + subagent lifecycle listeners extracted from
 * harness/driver.ts. Free-function collaborator: takes a
 * {@link DriverCatalogCtx} instead of closing over createDriver's locals, so
 * the harness factory stays out of this leaf.
 *
 * The catalog merges three sources with command-name precedence:
 * TUI-local commands, the harness command registry (`ctx.commands`), and
 * user-invocable skills (`ctx.skills.snapshot()`). Skill names are duck-typed
 * against upstream `SkillRegistry.snapshot` — the TUI never imports
 * `@deepseek-ai/dsh-skill`; skills are optional and a missing service only
 * leaves the skill half empty. Publishing a new catalog array emits the
 * current state so root.ts's reference-equality guard rebuilds the
 * autocomplete provider.
 *
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
 * Duck-typed surface for the optional skills registry — the shape of upstream
 * `SkillRegistry.snapshot` (see `@deepseek-ai/dsh-skill`). Only the fields the
 * catalog merge reads are named; a missing service simply contributes no
 * skill entries.
 */
export interface SkillsLike {
  snapshot(opts: { cwd?: string; scope?: unknown }): Promise<{
    skills: readonly {
      name: string
      description: string
      invocation: { modelInvocable: boolean; userInvocable: boolean }
    }[]
    complete: boolean
  }>
}

/** One merged catalog entry (commands and skills share the shape). */
export interface CatalogItem {
  name: string
  description?: string
  argumentHint?: string
}

/**
 * Build the slash-command catalog section: merges LOCAL_COMMANDS with the
 * harness registry and user-invocable skills, subscribes to
 * `commands/change` / `skills/change` and subagent lifecycle events. The
 * cached array identity stays stable between refreshes so root.ts can detect
 * a change by reference equality and rebuild the autocomplete provider only
 * when needed.
 */
export function createCatalogSection(rt: DriverCatalogCtx): {
  listCommands(): readonly CatalogItem[]
  refreshCatalog(): void
} {
  const commandsService = rt.ctx.get('commands') as CommandsLike | undefined
  const skillsService = rt.ctx.get('skills') as SkillsLike | undefined
  let commandCatalog: readonly CatalogItem[] = []
  // Last-good user-invocable skill entries (already filtered/prefixed at
  // snapshot time). Retained across incomplete or thrown snapshots.
  let skillEntries: readonly CatalogItem[] = []
  // Generation token for in-flight skill snapshots: only the latest
  // generation may publish, so overlapping snapshots are latest-wins.
  let generation = 0

  const buildMerged = (): CatalogItem[] => {
    const localNames = new Set(LOCAL_COMMANDS.map(c => c.name))
    const merged: CatalogItem[] = LOCAL_COMMANDS.map(c => ({
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
    // Skills come last; a name already claimed by a local or harness command
    // resolves to the command (web adjudication precedence).
    const used = new Set(merged.map(c => c.name))
    for (const skill of skillEntries) {
      if (used.has(skill.name)) continue
      used.add(skill.name)
      merged.push(skill)
    }
    return merged
  }

  const publish = (): void => {
    commandCatalog = buildMerged()
    // Notify subscribers so root.ts compares the new catalog identity and
    // rebuilds the autocomplete provider (skills arrive asynchronously, so
    // the refresh must ride an emit, not just the next state change).
    rt.emit(rt.state())
  }

  const refreshSkillsSnapshot = (): void => {
    if (skillsService === undefined) return
    const gen = ++generation
    const agent = rt.current.agent
    // cwd and scope are read from the LIVE agent at refresh time — never a
    // captured boot cwd (switchSession rebinds `current` in place).
    void skillsService.snapshot({ cwd: agent.session.header.cwd, scope: agent })
      .then(obs => {
        if (gen !== generation) return // superseded by a newer refresh
        if (!obs.complete) return // incomplete: retain last-good entries
        skillEntries = obs.skills
          .filter(skill => skill.invocation.userInvocable === true)
          .map(skill => ({
            name: skill.name,
            description: skill.invocation.modelInvocable === false
              ? `user-only · ${skill.description}`
              : skill.description,
          }))
        publish()
      })
      .catch(() => {
        // A rejected snapshot keeps the last-good skill entries; nothing to
        // publish and nothing to surface — the next skills/change retries.
      })
  }

  /**
   * Rebuild the full catalog for the current agent: commands synchronously
   * (including current skillEntries), skills via a fresh snapshot. Called at
   * boot, on commands/change and skills/change, and after a session switch.
   */
  const refreshCatalog = (): void => {
    publish()
    refreshSkillsSnapshot()
  }
  refreshCatalog()

  if (commandsService !== undefined) {
    // `commands/change` is declared via module augmentation in
    // @deepseek-ai/dsh-commands, but the tui package doesn't import that
    // package directly, so the augmentation isn't in tsc's view here. The
    // event exists at runtime (the commands service dispatches it on
    // register/unregister); cast through the Events map to subscribe without
    // pulling a new dep into the type graph.
    const changeEvent = 'commands/change' as Parameters<typeof rt.ctx.on>[0]
    rt.ctx.on(changeEvent, () => {
      refreshCatalog()
    })
  }
  if (skillsService !== undefined) {
    // `skills/change` — same cast pattern; declared in @deepseek-ai/dsh-skill.
    const skillChangeEvent = 'skills/change' as Parameters<typeof rt.ctx.on>[0]
    rt.ctx.on(skillChangeEvent, () => {
      refreshCatalog()
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
    refreshCatalog() {
      refreshCatalog()
    },
  }
}
