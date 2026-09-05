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

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentDefinition, ToolRestriction } from '@jianxx/dsh-cc-claude-code-agents'
import { defineTool } from '@jianxx/dsh-cc-tools'
import { cwdOf } from '@jianxx/dsh-cc-memory'
import type { DetailedRoute, ModelRoutes } from '@jianxx/dsh-cc-model-aliases'
import { toAgentOptions } from '@jianxx/dsh-cc-model-aliases'
import { collectFirstEpoch, type EpochEventBus, type EpochOutcome } from './epoch-collector.ts'
import type { AgentRegistry } from './registry.ts'
import { SpawnPinCapture } from './resume-capture.ts'
import { sanitizeToolFilter } from './sanitize-filter.ts'

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
 * Per-parent admission limit for continuable children (UX plan §3.6): no
 * upstream resident-children cap exists, so the Task tool refuses a new
 * continuable start when the parent already has this many live children —
 * counted directly as `listChildren` entries with `activity: 'running'`.
 * A safety valve, not a scheduling policy.
 */
export const MAX_LIVE_CONTINUABLE_CHILDREN = 25

/**
 * The env kill switch (UX plan §3.4): a non-empty value other than
 * case-insensitive `0`/`false` disables backgrounding-by-default.
 */
export const CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS'

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
    /** Caller-reserved durable id (becomes the child's session id). */
    childId?: string
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
  /**
   * Duck-typed interrupt (harness `ctx.subagents.interrupt`): cancels a live
   * child's current turn; admission is synchronous and an absent/settled
   * target is an accepted no-op. Used by the epoch collector's abort path.
   * Absent → abort degrades to a prompt resolve without interrupting.
   */
  interrupt?(childId: string, authority: { kind: 'ancestor'; agent: Agent }): void
  /**
   * Duck-typed `listChildren` (harness `ctx.subagents.listChildren`): the
   * durable children of one parent session with a store-snapshot `activity`.
   * Used by the §3.6 capacity guard. Absent → the guard degrades open.
   */
  listChildren?(parentSessionId: string, signal?: AbortSignal): Promise<
    { kind: string; activity?: string }[]
  >
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
 * Parse `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` (UX plan §3.4): a non-empty
 * value other than a case-insensitive `0`/`false` disables the kill switch's
 * targets (backgrounding-by-default pins and, from Slice 3, promotion).
 * Explicit `run_in_background` arguments stay honored both ways — declared
 * as a partial-parity deviation because upstream's exact precedence is
 * unverified.
 * @param env - the environment to read; defaults to `process.env`.
 */
export function backgroundTasksDisabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env[CLAUDE_CODE_DISABLE_BACKGROUND_TASKS]
  if (raw === undefined || raw === '') return false
  const lower = raw.toLowerCase()
  return lower !== '0' && lower !== 'false'
}

/**
 * Precedence for the background decision: explicit `run_in_background` always wins
 * (true and false alike), otherwise the definition's `background: true` pin applies,
 * otherwise foreground. A `true`-string pin cannot reach this check — the agents
 * parser rejects a non-boolean `background` at load time. With the
 * `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` kill switch armed, the pin path is
 * disabled (omissions collect in foreground); explicit arguments still win.
 */
function wantsBackground(
  args: TaskArgs,
  definition: { background?: boolean } | undefined,
  disabled: boolean,
): boolean {
  if (args.run_in_background === true) return true
  if (args.run_in_background === false) return false
  if (disabled) return false
  return definition?.background === true
}

/**
 * Register the Task tool.
 * @param ctx - the plug context.
 * @param registry - the per-workspace definition cache.
 * @param capture - the spawn-time resume-pin capture; undefined (the default,
 *   no `resumePins` plugin config) writes no pins and runs no preflight.
 * @returns the registration disposer, or undefined when the tools seam is absent.
 */
export function registerTaskTool(
  ctx: Context,
  registry: AgentRegistry,
  capture?: SpawnPinCapture,
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
          backgroundedByUser: { type: 'boolean' },
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

      const disabled = backgroundTasksDisabled()
      if (type === undefined || type.length === 0 || type === GENERAL_PURPOSE) {
        if (wantsBackground(args, undefined, disabled)) {
          return startBackground(seam, preparedBackground(base, capture), capture)
        }
        return collectForeground(ctx, seam, preparedBackground(base, capture), capture, exec)
      }

      if (type === FORK_SENTINEL) {
        // Rejected BEFORE any seam call: fork children are one-shot until the
        // upstream harness continuable-fork prefix-reuse issue lands.
        if (wantsBackground(args, undefined, disabled)) {
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
      if (wantsBackground(args, definition, disabled)) {
        return startBackground(seam, preparedBackground(folded, capture, definition, routes), capture)
      }
      return collectForeground(ctx, seam, preparedBackground(folded, capture, definition, routes), capture, exec)
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
  /**
   * Caller-reserved durable child id — preallocated by the capture flow so
   * the pin can be written before the child exists (plan §4.5 step 1).
   */
  childId?: string
  /** Capture-only metadata (never forwarded to the seam): definition. */
  captureDefinition?: AgentDefinition
  /** Capture-only metadata: the atomic model-selector resolution. */
  captureSelector?: DetailedRoute
}

/**
 * Thread the preallocated childId and the capture metadata into a background
 * request. Without capture (no `resumePins` config) the request is returned
 * unchanged — zero behavior difference.
 */
function preparedBackground(
  request: BackgroundRequest,
  capture: SpawnPinCapture | undefined,
  definition?: AgentDefinition,
  routes?: ModelRoutes,
): BackgroundRequest {
  if (capture === undefined) return request
  return {
    ...request,
    childId: capture.preallocateChildId(),
    ...(definition !== undefined ? { captureDefinition: definition } : {}),
    captureSelector: routes !== undefined
      ? routes.resolveDetailed(definition?.model)
      : SpawnPinCapture.inheritSelector(definition?.model),
  }
}

/**
 * The §3.6 capacity guard (both `startBackground` and the collect path):
 * refuse a new continuable child when the parent already has
 * {@link MAX_LIVE_CONTINUABLE_CHILDREN} live children — counted directly as
 * `listChildren` entries with `activity: 'running'`. Degrades open when the
 * seam lacks `listChildren` or the listing fails: a safety valve must never
 * block starts on its own infrastructure trouble.
 */
async function assertLiveCapacity(
  seam: SubagentsLike,
  parent: Agent,
  signal: AbortSignal,
): Promise<void> {
  if (typeof seam.listChildren !== 'function') return
  let children: { kind: string; activity?: string }[]
  try {
    children = await seam.listChildren(parent.id, signal)
  } catch {
    return
  }
  const live = children.filter(child => child.kind === 'child' && child.activity === 'running').length
  if (live >= MAX_LIVE_CONTINUABLE_CHILDREN) {
    throw new Error(
      `parent has ${MAX_LIVE_CONTINUABLE_CHILDREN} live subagents; /agents stop <id> to `
      + 'release one, or let children settle',
    )
  }
}

/** Capability checks shared by `startBackground` and the collect path. */
function assertContinuableCapable(seam: SubagentsLike): void {
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
}

/**
 * Per-reason failure copy for the collect path (UX plan §4 Slice 3 item 2):
 * mirrors `settle`'s contract — `completed` becomes the tool result, every
 * other stop reason throws with a reason-specific, actionable message.
 */
function stopReasonMessage(childId: string, stopReason: string): string {
  switch (stopReason) {
    case 'error':
      return `subagent ${childId} run failed: the child hit a model or transport failure (stopReason "error").`
    case 'max-tokens':
      return `subagent ${childId} stopped with reason "max-tokens": the child hit its token ceiling before finishing.`
    case 'refusal':
      return `subagent ${childId} stopped with reason "refusal": the child declined the task.`
    case 'aborted':
      return `subagent ${childId} was interrupted (stopReason "aborted"); it may still be resumed — /agents for status.`
    default:
      return `subagent ${childId} stopped with reason "${stopReason}".`
  }
}

/**
 * Project the collect path's epoch outcome onto the tool output shape
 * (`settle`'s contract): `completed` → the closing message's text blocks;
 * any other stop reason — including the abort path's prompt-synthetic
 * `aborted` — throws with per-reason copy.
 */
function outcomeToResult(
  childId: string,
  outcome: EpochOutcome,
  captureWarning: string | undefined,
): { text: string; status: 'completed' } {
  if (outcome.kind === 'aborted' || outcome.stopReason !== 'completed') {
    throw new Error(stopReasonMessage(childId, outcome.kind === 'aborted' ? 'aborted' : outcome.stopReason))
  }
  const text = (outcome.output ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('')
  return {
    text:
      text
      + (captureWarning !== undefined
        ? `\nresume pin capture failed: ${captureWarning}; this child will resume with legacy semantics`
        : ''),
    status: 'completed' as const,
  }
}

/**
 * Dispatch a FOREGROUND non-fork call by collecting the child's first epoch
 * inline through the epoch collector (`docs/plans/2026-09-10-epoch-collector-dsh-cc.md`).
 * Performs the same pin preallocation, pre-start pin write, and
 * tombstone-on-throw as `startBackground` — a foreground-launched child is
 * pinnable/resumable exactly like a background one. The child's settlement
 * notice is suppressed (pop-once) because the epoch is consumed here.
 */
async function collectForeground(
  ctx: Context,
  seam: SubagentsLike,
  request: BackgroundRequest,
  capture: SpawnPinCapture | undefined,
  exec: { agent?: Agent; signal: AbortSignal },
): Promise<{ text: string; status: 'completed' }> {
  const agent = exec.agent
  if (agent === undefined) {
    throw new Error('subagent_fork requires a calling agent (exec.agent was undefined)')
  }
  await assertLiveCapacity(seam, agent, exec.signal)
  assertContinuableCapable(seam)
  const { label, prompt, parent, signal, childId, captureDefinition, captureSelector, ...rest } = request
  // The watch map keys on the durable child id, so the collect path ALWAYS
  // preallocates one — via the capture flow when pins are armed, otherwise a
  // fresh id (the child's session id, exactly as the harness would mint it).
  const durableChildId = childId ?? randomUUID()
  // §4.5 step 2 (parity with startBackground): the pin is written BEFORE the
  // creation call; capture trouble becomes an explicit captureWarning line.
  let captureWarning: string | undefined
  if (capture !== undefined && childId !== undefined && captureSelector !== undefined) {
    captureWarning = await capture.write({
      parentSessionId: parent.id,
      label,
      childId,
      definition: captureDefinition,
      selector: captureSelector,
      parentRoute: parent.options,
      toolFilter: 'toolFilter' in rest ? rest.toolFilter : undefined,
      cwd: cwdOf(parent),
    })
  }
  let startFailed = false
  try {
    const outcome = await collectFirstEpoch({
      bus: ctx as unknown as EpochEventBus,
      childId: durableChildId,
      agent,
      signal,
      subagents: seam,
      start: async () => {
        try {
          await seam.startContinuable!({
            provider: PROVIDER_SPAWN,
            label,
            childId: durableChildId,
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
          startFailed = true
          throw error
        }
      },
    })
    return outcomeToResult(durableChildId, outcome, captureWarning)
  } catch (error) {
    // §4.5 step 4 (parity with startBackground): a start that rolled back the
    // creation must not leave the pin behind — tombstone, then rethrow. A
    // non-`completed` epoch terminal or an abort keeps the child (it is
    // resumable), so no tombstone on those.
    if (startFailed && capture !== undefined && childId !== undefined) await capture.tombstone(childId)
    const message = (error as Error).message ?? String(error)
    if (startFailed
      && (message.includes('UNSUPPORTED_CAPABILITY') || message.includes('does not support continuable'))) {
      throw new Error(
        `background subagents are unavailable: ${message}. Background subagents require a `
        + 'provider that implements the continuable-creation capability (prepareContinuable) '
        + 'and a session-persistence backend; run this Task in the foreground instead.',
      )
    }
    throw error
  }
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
  capture?: SpawnPinCapture,
): Promise<{ text: string; status: 'async_launched'; agentId: string }> {
  assertContinuableCapable(seam)
  const { label, prompt, parent, signal, childId, captureDefinition, captureSelector, ...rest } = request
  // §3.6 capacity guard: refuse before any pin write or creation call.
  await assertLiveCapacity(seam, parent, signal)
  // §4.5 step 2: the pin is written BEFORE the creation call (crash
  // consistency). A failed capture keeps the spawn alive but must never be
  // silent: the returned reason becomes an explicit captureWarning line in
  // the tool result ("this child will resume with legacy semantics").
  let captureWarning: string | undefined
  if (capture !== undefined && childId !== undefined && captureSelector !== undefined) {
    captureWarning = await capture.write({
      parentSessionId: parent.id,
      label,
      childId,
      definition: captureDefinition,
      selector: captureSelector,
      parentRoute: parent.options,
      toolFilter: 'toolFilter' in rest ? rest.toolFilter : undefined,
      cwd: cwdOf(parent),
    })
  }
  let started: ContinuableStart
  try {
    started = await seam.startContinuable!({
      provider: PROVIDER_SPAWN,
      label,
      ...(childId !== undefined ? { childId } : {}),
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
    // §4.5 step 4: the creation rolled back fully (no child id), so the pin
    // must not survive it — tombstone, then rethrow the error unchanged.
    if (capture !== undefined && childId !== undefined) await capture.tombstone(childId)
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
      + 'conversation, `interrupt_agent` to stop its current turn.'
      + (captureWarning !== undefined
        ? `\nresume pin capture failed: ${captureWarning}; this child will resume with legacy semantics`
        : ''),
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

