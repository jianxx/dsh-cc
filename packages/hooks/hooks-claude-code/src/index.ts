/**
 * Bridge for unmodified Claude Code command hooks on harness interception
 * extension points. It supports SessionStart, prompt/tool pre/post, Stop, subagent
 * start/stop, and a set of lifecycle/observe events (PermissionRequest,
 * PermissionDenied, Notification (permission_prompt), PostCompact, SessionEnd,
 * StopFailure, TaskCreated, TeammateIdle, and a first-run Setup approximation).
 * It owns Claude payloads, environment, substitution, and decision
 * mapping; shared execution and parsing live in `dsh-hook-protocol`.
 * Payload construction, hook dispatch/decoding, and the hook runner live in the
 * payloads / dispatch / hook-output / run-point modules.
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
// Type-seam imports: also pull in the declaration-merged `events` interfaces so the
// `approval/*` (user-approval) and `jobs` (dsh-jobs) events below typecheck.
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { JobId } from '@deepseek-ai/dsh-jobs'
// Pulls in the declaration-merged subagent events and the identity pairing their
// start/end edges.
import type { SubagentRunId } from '@deepseek-ai/dsh-subagent'
import type { PostToolDecision, PreToolDecision, ToolExecution } from '@jianxx/dsh-cc-tools'
import {
  createDetachedRuns,
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_STDERR_SUMMARY_MAX_CHARS,
  type MergedHookOutcome,
} from '@jianxx/dsh-cc-hook-protocol'
import { parseClaudeCodeConfig, type ClaudeCodeHookConfig } from './config.ts'
import {
  notificationPayload,
  permissionDeniedPayload,
  permissionRequestPayload,
  postCompactPayload,
  postToolFailurePayload,
  postToolPayload,
  preToolPayload,
  promptPayload,
  sessionEndPayload,
  sessionResumePayload,
  sessionStartPayload,
  setupPayload,
  stopFailurePayload,
  stopPayload,
  subagentPayload,
  SUBAGENT_TYPE,
  taskCreatedPayload,
  teammateIdlePayload,
} from './payloads.ts'
import { createRunPoint } from './run-point.ts'

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

  // The http-hook header interpolation policy: the effective allowlist is the
  // configured names resolved once (a deployment's fixed allowlist, not a
  // per-run knob).
  const httpAllowedEnvVars = (): ReadonlySet<string> => new Set(config.httpAllowedEnvVars ?? [])
  const runPoint = createRunPoint({ ctx, parsed, config, defaultTimeoutMs, stderrSummaryMaxChars, httpAllowedEnvVars })

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

/** The last open turn number in the agent's log, or 0 without an agent. */
function lastTurn(agent: Agent | undefined): number {
  if (!agent) return 0
  const last = [...agent.session.events].findLast(e => e.type === 'turn/start')
  /* v8 ignore next -- agent-present callers are tool/stop extension points inside an open turn. */
  return last?.type === 'turn/start' ? last.data.turn : 0
}

// Public surface preserved from the pre-split monolith: prompt interpolation and
// subagent-result decoding stay importable from the package root.
export { contentToHookOutput, interpolatePrompt } from './hook-output.ts'
