/**
 * Bridge for unmodified Claude Code command hooks on harness interception
 * extension points. It supports SessionStart, prompt/tool pre/post, Stop, subagent
 * start/stop, and a set of lifecycle/observe events (PermissionRequest,
 * PermissionDenied, Notification (permission_prompt), PostCompact, SessionEnd,
 * StopFailure, TaskCreated, TeammateIdle, and a first-run Setup approximation).
 * It owns Claude payloads, environment, substitution, and decision
 * mapping; shared execution and parsing live in `dsh-hook-protocol`.
 * `updatedInput` is logged and warned but not honored. `prompt` and `agent`
 * executors fork a one-shot subagent when their enable flags are set. Bespoke
 * behavior should use typed native plugins on the same extension points; see the
 * [hook-bridges Agent Note](../../../../.agents/notes/implemented/feature/2026-06-30-hook-bridges.md).
 * @module @jianxx/dsh-cc-hooks-claude-code
 */

import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
// Type-seam imports: also pull in the declaration-merged `events` interfaces so the
// `approval/*` (user-approval) and `jobs` (dsh-jobs) events below typecheck.
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import type { PostToolDecision, PreToolDecision, ToolExecution, ToolExecutionResult } from '@jianxx/dsh-cc-tools'
import {
  appendHookInvoked,
  appendHookResult,
  createDetachedRuns,
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_STDERR_SUMMARY_MAX_CHARS,
  matchesMatcher,
  mergeHookOutputs,
  runHook,
  runHttpHook,
  type HookCommand,
  type HookOutput,
  type MatcherGroup,
  type MergedHookOutcome,
} from '@jianxx/dsh-cc-hook-protocol'
// Pulls in the declaration-merged subagent events and the identity pairing their
// start/end edges.
import type { SubagentRunId } from '@deepseek-ai/dsh-subagent'
import { parseClaudeCodeConfig, type ClaudeCodeHookConfig } from './config.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Harness-home path resolver, provided by @deepseek-ai/dsh-app-boot at boot. Optional in tests. */
    dshHomePath?: (...segments: string[]) => string
  }
}

export const name = 'hooks-claude-code'
// `bash` is required to run hooks; the rest are read opportunistically via
// ctx.get so a deployment can load this bridge without every extension point present.
export const inject = ['shell']

/** Plugin config: where the CC hook config lives + substitution roots. */
export interface Config {
  /**
   * Path to a `hooks.json` or a settings file whose `hooks` key holds the config.
   * Optional: when unset, defaults to `$DSH_HOME/hooks.json` (resolved via
   * `ctx.dshHomePath`); when that too is unavailable, the bridge logs and
   * registers no hooks.
   * Process-level: read once at load, a relative path resolves against the process
   * launch cwd, so one config applies to the whole process.
   * TODO(per-session-hook-config): per-session discovery of a project-local
   * `hooks.json` from each `session/new.cwd`.
   */
  configPath?: string
  /**
   * Replaces `${CLAUDE_PLUGIN_ROOT}` in command strings (the plugin's root dir).
   */
  pluginRoot?: string
  /**
   * Replaces `${CLAUDE_PROJECT_DIR}` in command strings AND is exported as the
   * `CLAUDE_PROJECT_DIR` env var for hook processes. When omitted, the env var
   * defaults per-run to the agent's session workspace (`session.header.cwd`, the
   * same dir the hook runs in) — Claude Code always exports this var, and common
   * unmodified hooks reference `$CLAUDE_PROJECT_DIR` for project-relative paths.
   */
  projectDir?: string
  /** Default per-hook timeout in ms when a hook sets none (CC default: 600000). */
  defaultTimeoutMs?: number
  /** Character cap for the `hook/result` event's persisted stderr summary. */
  stderrSummaryMaxChars?: number
  /**
   * URL-pattern allowlist (`*` wildcard) enforced before any `http` hook POST.
   * Absent/empty (the schemastery default) is unrestricted — the safe default
   * that cannot silently block http hooks; non-empty restricts to matching URLs.
   */
  allowedHttpHookUrls?: string[]
  /** Env-var names allowed to interpolate into `http` hook header values. */
  httpAllowedEnvVars?: string[]
  /**
   * Run configured `prompt` hooks by forking a small-model one-shot subagent
   * (default `false` — a configured-but-disabled `prompt` hook is skipped with a
   * warning, preserving the old safe default).
   */
  enablePromptHooks?: boolean
  /**
   * Run configured `agent` hooks by forking a verification subagent (default
   * `false` — same disabled-skip behavior as `enablePromptHooks`).
   */
  enableAgentHooks?: boolean
}

export const Config: z<Config> = z.object({
  configPath: z.string(),
  pluginRoot: z.string(),
  projectDir: z.string(),
  defaultTimeoutMs: z.number().default(DEFAULT_HOOK_TIMEOUT_MS),
  stderrSummaryMaxChars: z.number().default(DEFAULT_STDERR_SUMMARY_MAX_CHARS),
  allowedHttpHookUrls: z.array(z.string()),
  httpAllowedEnvVars: z.array(z.string()),
  enablePromptHooks: z.boolean().default(false),
  enableAgentHooks: z.boolean().default(false),
})

/** A stable per-handler id so an invoked/result pair correlates in the log. */
let handlerCounter = 0
function nextHandlerId(point: string): string {
  return `claude-code:${point}:${++handlerCounter}`
}

/** The `{kind:'plugin'}` source stamped on every context this bridge injects. */
const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'hooks-claude-code' }

/** The summary cap bounds a persisted event field — a positive integer or the slice misbehaves silently. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`hooks-claude-code: ${name} must be a positive integer`)
  }
}

export function apply(ctx: Context, config: Config): void {
  // Resolve the hook config path: an explicit config value wins, otherwise
  // default to $DSH_HOME/hooks.json via ctx.dshHomePath. With neither available
  // (e.g. an app-boot that does not provide dshHomePath), register nothing and
  // log, rather than relying on a read error below to degrade silently.
  const configPath = config.configPath || ctx.dshHomePath?.('hooks.json')
  if (!configPath) {
    ctx.logger.info('no hooks config path; hooks disabled')
    return
  }
  // Validate before config parsing so a bad value cannot be hidden by its early return.
  const stderrSummaryMaxChars = config.stderrSummaryMaxChars ?? DEFAULT_STDERR_SUMMARY_MAX_CHARS
  assertPositiveInteger('stderrSummaryMaxChars', stderrSummaryMaxChars)
  const defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
  // Parse once at load. A read or parse failure logs and registers nothing.
  let parsed: ClaudeCodeHookConfig = {}
  try {
    const raw: unknown = JSON.parse(readFileSync(configPath, 'utf8'))
    const result = parseClaudeCodeConfig(raw, {
      ...config.pluginRoot !== undefined ? { pluginRoot: config.pluginRoot } : {},
      ...config.projectDir !== undefined ? { projectDir: config.projectDir } : {},
    })
    parsed = result.config
    for (const s of result.skipped) {
      ctx.logger.warn(`hooks-claude-code: skipping unsupported "${s.type}" hook on ${s.event} (unknown hook type)`)
    }
  } catch (error: unknown) {
    ctx.logger.warn(`hooks-claude-code: could not load hook config "${configPath}": ${String(error)} — no hooks registered`)
    return
  }

  // Emit-shaped points run detached, so track their chains; disposal aborts
  // active hooks and drains continuations before resolving.
  const detached = createDetachedRuns()
  // Only the start edge guarantees registry access. Retain each local child
  // through its paired end so stop hooks keep the session workspace after the
  // handle unregisters the agent. Every retained entry relies on that paired
  // end; a producer that can omit it must provide another release edge.
  const subagentChildren = new Map<SubagentRunId, Agent>()
  // Every subagent id seen via subagent/start (or its paired end). Used to
  // restrict the TeammateIdle bridge to subagent scopes, since `agent/status`
  // itself does not distinguish root from child agents.
  const subagentIds = new Set<string>()
  ctx.effect(() => () => detached.drain(), 'hooks-claude-code: drain detached hook runs')

  /**
   * Run every hook configured for `point` whose matcher selects
   * `matchQuery`, with the per-event `payload` on stdin, and fold the results.
   * Writes a `hook/invoked`/`hook/result` pair per hook when `opts.turn` names
   * an open turn. Detached lifecycle points omit the pair. Returns the merged outcome (a neutral,
   * already-most-restrictive view) for the caller to map onto its extension point
   * decision. `matchQuery` is the event's matcher subject (tool name, session
   * source, …); `''` for events that ignore matchers.
   */
  async function runPoint(
    point: string,
    matchQuery: string,
    payload: unknown,
    opts: { agent?: Agent; turn?: number; readonly signal: AbortSignal },
  ): Promise<MergedHookOutcome> {
    const groups: MatcherGroup[] = parsed[point] ?? []
    const outputs: HookOutput[] = []
    // Run the hook in the agent's session workspace (the `session/new` cwd on the session
    // header), not the executor or entry-point process's launch dir.
    const workdir = opts.agent?.session.header.cwd
    // CLAUDE_PROJECT_DIR: an explicit config value wins; otherwise default it to the session
    // workspace (the same dir the hook runs in).
    const projectDir = config.projectDir ?? workdir
    const hookEnv = projectDir !== undefined ? { CLAUDE_PROJECT_DIR: projectDir } : undefined
    for (const group of groups) {
      if (!matchesMatcher(group.matcher, matchQuery, 'claude-code')) continue
      for (const hook of group.hooks) {
        const handlerId = nextHandlerId(point)
        const session = opts.agent?.session
        if (session && opts.turn !== undefined) {
          appendHookInvoked(session, {
            turn: opts.turn, point, dialect: 'claude-code', handlerId,
            ...group.matcher !== undefined ? { matcher: group.matcher } : {},
          })
        }
        const { output, durationMs } = await dispatchHook(ctx, hook, {
          payload,
          defaultTimeoutMs,
          ...hookEnv !== undefined ? { env: hookEnv } : {},
          ...workdir !== undefined ? { cwd: workdir } : {},
          signal: opts.signal,
          ...opts.agent !== undefined ? { agent: opts.agent } : {},
          // Discard a `hookSpecificOutput` block whose `hookEventName` names a
          // different event than the one firing (the schemas key it by event).
          expectedEventName: point,
          ...config.allowedHttpHookUrls !== undefined ? { allowedHttpHookUrls: config.allowedHttpHookUrls } : {},
          httpAllowedEnvVars: httpAllowedEnvVars(),
          enablePromptHooks: config.enablePromptHooks ?? false,
          enableAgentHooks: config.enableAgentHooks ?? false,
        })
        outputs.push(output)
        if (output.updatedInput !== undefined) {
          ctx.logger.warn(`hooks-claude-code: ${point} hook requested updatedInput, which is not yet honored (ignored)`)
        }
        if (output.systemMessage !== undefined) {
          ctx.logger.warn(`hooks-claude-code: ${point} hook emitted a systemMessage, which is not yet surfaced (ignored)`)
        }
        if (session && opts.turn !== undefined) {
          appendHookResult(session, { turn: opts.turn, point, handlerId, output, stderrSummaryMaxChars, durationMs })
        }
      }
    }
    return mergeHookOutputs(outputs)
  }

  // The http-hook header interpolation policy: the effective allowlist is the
  // configured names resolved once (a deployment's fixed allowlist, not a
  // per-run knob).
  const httpAllowedEnvVars = (): ReadonlySet<string> => new Set(config.httpAllowedEnvVars ?? [])

  // TODO(hook-continue-false): `merged.stop` is logged but needs a run-level halt mechanism.

  /** Build additional model context from hook output, or return undefined when empty. */
  function contextFrom(merged: MergedHookOutcome): UserMessage | undefined {
    if (merged.additionalContext.length === 0) return undefined
    const content: ContentBlock[] = merged.additionalContext.map(text => ({ type: 'text', text }))
    return createUserMessage({ content, source: PLUGIN_SOURCE })
  }

  /** Prepend one context without flattening source fields or other downstream metadata. */
  function prependContext(ours: UserMessage, theirs: UserMessage[] | undefined): UserMessage[] {
    return [ours, ...theirs ?? []]
  }

  // SessionStart injects context when its detached hook resolves; a slow hook
  // may miss the first request.
  // TODO(session-start-gating): add a startup gate before promising first-turn delivery.
  ctx.on('agent/session-start', ({ agent, source }) => {
    detached.track(runPoint('SessionStart', source, sessionStartPayload(ctx, agent, source), { agent, signal: detached.signal })
      .then((merged) => {
        const context = contextFrom(merged)
        if (context) agent.inject(context)
      })
      .catch((error: unknown) => {
        ctx.logger.warn(`hooks-claude-code: SessionStart hook failed: ${String(error)}`)
      }))
    // Setup first-run approximation: a `startup` source means the session was
    // seeded brand-new (no prior history), so it is the closest harness analog
    // to Claude Code's initial boot. resume/clear/compact sources skip it.
    if (source === 'startup') {
      detached.track(runPoint('Setup', 'init', setupPayload(ctx, agent), { agent, signal: detached.signal })
        .catch((error: unknown) => { ctx.logger.warn(`hooks-claude-code: Setup hook failed: ${String(error)}`) }))
    }
    // SessionResume: a session resuming prior history. Only the `resume` source
    // fires it — dsh has no emit point for `clear`/`compact`, so those stay
    // unimplemented (see docs).
    if (source === 'resume') {
      detached.track(runPoint('SessionResume', '', sessionResumePayload(ctx, agent, source), { agent, signal: detached.signal })
        .catch((error: unknown) => { ctx.logger.warn(`hooks-claude-code: SessionResume hook failed: ${String(error)}`) }))
    }
  })

  // --- UserPromptSubmit → PreStepDecision. The prompt text is the payload; no
  // matcher subject (CC ignores matchers for this event). ---
  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next): Promise<PreStepDecision> => {
    if (messages.length === 0) return next()
    const content = messages.flatMap(message => message.content)
    const merged = await runPoint('UserPromptSubmit', '', promptPayload(ctx, agent, content), { agent, turn, signal })
    if (merged.decision === 'deny') {
      return { kind: 'reject' }
    }
    // Delegate so later listeners may still rewrite or reject, then prepend our
    // context only to a downstream enter decision.
    const downstream = await next()
    const ours = contextFrom(merged)
    if (!ours || downstream.kind !== 'enter') return downstream
    return {
      kind: 'enter',
      messages: [...downstream.messages, ours],
    }
  })

  // --- PreToolUse → PreToolDecision. Matcher subject is the tool name. ---
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const turn = lastTurn(exec.agent)
    // `exec` is typed in both worlds (the in-box registry's interface merge and
    // the vendored one share the event name); at runtime the vendored registry
    // is the only `tools` service, so the value is always ours. See package README.
    const ccExec = exec as ToolExecution
    const merged = await runPoint('PreToolUse', ccExec.name, preToolPayload(ctx, ccExec), { ...exec.agent ? { agent: exec.agent } : {}, turn, signal: exec.signal })
    if (merged.decision === 'deny') return { kind: 'deny', reason: merged.reason ?? 'blocked by PreToolUse hook' }
    if (merged.decision === 'ask') return { kind: 'ask', ...merged.reason !== undefined ? { reason: merged.reason } : {} }
    return next()
  })

  // --- PostToolUse → PostToolDecision. Matcher subject is the tool name. ---
  // PostToolUseFailure rides the same seam as an observe-only emit when the
  // tool result is an error (`result.isError`), matching CC where the two are
  // mutually exclusive on a single tool call. Matcher subject is also the tool
  // name.
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const turn = lastTurn(exec.agent)
    // Same boundary cast as the PreToolUse listener above.
    const ccExec = exec as ToolExecution
    if (result.isError) {
      detached.track(runPoint('PostToolUseFailure', ccExec.name, postToolFailurePayload(ctx, ccExec, result), { ...exec.agent ? { agent: exec.agent } : {}, signal: exec.signal ?? detached.signal })
        .catch((error: unknown) => { ctx.logger.warn(`hooks-claude-code: PostToolUseFailure hook failed: ${String(error)}`) }))
    }
    const merged = await runPoint('PostToolUse', ccExec.name, postToolPayload(ctx, ccExec, result), { ...exec.agent ? { agent: exec.agent } : {}, turn, signal: exec.signal })
    const context = contextFrom(merged)
    if (merged.decision === 'deny') {
      return { kind: 'block', feedback: [{ type: 'text', text: merged.reason ?? 'blocked by PostToolUse hook' }], ...context ? { additionalContexts: [context] } : {} }
    }
    // Our hooks did not block. DELEGATE so a later listener can still block/replace,
    // then fold our context onto its decision (a downstream block carries it too).
    const downstream = await next()
    if (!context) return downstream
    if (downstream.kind === 'block') {
      return { ...downstream, additionalContexts: prependContext(context, downstream.additionalContexts) }
    }
    return {
      ...downstream,
      additionalContexts: prependContext(context, downstream.additionalContexts),
    }
  })

  // A blocking Stop hook steers at the stopping boundary, which makes the
  // machine observe pending input and run another step.
  // TODO(stop-loop-guard): cap consecutive forced continuations; hooks must self-limit meanwhile.
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }): Promise<void> => {
    const merged = await runPoint('Stop', '', stopPayload(ctx, agent), { agent, turn, signal })
    if (merged.decision === 'deny') {
      // A blocking Stop hook forces continuation.
      const text = merged.reason ?? 'continue: blocked by Stop hook'
      agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: PLUGIN_SOURCE }))
    }
  })

  // SubagentStart may inject child context; SubagentStop only observes. Both
  // use the live child's workspace and the generic agent-type matcher subject.
  ctx.on('subagent/start', (info) => {
    const child = ctx.get('agents')?.get(info.id)
    subagentIds.add(info.id)
    if (child !== undefined) subagentChildren.set(info.runId, child)
    detached.track(runPoint('SubagentStart', SUBAGENT_TYPE, subagentPayload(ctx, 'SubagentStart', info, child), { ...child ? { agent: child } : {}, signal: detached.signal })
      .then((merged) => {
        const context = contextFrom(merged)
        if (context && child) child.inject(context)
      })
      .catch((error: unknown) => { ctx.logger.warn(`hooks-claude-code: SubagentStart hook failed: ${String(error)}`) }))
  })
  ctx.on('subagent/end', (info) => {
    const child = subagentChildren.get(info.runId) ?? ctx.get('agents')?.get(info.id)
    subagentChildren.delete(info.runId)
    subagentIds.add(info.id)
    detached.track(runPoint('SubagentStop', SUBAGENT_TYPE, subagentPayload(ctx, 'SubagentStop', info, child), { ...child ? { agent: child } : {}, signal: detached.signal }))
  })

  // --- The expanded observe/interception event set (9 of Claude Code's 30). ---

  // PermissionRequest → interception on the approval waterfall. `deny` rejects the
  // request; `allow`/`approve` pre-approves it; otherwise the downstream answerer
  // chain decides (`ask`/no-decision delegate to `next()`).
  ctx.on('approval/request', async (req: ApprovalRequest, next): Promise<ApprovalOutcome> => {
    const merged = await runPoint('PermissionRequest', '', permissionRequestPayload(ctx, req), { ...req.agent ? { agent: req.agent } : {}, signal: req.signal ?? detached.signal })
    if (merged.decision === 'deny') return 'rejected'
    if (merged.decision === 'allow') return 'allowed-once'
    return next()
  })

  // The three observe events that ride the session event firehose share one
  // observer and dispatch on the recorded event type (all emit-shaped).
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type === 'approval/decided' && event.data.outcome === 'rejected') {
      detached.track(runPoint('PermissionDenied', '', permissionDeniedPayload(ctx, session), { signal: detached.signal })
        .catch((error: unknown) => { ctx.logger.warn(`hooks-claude-code: PermissionDenied hook failed: ${String(error)}`) }))
      return
    }
    if (event.type === 'approval/asked') {
      detached.track(runPoint('Notification', 'permission_prompt', notificationPayload(ctx, session, event), { signal: detached.signal })
        .catch((error: unknown) => { ctx.logger.warn(`hooks-claude-code: Notification hook failed: ${String(error)}`) }))
      return
    }
    // `compaction/end` is declared by the compaction plugin's augmentation (not the
    // core session map), so compare the type as a widened string; the payload here
    // only needs the session.
    if ((event.type as string) === 'compaction/end') {
      detached.track(runPoint('PostCompact', '', postCompactPayload(ctx, session), { signal: detached.signal })
        .catch((error: unknown) => { ctx.logger.warn(`hooks-claude-code: PostCompact hook failed: ${String(error)}`) }))
    }
  })

  // SessionEnd → a disposed session. CC's `reason` is not derivable from the
  // harness seam, so it is reported as `'other'`.
  ctx.on('session/disposed', (session: Session) => {
    detached.track(runPoint('SessionEnd', '', sessionEndPayload(ctx, session), { signal: detached.signal })
      .catch((error: unknown) => { ctx.logger.warn(`hooks-claude-code: SessionEnd hook failed: ${String(error)}`) }))
  })

  // StopFailure → an agent/error, with the error mapped onto CC's error-code
  // vocabulary where possible (default `unknown`).
  ctx.on('agent/error', ({ agent, error }) => {
    detached.track(runPoint('StopFailure', '', stopFailurePayload(ctx, agent, error), { agent, signal: detached.signal })
      .catch((failure: unknown) => { ctx.logger.warn(`hooks-claude-code: StopFailure hook failed: ${String(failure)}`) }))
  })

  // TaskCreated → bridge-side diff of the jobs registry: subscribe to changes,
  // re-read the visible snapshot, and emit once per newly-appeared job id. Reads
  // with no owner (unowned-only visible set); priming suppresses pre-existing jobs.
  const jobs = ctx.get?.('jobs')
  if (jobs) {
    const seenJobs = new Set<JobId>()
    const diffJobs = (owner: Agent | undefined): void => {
      for (const job of jobs.list(owner)) {
        if (seenJobs.has(job.id)) continue
        seenJobs.add(job.id)
        detached.track(runPoint('TaskCreated', '', taskCreatedPayload(ctx, job), { signal: detached.signal })
          .catch((error: unknown) => { ctx.logger.warn(`hooks-claude-code: TaskCreated hook failed: ${String(error)}`) }))
      }
    }
    for (const job of jobs.list(undefined)) seenJobs.add(job.id) // prime
    jobs.onJobsChanged(diffJobs)
  }

  // TeammateIdle → a subagent (non-root) transitioning to idle. `agent/status`
  // does not distinguish root from child, so only agents seen as subagents fire.
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle' && subagentIds.has(agent.id)) {
      detached.track(runPoint('TeammateIdle', '', teammateIdlePayload(ctx, agent), { agent, signal: detached.signal })
        .catch((error: unknown) => { ctx.logger.warn(`hooks-claude-code: TeammateIdle hook failed: ${String(error)}`) }))
    }
  })
}

/**
 * The `agent_type` value the bridge reports for SubagentStart/Stop. The harness
 * subagent seam carries no per-kind label, so the bridge uses Claude Code's own
 * Task-tool default — a hooks.json with a default/`*`/empty `agent_type` matcher
 * fires; a config matching a specific kind (e.g. `code-reviewer`) does not.
 */
const SUBAGENT_TYPE = 'general-purpose'

/** Everything {@link dispatchHook} needs beyond the hook itself. */
interface DispatchOptions {
  payload: unknown
  defaultTimeoutMs: number
  /** Extra env vars for a `command` hook (`CLAUDE_PROJECT_DIR`, …). */
  env?: Record<string, string>
  /** Working directory for a `command` hook. */
  cwd?: string
  /** Explicit owning-operation signal. */
  signal: AbortSignal
  /** Firing agent, required to fork a `prompt`/`agent` hook's subagent. */
  agent?: Agent
  /** Firing event used to guard per-event structured fields. */
  expectedEventName: string
  /** URL-pattern allowlist for `http` hooks (undefined = unrestricted). */
  allowedHttpHookUrls?: string[]
  /** Env-var names allowed to interpolate into `http` header values. */
  httpAllowedEnvVars: ReadonlySet<string>
  /** Whether `prompt` hooks may fork a small-model subagent. */
  enablePromptHooks: boolean
  /** Whether `agent` hooks may fork a verification subagent. */
  enableAgentHooks: boolean
}

/** A non-blocking hook error the subagent raised (StopFailure-style vocabulary). */
interface HookRunError {
  type: string
  message: string
}

/** Minimal structural subset of the `subagents` fork seam used by prompt/agent executors. */
interface HookSubagentLike {
  start(name: string, request: {
    label?: string
    prompt: readonly { type: 'text'; text: string }[]
    parent: Agent
    signal: AbortSignal
    agentOptions?: unknown
  }): Promise<{
    result: Promise<{ stopReason: string; content: readonly { type: string; text?: string }[] }>
  }>
}

/** Exact text values of `run.result.stopReason`. */
const STOP_REASON_ERROR = 'error'

/**
 * Interpolate the JSON hook input into a `prompt`/`agent` template. The CC spec
 * feeds hook input to prompt hooks as JSON; here the payload is embedded via
 * `$ARGUMENTS` when the template names it, otherwise appended after a blank line.
 */
export function interpolatePrompt(template: string, payload: unknown): string {
  const json = typeof payload === 'string' ? payload : JSON.stringify((payload ?? {}) as unknown)
  return template.includes('$ARGUMENTS')
    ? template.split('$ARGUMENTS').join(json)
    : `${template}\n\n${json}`
}

/**
 * Decode a forked subagent's result into a neutral {@link HookOutput}. Unlike
 * {@link parseHookOutput} (which consumes process stdout/stderr/exitCode), a
 * subagent has no process channels — this concatenates its text blocks, then
 * tries to parse them as a recognized HookOutput JSON object. A parse failure
 * yields an empty (non-blocking) output and warns in debug; `stopReason: 'error'`
 * surfaces as a non-blocking hook error, matching command-hook error semantics.
 * @param result - the fork's terminal result.
 * @param debug - the bridge logger's debug sink for the parse-failure warn.
 * @returns the decoded output.
 */
export function contentToHookOutput(
  result: { stopReason: string; content: readonly { type: string; text?: string }[] },
  debug: (message: string) => void,
): { output: HookOutput; error?: HookRunError } {
  const text = result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
  if (result.stopReason === STOP_REASON_ERROR) {
    return { output: emptyHookOutput(), error: { type: 'error', message: text || 'subagent hook failed' } }
  }
  const output = emptyHookOutput()
  let parsed: Record<string, unknown> | undefined
  try {
    const candidate = JSON.parse(text) as unknown
    if (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)) {
      parsed = candidate as Record<string, unknown>
    }
  } catch {
    if (text.length > 0) debug(`hooks-claude-code: prompt/agent hook produced non-JSON text (treated as empty output)`)
  }
  if (parsed !== undefined) applyContentOutput(output, parsed)
  return { output }
}

/** A neutral output for a non-process executor (no exit code or stdin/stdout). */
function emptyHookOutput(): HookOutput {
  return { exitCode: undefined, stderr: '', stdout: '' }
}

/** Fold a parsed JSON object into `output`, mirroring the codec's structured-field vocabulary. */
function applyContentOutput(output: HookOutput, parsed: Record<string, unknown>): void {
  const str = (obj: Record<string, unknown>, key: string): string | undefined => typeof obj[key] === 'string' ? obj[key] as string : undefined
  const bool = (obj: Record<string, unknown>, key: string): boolean | undefined => typeof obj[key] === 'boolean' ? obj[key] as boolean : undefined
  const obj = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined

  // Top-level legacy fields (CC only allows approve/block at top level).
  const cont = bool(parsed, 'continue')
  if (cont !== undefined) output.continue = cont
  const stopReason = str(parsed, 'stopReason')
  if (stopReason !== undefined) output.stopReason = stopReason
  const sysMsg = str(parsed, 'systemMessage')
  if (sysMsg !== undefined) output.systemMessage = sysMsg
  const topDecision = str(parsed, 'decision')
  if (topDecision === 'approve' || topDecision === 'block') output.decision = topDecision
  const topReason = str(parsed, 'reason')
  if (topReason !== undefined) output.reason = topReason

  // The per-event hookSpecificOutput channel (permissionDecision/additionalContext…).
  const hso = obj(parsed.hookSpecificOutput)
  if (hso !== undefined) {
    const eventName = str(hso, 'hookEventName')
    if (eventName !== undefined) output.hookEventName = eventName
    const permissionDecision = str(hso, 'permissionDecision')
    if (permissionDecision === 'allow' || permissionDecision === 'deny' || permissionDecision === 'ask') {
      output.decision = permissionDecision
    }
    const permissionReason = str(hso, 'permissionDecisionReason')
    if (permissionReason !== undefined) output.reason = permissionReason
    const additionalContext = str(hso, 'additionalContext')
    if (additionalContext !== undefined) output.additionalContext = additionalContext
    const updated = obj(hso.updatedInput)
    if (updated !== undefined) output.updatedInput = updated
  }
}

/**
 * Run one configured hook of any executor kind and decode its neutral outcome.
 * `command` runs through {@link runHook} (the shell executor); `http` runs
 * through {@link runHttpHook} (a POST with allowlisted header interpolation).
 * `prompt` and `agent` fork a one-shot small-model/verification subagent when
 * the corresponding enable flag is set; a configured-but-disabled hook of those
 * kinds is skipped with a warn, and without a `subagents` service or parent agent
 * they degrade to the old warned no-op.
 * @param ctx - the plug context (gateway to the `subagents` service and logging).
 * @param hook - the configured hook of any kind.
 * @param opts - payload, timeouts, env/cwd, signal, event, and the http policy.
 * @returns the decoded output plus the run's wall-clock duration.
 */
async function dispatchHook(ctx: Context, hook: HookCommand, opts: DispatchOptions): Promise<{ output: HookOutput; durationMs: number }> {
  const now = (): number => performance.now()
  const started = now()
  if (hook.type === 'http') {
    return runHttpHook(hook, {
      payload: opts.payload,
      allowedEnvVars: opts.httpAllowedEnvVars,
      ...opts.allowedHttpHookUrls !== undefined ? { allowedHttpHookUrls: opts.allowedHttpHookUrls } : {},
      defaultTimeoutMs: opts.defaultTimeoutMs,
      signal: opts.signal,
      expectedEventName: opts.expectedEventName,
      now,
    })
  }
  if (hook.type === 'prompt' || hook.type === 'agent') {
    const enabled = hook.type === 'prompt' ? opts.enablePromptHooks : opts.enableAgentHooks
    if (!enabled) {
      warnOnce(ctx, `hooks-claude-code: ${opts.expectedEventName} ${hook.type} hook is disabled (set ${hook.type === 'prompt' ? 'enablePromptHooks' : 'enableAgentHooks'} to run it)`)
      return { output: emptyHookOutput(), durationMs: now() - started }
    }
    const subagents = ctx.get?.('subagents') as HookSubagentLike | undefined
    if (!subagents || !opts.agent) {
      warnOnce(ctx, `hooks-claude-code: ${opts.expectedEventName} ${hook.type} hook cannot run (no subagents service or parent agent)`)
      return { output: emptyHookOutput(), durationMs: now() - started }
    }
    const prompt = interpolatePrompt(hook.prompt, opts.payload)
    let run
    try {
      run = await subagents.start('fork', {
        label: hook.type === 'prompt' ? 'hook-prompt' : 'hook-agent',
        signal: opts.signal,
        prompt: [{ type: 'text', text: prompt }],
        parent: opts.agent,
        ...(hook.model !== undefined ? { agentOptions: { model: hook.model } } : {}),
      })
    } catch (error: unknown) {
      ctx.logger.warn(`hooks-claude-code: ${opts.expectedEventName} ${hook.type} hook could not fork a subagent: ${String(error)}`)
      return { output: emptyHookOutput(), durationMs: now() - started }
    }
    const result = await run.result
    const decoded = contentToHookOutput(result, (m) => ctx.logger.debug(m))
    if (decoded.error !== undefined) {
      ctx.logger.warn(`hooks-claude-code: ${opts.expectedEventName} ${hook.type} hook errored: ${decoded.error.message}`)
    }
    return { output: decoded.output, durationMs: now() - started }
  }
  return runHook(ctx.shell, hook, {
    payload: opts.payload,
    defaultTimeoutMs: opts.defaultTimeoutMs,
    ...opts.env !== undefined ? { env: opts.env } : {},
    ...opts.cwd !== undefined ? { cwd: opts.cwd } : {},
    signal: opts.signal,
    trailingNewline: true,
    expectedEventName: opts.expectedEventName,
  }, now)
}

/** Warn once per skip reason so a repeated disabled hook does not spam the log. */
const warnedSkips = new Set<string>()
function warnOnce(ctx: Context, message: string): void {
  if (warnedSkips.has(message)) return
  warnedSkips.add(message)
  ctx.logger.warn(message)
}


// --- Per-event stdin payloads (the CC DIALECT shape). Field names match CC's
// hook input schema; this is the part a bridge owns. ---

/** The last open turn number in the agent's log, or 0 without an agent. */
function lastTurn(agent: Agent | undefined): number {
  if (!agent) return 0
  const last = [...agent.session.events].findLast(e => e.type === 'turn/start')
  /* v8 ignore next -- agent-present callers are tool/stop extension points inside an open turn. */
  return last?.type === 'turn/start' ? last.data.turn : 0
}

/** Flatten content blocks to the text a hook payload carries (the common case). */
function blocksToText(content: ContentBlock[]): string {
  return content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map(b => b.text).join('')
}

function base(ctx: Context, agent: Agent | undefined, event: string): Record<string, unknown> {
  return {
    session_id: agent?.session.header.id ?? '',
    transcript_path: agent === undefined
      ? ''
      : ctx.get('sessionPersistence')?.locate(agent.session.header)?.path ?? '',
    cwd: agent?.session.header.cwd ?? process.cwd(),
    hook_event_name: event,
  }
}

function sessionStartPayload(ctx: Context, agent: Agent, source: string): Record<string, unknown> {
  return { ...base(ctx, agent, 'SessionStart'), source }
}
/** SessionResume: the base session fields plus the `resume` source (CC's source enum). */
function sessionResumePayload(ctx: Context, agent: Agent, source: string): Record<string, unknown> {
  return { ...base(ctx, agent, 'SessionResume'), source }
}
function promptPayload(ctx: Context, agent: Agent, content: ContentBlock[]): Record<string, unknown> {
  return { ...base(ctx, agent, 'UserPromptSubmit'), prompt: blocksToText(content) }
}
function preToolPayload(ctx: Context, exec: ToolExecution): Record<string, unknown> {
  return { ...base(ctx, exec.agent, 'PreToolUse'), tool_name: exec.name, tool_input: exec.arguments, tool_use_id: exec.callId }
}
function postToolPayload(ctx: Context, exec: ToolExecution, result: ToolExecutionResult): Record<string, unknown> {
  return { ...base(ctx, exec.agent, 'PostToolUse'), tool_name: exec.name, tool_input: exec.arguments, tool_use_id: exec.callId, tool_response: blocksToText(result.content) }
}

/**
 * PostToolUseFailure: fired on an isError tool result. Mirror of PostToolUse
 * minus `tool_response`, carrying the error text flattened from the result
 * content (CC's `error` string). `is_interrupt` is omitted (not derivable from
 * the harness seam).
 */
function postToolFailurePayload(ctx: Context, exec: ToolExecution, result: ToolExecutionResult): Record<string, unknown> {
  return { ...base(ctx, exec.agent, 'PostToolUseFailure'), tool_name: exec.name, tool_input: exec.arguments, tool_use_id: exec.callId, error: blocksToText(result.content) }
}
function stopPayload(ctx: Context, agent: Agent): Record<string, unknown> {
  return { ...base(ctx, agent, 'Stop'), stop_hook_active: false }
}
/**
 * Build a SubagentStart/SubagentStop payload from the CC base (the child's
 * `session_id`/`cwd` when the child agent is available) plus the subagent-hook
 * fields. `agent_type` is the CC-default {@link SUBAGENT_TYPE}; `stop_hook_active`
 * is present on SubagentStop only (the loop-guard flag, always false).
 */
function subagentPayload(ctx: Context, event: 'SubagentStart' | 'SubagentStop', info: { id: string }, child: Agent | undefined): Record<string, unknown> {
  return {
    ...base(ctx, child, event),
    agent_id: info.id,
    agent_type: SUBAGENT_TYPE,
    ...event === 'SubagentStop' ? { stop_hook_active: false } : {},
  }
}

/**
 * Base payload for a hook event that has a session but no live agent handle
 * (session-event observers and `session/disposed`). Mirrors {@link base}, whose
 * `agent`-shaped fields come from the session header here.
 */
function sessionBase(ctx: Context, session: Session, event: string): Record<string, unknown> {
  return {
    session_id: session.header.id,
    transcript_path: ctx.get('sessionPersistence')?.locate(session.header)?.path ?? '',
    cwd: session.header.cwd ?? process.cwd(),
    hook_event_name: event,
  }
}

/** Setup (first-run approximation): a brand-new startup session fires with `source: 'init'`. */
function setupPayload(ctx: Context, agent: Agent): Record<string, unknown> {
  return { ...base(ctx, agent, 'Setup'), source: 'init' }
}

/** PermissionRequest: the tool the approval is about, from the tool-ext route. */
function permissionRequestPayload(ctx: Context, req: ApprovalRequest): Record<string, unknown> {
  return { ...base(ctx, req.agent, 'PermissionRequest'), tool_name: req.toolName }
}

/** PermissionDenied: the observer only records the outcome, so the reason is approximated. */
function permissionDeniedPayload(ctx: Context, session: Session): Record<string, unknown> {
  return { ...sessionBase(ctx, session, 'PermissionDenied'), permission_denial_reason: 'Permission request rejected' }
}

/** Notification (permission_prompt subtype only): the question that was asked. */
function notificationPayload(ctx: Context, session: Session, asked: SessionEvent<'approval/asked'>): Record<string, unknown> {
  return {
    ...sessionBase(ctx, session, 'Notification'),
    notification_type: 'permission_prompt',
    tool_name: asked.data.toolName,
    ...asked.data.reason !== undefined ? { permission_denial_reason: asked.data.reason } : {},
  }
}

/** PostCompact: emitted after a compaction/end session event (observe-only). */
function postCompactPayload(ctx: Context, session: Session): Record<string, unknown> {
  return { ...sessionBase(ctx, session, 'PostCompact') }
}

/** SessionEnd: CC's `reason` is not derivable from `session/disposed`, so it is `'other'`. */
function sessionEndPayload(ctx: Context, session: Session): Record<string, unknown> {
  return { ...sessionBase(ctx, session, 'SessionEnd'), reason: 'other' }
}

/** Map a harness error onto Claude Code's StopFailure error-code vocabulary (default `unknown`). */
function stopFailureErrorCode(error: unknown): string {
  const raw = error && typeof error === 'object' && 'message' in error
    ? (error as { message: unknown }).message
    : error
  const message = String(raw).toLowerCase()
  if (message.includes('rate limit')) return 'rate_limit'
  if (message.includes('authentication') || message.includes('unauthorized') || message.includes('401') || message.includes('permission')) return 'authentication_failed'
  if (message.includes('billing') || message.includes('quota') || message.includes('credit')) return 'billing_error'
  if (message.includes('invalid request') || message.includes('bad request') || message.includes('400')) return 'invalid_request'
  if (message.includes('server error') || message.includes('overloaded') || message.includes('500')) return 'server_error'
  if (message.includes('max_output_tokens') || message.includes('output token')) return 'max_output_tokens'
  return 'unknown'
}

/** StopFailure: the failing agent plus the mapped error code and text. */
function stopFailurePayload(ctx: Context, agent: Agent, error: unknown): Record<string, unknown> {
  const message = error && typeof error === 'object' && 'message' in error
    ? String((error as { message: unknown }).message)
    : String(error)
  return { ...base(ctx, agent, 'StopFailure'), error: message, error_code: stopFailureErrorCode(error) }
}

/** TaskCreated: the registry-issued id and producer label of a newly-appeared job. */
function taskCreatedPayload(ctx: Context, job: { id: JobId; label: string }): Record<string, unknown> {
  return { ...base(ctx, undefined, 'TaskCreated'), task_id: job.id, task_text: job.label }
}

/** TeammateIdle: a subagent entered idle (the bridge only fires for subagent scopes). */
function teammateIdlePayload(ctx: Context, agent: Agent): Record<string, unknown> {
  return { ...base(ctx, agent, 'TeammateIdle') }
}
