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
 * - `subagent_type` omitted (or the `general-purpose` sentinel) → a fresh
 *   spawn of the caller, no definition participation, no parent history.
 * - `subagent_type` equal to the `fork` sentinel → a conversation-inheriting
 *   fork of the caller (CC `subagent_type: "fork"`). The sentinel wins over a
 *   workspace file of the same name; `.claude/agents/fork.md` is unreachable.
 * - A type matching a definition under the session cwd → spawn with the
 *   definition's system prompt delivered as the child `persona`, the model's
 *   task text as the first user message, a routes-resolved `agentOptions`
 *   override, and the definition's tool restriction (sanitized of tool names
 *   this composition no longer registers).
 * - Any other type → an error result listing the available types.
 *
 * The seam's capability contract (`assertCapabilities`) is honoured
 * transitively: spawn and fork both support persona/toolFilter/depthLimit, so
 * every field this tool forwards is legal.
 *
 * @module @jianxx/dsh-cc-subagent-task/tool
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRestriction } from '@jianxx/dsh-cc-claude-code-agents'
import { defineTool } from '@jianxx/dsh-cc-tools'
import { cwdOf } from '@jianxx/dsh-cc-memory'
import type { ModelRoutes } from '@jianxx/dsh-cc-model-aliases'
import { toAgentOptions } from '@jianxx/dsh-cc-model-aliases'
import type { AgentRegistry } from './registry.ts'

/** The registered tool name (the CC display mapping surfaces it as `Task`). */
export const TASK_TOOL = 'subagent_fork'

/** The sentinel a model uses to ask for a plain spawn with no definition. */
const GENERAL_PURPOSE = 'general-purpose'

/** The sentinel a model uses to inherit the parent's completed-turn prefix. */
const FORK_SENTINEL = 'fork'

/** Fresh-child provider: no parent conversation (CC Task default). */
const PROVIDER_SPAWN = 'spawn'

/** The default delegation-depth cap for a Task child (matches the harness default). */
const DEFAULT_MAX_DEPTH = 3

/** The upstream harness issue that keeps fork children one-shot. */
const FORK_BACKGROUND_ISSUE = 'deepseek-harness#2124'

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
interface ContinuableStart {
  childId: string
  messageId: string
}

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
  /**
   * Duck-typed continuable-creation entry (harness `ctx.subagents.startContinuable`):
   * establishes a durable child that accepts follow-up turns by its `childId`.
   * A seam without it cannot serve background dispatch.
   */
  startContinuable?(spec: {
    provider: string
    label: string
    request: {
      prompt: readonly { type: 'text'; text: string }[]
      parent: Agent
      agentOptions?: Record<string, string>
      toolFilter?: ToolRestriction
      maxDepth?: number
      persona?: string
    }
    signal: AbortSignal
  }): Promise<ContinuableStart>
  getProvider(name: string): unknown
  list(): string[]
}

/** A structural subset of a provider descriptor exposing the capability probe. */
interface ProviderLike {
  prepareContinuable?: unknown
}

interface TaskArgs {
  /** The CC agent type to dispatch to; omit for a plain spawn. */
  subagent_type?: string
  /** A short (3-5 word) task label, persisted with the child run. */
  description: string
  /** The task text delivered as the child's first user message. */
  prompt: string
  /**
   * Start the child as a durable background agent and return immediately with
   * its agent id; the child's report/finish notice arrives as a waking message.
   * Default false (foreground, wait for the final text).
   */
  run_in_background?: boolean
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
 * Precedence for the background decision: explicit `run_in_background` always wins
 * (true and false alike), otherwise the definition's `background: true` pin applies,
 * otherwise foreground. A `true`-string pin cannot reach this check — the agents
 * parser rejects a non-boolean `background` at load time.
 */
function wantsBackground(args: TaskArgs, definition?: { background?: boolean }): boolean {
  if (args.run_in_background === true) return true
  if (args.run_in_background === false) return false
  return definition?.background === true
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
      'Delegate a well-scoped task to a subagent. The child starts with a fresh conversation: '
      + 'write a self-contained prompt (paths, constraints, what to return). Pass `subagent_type` '
      + 'to run a named agent from the session workspace (`.claude/agents`) — see the "Available '
      + 'subagents" section of the system prompt for the current list. Omit `subagent_type` (or '
      + 'use "general-purpose") for a plain spawn that inherits your tools but not your history. '
      + 'Pass `subagent_type: "fork"` to inherit completed parent turns (and the prompt cache, '
      + 'when the child stays on the same model). The child runs to completion and returns its '
      + 'final text. Unknown types fail with the available list. '
      + 'Omit `run_in_background` (foreground) when this turn\u2019s answer to the human depends on '
      + 'the child: the call blocks until the child finishes and returns its final text. Pass '
      + '`run_in_background: true` when the human can keep talking while the child works: the call '
      + 'returns promptly once the child has accepted its first turn (with its `agentId`), and you '
      + 'are told when it finishes via a waking message; synthesize on the wake, do not poll. '
      + 'A definition with `background: true` backgrounds on omit; pass `run_in_background: false` '
      + 'when this turn needs that child\u2019s result \u2014 explicit true/false always win over the pin. '
      + 'Continue a background child later with `send_message` addressed to its id; inspect it with '
      + '`list_agents` and stop its current turn with `interrupt_agent`. '
      + 'Note: `fork` cannot run in the background (upstream harness issue #2124).',
    parameters: {
      subagent_type: {
        type: 'string',
        description:
          'Named agent from `.claude/agents`, or the sentinels "general-purpose" (fresh spawn) '
          + 'and "fork" (inherit completed parent turns). "fork" is reserved and wins over a '
          + 'workspace file of the same name.',
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
      run_in_background: {
        type: 'boolean',
        description:
          'Explicit true starts a durable background child (returns its agentId; the report or '
          + 'finish notice arrives as a waking message) and explicit false forces foreground \u2014 '
          + 'both win over a definition pin. Omitted: background when the definition pins '
          + '`background: true`, foreground otherwise.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          status: { type: 'string', enum: ['completed', 'async_launched'] },
          agentId: { type: 'string' },
        },
      },
      render: (_args: TaskArgs, value: { text: string; status?: string; agentId?: string }) => [
        { type: 'text', text: value.text },
      ],
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
        if (wantsBackground(args)) return startBackground(seam, base)
        const run = await seam.start(PROVIDER_SPAWN, base)
        return settle(run)
      }

      if (type === FORK_SENTINEL) {
        // Rejected BEFORE any seam call: fork children are one-shot until the
        // upstream harness continuable-fork prefix-reuse issue lands.
        if (wantsBackground(args)) {
          throw new Error(
            'subagent_type "fork" cannot run in the background: fork children are one-shot '
            + `until upstream harness issue ${FORK_BACKGROUND_ISSUE} resolves. Workaround: use a `
            + 'plain background spawn instead (omit subagent_type, or name a definition) with '
            + 'run_in_background: true.',
          )
        }
        const run = await seam.start(FORK_SENTINEL, base)
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

      const routes = ctx.get('ccModelRoutes') as ModelRoutes | undefined
      const agentOptions = toAgentOptions(routes?.resolve(definition.model))
      // LIVE known set, read at execute time so MCP tools mounted or deferred
      // after this plugin's apply (including hash-suffixed public names) are
      // all restrictable candidates for the child's filter. Pass the calling
      // agent: MCP tools live on the standing-scope layer, which the global
      // view (no scope) does not include.
      const knownNames = tools.view?.(agent).restrictableNames ?? new Set<string>()
      const folded = {
        ...base,
        persona: definition.systemPrompt,
        ...(definition.toolRestriction !== undefined
          ? { toolFilter: sanitizeToolFilter(definition.toolRestriction, message => ctx.logger.warn(message), knownNames) }
          : {}),
        ...(agentOptions !== undefined ? { agentOptions } : {}),
      }
      if (wantsBackground(args, definition)) return startBackground(seam, folded)
      const run = await seam.start(PROVIDER_SPAWN, folded)
      return settle(run)
    },
  }))
}

/**
 * The background request shape: everything `startContinuable` forwards except
 * the provider/label envelope and the signal, which live at the spec level.
 */
type BackgroundRequest = {
  label: string
  prompt: readonly { type: 'text'; text: string }[]
  parent: Agent
  signal: AbortSignal
  maxDepth?: number
  persona?: string
  agentOptions?: Record<string, string>
  toolFilter?: ToolRestriction
}

/**
 * Dispatch a background call as a durable continuable child on the `spawn`
 * provider. The definition folding (persona, sanitized toolFilter,
 * alias-resolved agentOptions, maxDepth) happened before this call — cold
 * resume never re-captures the parent's policy, so the creation input must
 * already be final. Resolves once the child accepted its initial prompt.
 * Capability gaps (seam without `startContinuable`, provider without
 * `prepareContinuable`) surface as actionable tool errors naming the cause.
 */
async function startBackground(
  seam: SubagentsLike,
  request: BackgroundRequest,
): Promise<{ text: string; status: 'async_launched'; agentId: string }> {
  if (typeof seam.startContinuable !== 'function') {
    throw new Error(
      'background subagents are unavailable: the subagents seam does not expose '
      + 'startContinuable. Background subagents require a subagent service with the '
      + 'continuable-creation capability (prepareContinuable on the provider) and a '
      + 'session-persistence backend; run this Task in the foreground instead.',
    )
  }
  const provider = seam.getProvider(PROVIDER_SPAWN) as ProviderLike | undefined
  if (provider !== undefined && provider !== null && provider.prepareContinuable === undefined) {
    throw new Error(
      `background subagents are unavailable: provider "${PROVIDER_SPAWN}" does not support `
      + 'continuable children (UNSUPPORTED_CAPABILITY: no prepareContinuable). Background '
      + 'subagents require a provider that implements the continuable-creation capability '
      + 'and a session-persistence backend; run this Task in the foreground instead.',
    )
  }
  const { label, prompt, parent, signal, ...rest } = request
  let started: ContinuableStart
  try {
    started = await seam.startContinuable({
      provider: PROVIDER_SPAWN,
      label,
      request: {
        prompt,
        parent,
        ...('persona' in rest ? { persona: rest.persona } : {}),
        ...('toolFilter' in rest ? { toolFilter: rest.toolFilter } : {}),
        ...('agentOptions' in rest ? { agentOptions: rest.agentOptions } : {}),
        ...('maxDepth' in rest ? { maxDepth: rest.maxDepth } : {}),
      },
      signal,
    })
  } catch (error) {
    const message = (error as Error).message ?? String(error)
    if (message.includes('UNSUPPORTED_CAPABILITY') || message.includes('does not support continuable')) {
      throw new Error(
        `background subagents are unavailable: ${message}. Background subagents require a `
        + 'provider that implements the continuable-creation capability (prepareContinuable) '
        + 'and a session-persistence backend; run this Task in the foreground instead.',
      )
    }
    throw error
  }
  return {
    text:
      `Background subagent started (agentId: ${started.childId}). It is running in the `
      + 'background; its report or finish notice will arrive as a waking message. Control it '
      + 'by that id: `list_agents` for status, `send_message` to continue the same '
      + 'conversation, `interrupt_agent` to stop its current turn.',
    status: 'async_launched',
    agentId: started.childId,
  }
}

/** Await a run's terminal result and project it onto the tool output shape. */
async function settle(run: { result: Promise<{ stopReason: string; output?: readonly { type: string; text?: string }[] }> }): Promise<{ text: string; status: 'completed' }> {
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
  return { text, status: 'completed' as const }
}

