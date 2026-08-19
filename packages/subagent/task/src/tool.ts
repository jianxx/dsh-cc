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
import { defineTool, CC_TO_HARNESS_TOOLS } from '@jianxx/dsh-cc-tools'
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
 * Reserved names are LEGAL for `restrict()`; they are NOT dropped by
 * sanitization. Sanitization only strips names that are neither registered
 * nor reserved (a genuinely unknown name — a typo or a tool the composition
 * removed entirely). At this package's apply time nothing else has registered
 * yet, so the only known set we can assert is this reservation list; every
 * other name passes through and is validated at the child's own restrict().
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
  resolve(model: string | undefined): { provider?: string; model?: string } | undefined
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
 * The names a subagent toolFilter may legally carry: every name the CC
 * frontmatter translation can produce (`CC_TO_HARNESS_TOOLS` values), plus
 * this tool's own name (registered later in the same apply chain), plus the
 * reserved names. Names outside this set are dropped with a warning — at
 * load time `resolveToolRestriction` already ran the strict translation, so
 * anything not in this set is a typo'd CC name or a removed row.
 */
const LEGAL_FILTER_NAMES: ReadonlySet<string> = new Set([
  'subagent_fork',
  'subagent',
  'workflow',
  ...Object.values(CC_TO_HARNESS_TOOLS).flat(),
])

/**
 * Drop names outside the legal filter set so the child's scoped `restrict()`
 * never sees a name that was already invalid at load time (a typo'd CC name
 * passes through strict translation verbatim and would fail the child start).
 */
function sanitizeToolFilter(filter: ToolRestriction, warn: (m: string) => void): ToolRestriction {
  const clean = (names: readonly string[] | undefined) =>
    names?.filter(name => {
      if (LEGAL_FILTER_NAMES.has(name)) return true
      warn(`cc-task: dropping unknown tool name "${name}" from a subagent toolFilter`)
      return false
    })
  const allow = clean(filter.allow)
  const deny = clean(filter.deny)
  return {
    ...(allow !== undefined && allow.length > 0 ? { allow } : {}),
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
      const run = await seam.start('fork', {
        ...base,
        persona: definition.systemPrompt,
        ...(definition.toolRestriction !== undefined
          ? { toolFilter: sanitizeToolFilter(definition.toolRestriction, message => ctx.logger.warn(message)) }
          : {}),
        ...(route !== undefined
          ? { agentOptions: stripUndefined({ provider: route.provider, model: route.model }) }
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
function stripUndefined(route: { provider?: string | undefined; model?: string | undefined }): Record<string, string> {
  const out: Record<string, string> = {}
  if (route.provider !== undefined) out['provider'] = route.provider
  if (route.model !== undefined) out['model'] = route.model
  return out
}
