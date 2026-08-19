/**
 * The per-agent "Available subagents" system-prompt section.
 *
 * A single global section (mount once on the root context) serves every
 * agent: the text callback receives the assembling agent through
 * `AssembleContext.scope` (the agent loop passes `scope: agent`) and renders
 * that agent's workspace `.claude/agents` definitions. Because `text()` is a
 * synchronous callback it cannot `await` discovery, so the section renders
 * from a snapshot cache that a fire-and-forget `registry.ensure(cwd)` populates
 * in the background; the first assembly for an unknown workspace shows nothing,
 * then `system-prompt/change` fires once the catalog lands and reassembly
 * reveals it. When a workspace defines no agents (or there is no agent to
 * scope to) the section renders an empty string so it drops out of the prompt.
 *
 * @module @jianxx/dsh-cc-subagent-task/catalog
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentDefinition } from '@jianxx/dsh-cc-claude-code-agents'
import { cwdOf } from '@jianxx/dsh-cc-memory'
import type { AgentRegistry } from './registry.ts'

/** Default order slot for the catalog section (tool guidance owns 100–199). */
export const CATALOG_SECTION_ORDER = 110

/** The section's unique name. */
export const CATALOG_SECTION_NAME = 'cc:subagent-catalog'

/**
 * Extract the assembling agent from an `AssembleContext`. The agent loop
 * assembles with `scope: agent` (a runtime contract; `ScopeKey` is opaque),
 * so the scope IS the agent whenever a session drives the assembly.
 */
function agentFromScope(scope: unknown): Agent | undefined {
  if (typeof scope === 'object' && scope !== null && 'session' in scope) {
    return scope as Agent
  }
  return undefined
}

/**
 * Owner of the cached catalog section text. Holds one sorted definition list
 * per workspace root so the synchronous section provider can compose the text,
 * and fills each root's snapshot from a background `registry.ensure`.
 */
export class AgentCatalogSection {
  /** Sorted definitions per workspace root, populated once discovery lands. */
  private readonly snapshot = new Map<string, readonly AgentDefinition[]>()
  /** Roots whose background discovery has already been kicked off. */
  private readonly seen = new Set<string>()

  /**
   * Create a catalog cache holder bound to a registry.
   * @param ctx - the host context whose `system-prompt` seam and
   *   `system-prompt/change` channel drive refresh.
   * @param registry - the per-workspace definition cache to load from.
   */
  constructor(
    private readonly ctx: Context,
    private readonly registry: AgentRegistry,
  ) {}

  /** Register the catalog section.
   * @returns the exact Cordis effect disposer for the section. */
  start(): () => void {
    return this.ctx.systemPrompt.section({
      name: CATALOG_SECTION_NAME,
      order: CATALOG_SECTION_ORDER,
      text: (context: { scope?: unknown }): string => this.render(context.scope),
    })
  }

  /**
   * Compose the catalog text for the agent behind an assemble scope.
   * Kicks the root's background discovery on first sight; renders from the
   * snapshot until it lands. Returns '' (section drops out) when there is no
   * agent or the snapshot holds no definitions.
   */
  private render(scope: unknown): string {
    const agent = agentFromScope(scope)
    if (agent === undefined) return ''
    const root = cwdOf(agent)
    this.ensureDefs(root)
    return renderCatalog(this.snapshot.get(root) ?? [])
  }

  /**
   * Kick background discovery for one workspace root exactly once. When it
   * lands, the snapshot is populated and `system-prompt/change` fires so the
   * next assembly renders the catalog. Failures are swallowed: a missing or
   * unreadable agents directory simply leaves an empty snapshot (the section
   * stays absent, which is itself the correct "no agents" rendering).
   * @param root - the workspace root.
   */
  private ensureDefs(root: string): void {
    if (this.seen.has(root)) return
    this.seen.add(root)
    void this.registry.ensure(root).then(
      defs => {
        this.snapshot.set(
          root,
          [...defs.values()].sort((a, b) => a.agentType.localeCompare(b.agentType)),
        )
        this.ctx.emit('system-prompt/change')
      },
      () => {},
    )
  }
}

/**
 * Mount the single global catalog section.
 * @param ctx - the plug context carrying the `systemPrompt` seam.
 * @param registry - the per-workspace definition cache.
 * @returns the exact Cordis effect disposer, or undefined when the seam is absent.
 */
export function mountAgentCatalog(
  ctx: Context,
  registry: AgentRegistry,
): (() => void) | undefined {
  if (ctx.get('systemPrompt') === undefined) return undefined
  return new AgentCatalogSection(ctx, registry).start()
}

/**
 * Compose the section text from the sorted definitions. Returns '' when empty
 * so the section contributes nothing to the prompt.
 * @param defs - the sorted definitions to list.
 * @returns the rendered catalog, or '' when no definitions are available.
 */
export function renderCatalog(defs: readonly AgentDefinition[]): string {
  if (defs.length === 0) return ''
  const lines = [
    '## Available subagents',
    '',
    ...defs.map(def => `- ${def.agentType} — ${def.whenToUse}`),
    '',
    'To delegate to one, pass its name as the `subagent_type` argument of the Task tool.',
  ]
  return lines.join('\n')
}
