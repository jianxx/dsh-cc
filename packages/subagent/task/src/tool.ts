/**
 * The CC-compatible Task tool: `subagent_type` dispatch over the per-workspace
 * `.claude/agents` definitions discovered by the AgentRegistry.
 *
 * The internal tool name is `subagent_fork` so the CC display-name mapping
 * (Task) and permission/hook rows keyed on it keep working. The harness rows
 * `tool-subagent` and `tool-subagent-fork` are disabled in the cc preset in
 * favour of this definition — see `packages/preset/cc/agent.cordis.yml`.
 *
 * Dispatch rules:
 * - `subagent_type` omitted (or the `general-purpose` sentinel) → a plain fork
 *   of the caller, no definition participation.
 * - A type matching a definition under the session cwd → fork with the
 *   definition's system prompt delivered as the child `persona`, the model's
 *   task text as the first user message, a routes-resolved `agentOptions`
 *   override, and the definition's tool restriction (sanitized of tool names
 *   this composition no longer registers).
 * - Any other type → an error result listing the available types.
 *
 * The seam's capability contract (`assertCapabilities`) is honoured
 * transitively: fork supports persona/toolFilter/depthLimit, so every field
 * this tool forwards is legal.
 *
 * @module @jianxx/dsh-cc-subagent-task/tool
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRestriction } from '@jianxx/dsh-cc-claude-code-agents'
import { defineTool } from '@jianxx/dsh-cc-tools'
import { cwdOf } from '@jianxx/dsh-cc-memory'
import type { ModelRoutes } from '@jianxx/dsh-cc-model-aliases'
import type { AgentRegistry } from './registry.ts'

/** The registered tool name (the CC display mapping surfaces it as `Task`). */
export const TASK_TOOL = 'subagent_fork'

/** The sentinel a model uses to ask for a plain fork with no definition. */
const GENERAL_PURPOSE = 'general-purpose'

/** The default delegation-depth cap for a Task child (matches the harness default). */
const DEFAULT_MAX_DEPTH = 3

/**
 * Tool names this composition keeps restrictable without registering a
 * visible definition. The cc preset disables the two harness subagent tool
 * rows (`subagent` + `subagent_fork`) in favour of this tool, so the CC
 * frontmatter `Task` translation `['subagent', 'subagent_fork']` must stay in
 * the restrictable universe even though `subagent` is only reserved (not
 * registered — one visible Task is enough). `workflow` is the deferred row's
 * name for the same reason.
 *
 * `subagent_fork` itself needs no reservation: `registerTaskTool` registers
 * the visible definition below, and `restrict()` accepts registered names.
 * Filter sanitization reads the live `ctx.tools.view().restrictableNames` set,
 * so these reservations (plus every registered row and every mounted MCP tool)
 * are exactly the names a subagent toolFilter may carry.
 */
const RESERVED_TOOL_NAMES = ['subagent', 'workflow'] as const

/** A structural subset of the subagents seam the tool dispatches through. */
interface SubagentsLike {
  start(name: string, request: {
    label?: string
    prompt: readonly { type: 'text'; text: string }[]
    parent: Agent
    signal: AbortSignal
    agentOptions?: Record<string, string>
    toolFilter?: ToolRestriction
    maxDepth?: number
    persona?: string
  }): Promise<{
    result: Promise<{ stopReason: string; output?: readonly { type: string; text?: string }[] }>
  }>
  getProvider(name: string): unknown
  list(): string[]
}

interface RoutesLike {
  resolve(model: string | undefined): {
    provider?: string
    model?: string
    reasoningEffort?: string
  } | undefined
}

interface TaskArgs {
  /** The CC agent type to dispatch to; omit for a plain fork. */
  subagent_type?: string
  /** A short (3-5 word) task label, persisted with the child run. */
  description: string
  /** The task text delivered as the child's first user message. */
  prompt: string
}

/**
 * The MCP public-name prefix every bridged MCP tool carries on `ctx.tools`.
 */
const MCP_PUBLIC_PREFIX = 'mcp__'

/**
 * Expand one raw filter entry into the concrete names it asks for.
 *
 * - Anything not MCP-qualified passes through untouched (it is then gated by
 *   the `knownNames` check).
 * - A bare `mcp__` (no server segment) is dropped with a loud warning — it
 *   can never name a mounted tool.
 * - `mcp__<server>` (no third segment) and `mcp__<server>__*` expand to every
 *   known MCP tool of that server (`mcp__<server>__` prefix), so frontmatter
 *   survives servers publishing new tools without a hash-suffix dance.
 * - An exact `mcp__<server>__<tool>` passes through as written (the caller
 *   must use the public name, including any identity-hash suffix).
 */
function expandFilterName(
  rawName: string,
  knownNames: ReadonlySet<string>,
  warn: (m: string) => void,
): readonly string[] {
  if (!rawName.startsWith(MCP_PUBLIC_PREFIX)) return [rawName]
  const rest = rawName.slice(MCP_PUBLIC_PREFIX.length)
  if (rest.length === 0) {
    warn('cc-task: invalid MCP wildcard "mcp__" in a subagent toolFilter — expected mcp__<server> or mcp__<server>__<tool>')
    return []
  }
  const server = rest.endsWith('__*')
    ? rest.slice(0, -'__*'.length)
    : rest.includes('__')
      ? undefined
      : rest
  if (server === undefined) return [rawName]
  if (server.length === 0) {
    warn(`cc-task: invalid MCP wildcard "${rawName}" in a subagent toolFilter — expected mcp__<server> or mcp__<server>__<tool>`)
    return []
  }
  return [...knownNames].filter(name => name.startsWith(`${MCP_PUBLIC_PREFIX}${server}__`))
}

/**
 * Sanitize a definition's tool restriction against the LIVE set of names the
 * tools registry knows (registered or reserved — `ctx.tools.view(callingAgent)
 * .restrictableNames`, read at execute time so deferred MCP reservations on
 * the standing-scope layer are included).
 *
 * Rules:
 * - A name survives only when the registry knows it. Everything else is
 *   dropped with a warning; there is no static legal-names set, so mounted
 *   MCP tools and any future registered row are accepted without code churn.
 * - If the filter carried an `allow` list and any kept allow name is an MCP
 *   tool while `ToolSearch` is itself restrictable, `ToolSearch` is appended
 *   (deduped): the child otherwise holds MCP names with no load path.
 * - If the filter carried an `allow` list and sanitization left nothing, the
 *   result is `{ allow: [] }` — omitting `allow` would WIDEN the child to
 *   every tool, so an emptied allow-list is pinned as deny-all, loudly.
 */
function sanitizeToolFilter(
  filter: ToolRestriction,
  warn: (m: string) => void,
  knownNames: ReadonlySet<string>,
): ToolRestriction {
  const clean = (names: readonly string[]): string[] => {
    const out: string[] = []
    for (const rawName of names) {
      for (const expanded of expandFilterName(rawName, knownNames, warn)) {
        if (knownNames.has(expanded)) {
          if (!out.includes(expanded)) out.push(expanded)
        } else {
          warn(`cc-task: dropping unknown tool name "${expanded}" from a subagent toolFilter`)
        }
      }
    }
    return out
  }
  const hadAllow = filter.allow !== undefined
  const allow = filter.allow !== undefined ? clean(filter.allow) : undefined
  const deny = filter.deny !== undefined ? clean(filter.deny) : undefined
  if (hadAllow && allow !== undefined && allow.length > 0 && allow.some(name => name.startsWith(MCP_PUBLIC_PREFIX))
    && knownNames.has('ToolSearch') && !allow.includes('ToolSearch')) {
    allow.push('ToolSearch')
  }
  if (hadAllow && (allow === undefined || allow.length === 0)) {
    warn(
      'cc-task: a subagent toolFilter allow-list matched no mounted tools '
      + `(originals: ${(filter.allow ?? []).join(', ')}); the child will run with zero tools`,
    )
  }
  return {
    ...(hadAllow ? { allow: allow ?? [] } : {}),
    ...(deny !== undefined && deny.length > 0 ? { deny } : {}),
  }
}

/**
 * Register the Task tool.
 * @param ctx - the plug context.
 * @param registry - the per-workspace definition cache.
 * @returns the registration disposer, or undefined when the tools seam is absent.
 */
export function registerTaskTool(
  ctx: Context,
  registry: AgentRegistry,
): (() => void) | undefined {
  const tools = ctx.get('tools') as {
    register(def: unknown): () => void
    reserve(name: string): () => void
    get(name: string): unknown
    /**
     * Duck-typed `view()`: the only API that lists reserved+registered names
     * in one set (deferred MCP tools are reserved, not in `schemas()`).
     * `@internal` on ToolRuntime, so it is structural here and optional —
     * a seam without it degrades to an empty known set.
     *
     * Pass the calling agent: MCP tools register on the standing-scope layer
     * of the cc preset, which `view()` without a scope does not see.
     */
    view?(scope?: unknown): { restrictableNames: ReadonlySet<string> }
  } | undefined
  if (tools === undefined) return undefined

  // Keep the disabled harness `subagent` row's name restrictable (the CC
  // frontmatter `Task` translates to both `subagent` and `subagent_fork`), and
  // `workflow` for the deferred workflow row.
  for (const name of RESERVED_TOOL_NAMES) tools.reserve(name)

  return tools.register(defineTool({
    name: TASK_TOOL,
    description:
      'Delegate a well-scoped task to a subagent. Pass `subagent_type` to run a named agent from '
      + 'the session workspace (`.claude/agents`) — see the "Available subagents" section of the '
      + 'system prompt for the current list. Omit `subagent_type` (or use "general-purpose") for a '
      + 'plain fork that inherits your tools and context. The child runs to completion and returns '
      + 'its final text. Unknown types fail with the available list.',
    parameters: {
      subagent_type: {
        type: 'string',
        description: 'Optional agent type from the workspace `.claude/agents` definitions.',
      },
      description: {
        type: 'string',
        required: true,
        description: 'A short (3-5 word) task label, for display.',
      },
      prompt: {
        type: 'string',
        required: true,
        description: 'The task text delivered to the child as its first user message.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
        },
      },
      render: (_args: TaskArgs, value: { text: string }) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(args: TaskArgs, exec: { agent?: Agent; signal: AbortSignal }) {
      const agent = exec.agent
      if (agent === undefined) {
        throw new Error('subagent_fork requires a calling agent (exec.agent was undefined)')
      }
      const seam = ctx.get('subagents') as SubagentsLike | undefined
      if (seam === undefined) throw new Error('subagent_fork unavailable: no subagents seam')

      const type = args.subagent_type?.trim()
      const base = {
        label: args.description,
        prompt: [{ type: 'text' as const, text: args.prompt }],
        parent: agent,
        signal: exec.signal,
        maxDepth: DEFAULT_MAX_DEPTH,
      }

      if (type === undefined || type.length === 0 || type === GENERAL_PURPOSE) {
        const run = await seam.start('fork', base)
        return settle(run)
      }

      const root = cwdOf(agent)
      const definition = await registry.resolve(root, type)
      if (definition === undefined) {
        const available = (await registry.list(root)).map(def => def.agentType).join(', ')
        throw new Error(
          `unknown subagent_type "${type}"`
          + (available.length > 0 ? `; available in this workspace: ${available}` : '; this workspace defines no agents'),
        )
      }

      const routes = ctx.get('ccModelRoutes') as ModelRoutes | RoutesLike | undefined
      const route = routes?.resolve(definition.model)
      // LIVE known set, read at execute time so MCP tools mounted or deferred
      // after this plugin's apply (including hash-suffixed public names) are
      // all restrictable candidates for the child's filter. Pass the calling
      // agent: MCP tools live on the standing-scope layer, which the global
      // view (no scope) does not include.
      const knownNames = tools.view?.(agent).restrictableNames ?? new Set<string>()
      const run = await seam.start('fork', {
        ...base,
        persona: definition.systemPrompt,
        ...(definition.toolRestriction !== undefined
          ? { toolFilter: sanitizeToolFilter(definition.toolRestriction, message => ctx.logger.warn(message), knownNames) }
          : {}),
        ...(route !== undefined
          ? {
              agentOptions: stripUndefined({
                provider: route.provider,
                model: route.model,
                // Undeclared runtime extra key on AgentOptions: survives the
                // harness's child-options spread and is applied to every child
                // request by the cc-model-aliases host agent/request overlay.
                reasoningEffort: route.reasoningEffort,
              }),
            }
          : {}),
      })
      return settle(run)
    },
  }))
}

/** Await a run's terminal result and project it onto the tool output shape. */
async function settle(run: { result: Promise<{ stopReason: string; output?: readonly { type: string; text?: string }[] }> }): Promise<{ text: string }> {
  let result
  try {
    result = await run.result
  } catch (error) {
    throw new Error(`subagent run failed: ${(error as Error).message}`)
  }
  if (result.stopReason !== 'completed') {
    throw new Error(`subagent run stopped with reason "${result.stopReason}"`)
  }
  const text = (result.output ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('')
  return { text }
}

/** Drop undefined fields so per-field inheritance survives (never set to undefined). */
function stripUndefined(route: { provider?: string | undefined; model?: string | undefined; reasoningEffort?: string | undefined }): Record<string, string> {
  const out: Record<string, string> = {}
  if (route.provider !== undefined) out['provider'] = route.provider
  if (route.model !== undefined) out['model'] = route.model
  if (route.reasoningEffort !== undefined) out['reasoningEffort'] = route.reasoningEffort
  return out
}
