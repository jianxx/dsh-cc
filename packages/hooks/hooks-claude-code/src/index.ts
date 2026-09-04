/**
 * Bridge for unmodified Claude Code command hooks on harness interception
 * extension points. It supports SessionStart, prompt/tool pre/post, Stop, subagent
 * start/stop, and a set of lifecycle/observe events (PermissionRequest,
 * PermissionDenied, Notification (permission_prompt), PostCompact, SessionEnd,
 * StopFailure, TaskCreated, TeammateIdle, and a first-run Setup approximation).
 * It owns Claude payloads, environment, substitution, and decision
 * mapping; shared execution and parsing live in `dsh-hook-protocol`.
 * Payload construction, hook dispatch/decoding, and the hook runner live in the
 * payloads / dispatch / hook-output / run-point modules; turn-safety state and
 * shaping live in the turn-safety module.
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
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
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
  hookDiagnosticsWriter,
} from '@jianxx/dsh-cc-hook-protocol'
import { parseClaudeCodeConfig, type ClaudeCodeHookConfig } from './config.ts'
import { failedStatus, loadedStatus } from './status.ts'

export type { HookBridgeStatus } from './status.ts'
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
import { createTurnSafety, lastTurn } from './turn-safety.ts'

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

/** The summary cap bounds a persisted event field — a positive integer or the slice misbehaves silently. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`hooks-claude-code: ${name} must be a positive integer`)
  }
}

/**
 * Read a dsh-home path without throwing when the boot-provided `dshHomePath`
 * resolver is absent — cordis throws on the property access itself (not a
 * plain `undefined`), so every read must be guarded.
 */
function dshHomeFile(ctx: Context, ...segments: string[]): string | undefined {
  try {
    return ctx.dshHomePath?.(...segments)
  } catch {
    return undefined
  }
}

export function apply(ctx: Context, config: Config): void {
  // Resolve the hook config path: an explicit config value wins, otherwise
  // default to $DSH_HOME/hooks.json via ctx.dshHomePath. With neither available
  // (e.g. an app-boot that does not provide dshHomePath), register nothing and
  // log, rather than relying on a read error below to degrade silently.
  const configPath = config.configPath || dshHomeFile(ctx, 'hooks.json')
  if (!configPath) {
    ctx.logger.info('no hooks config path; hooks disabled')
    // Instance-scoped status for /doctor: no module-level singleton.
    ctx.provide('hookBridgeStatus', failedStatus('', 'no hooks config path', config))
    return
  }
  // Validate before config parsing so a bad value cannot be hidden by its early return.
  const stderrSummaryMaxChars = config.stderrSummaryMaxChars ?? DEFAULT_STDERR_SUMMARY_MAX_CHARS
  assertPositiveInteger('stderrSummaryMaxChars', stderrSummaryMaxChars)
  const defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
  // Parse once at load. A read or parse failure logs and registers nothing.
  // F5: hook issues (config warnings among them) append to the dsh-home
  // diagnostics JSONL; without a dshHomePath the writer is a no-op.
  const diagnosticsPath = dshHomeFile(ctx, 'hooks', 'diagnostics.jsonl')
  const recordIssue = diagnosticsPath !== undefined ? hookDiagnosticsWriter(diagnosticsPath) : undefined
  let parsed: ClaudeCodeHookConfig = {}
  try {
    const raw: unknown = JSON.parse(readFileSync(configPath, 'utf8'))
    const result = parseClaudeCodeConfig(raw, {
      ...config.pluginRoot !== undefined ? { pluginRoot: config.pluginRoot } : {},
      ...config.projectDir !== undefined ? { projectDir: config.projectDir } : {},
    })
    parsed = result.config
    for (const s of result.skipped) {
      ctx.logger.warn(`hooks-claude-code: skipping "${s.type}" hook on ${s.event} (${s.reason})`)
    }
    // F6: every parse warning is logged AND recorded as a `config` diagnostic.
    for (const w of result.warnings) {
      const detail = `unsupported ${w.hookType} on ${w.event}${w.matcher !== undefined ? ` (matcher "${w.matcher}")` : ''}: ${w.keys.length > 0 ? w.keys.join(', ') : 'unknown event key'}`
      ctx.logger.warn(`hooks-claude-code: ${detail}`)
      recordIssue?.({ ts: new Date().toISOString(), dialect: 'claude-code', point: w.event, kind: 'config', detail })
    }
    ctx.provide('hookBridgeStatus', loadedStatus(configPath, parsed, result.skipped, config))
  } catch (error: unknown) {
    ctx.logger.warn(`hooks-claude-code: could not load hook config "${configPath}": ${String(error)} — no hooks registered`)
    ctx.provide('hookBridgeStatus', failedStatus(configPath, String(error), config))
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
  const runPoint = createRunPoint({ ctx, parsed, config, defaultTimeoutMs, stderrSummaryMaxChars, httpAllowedEnvVars, ...recordIssue !== undefined ? { recordIssue } : {} })

  // F1/F2/F3 turn-safety cluster (stop-block counters, cap override, halt and
  // notice shaping), built once like the run point.
  const turnSafety = createTurnSafety({ ctx, ...recordIssue !== undefined ? { recordIssue } : {} })

  // SessionStart injects context when its detached hook resolves; a slow hook
  // may miss the first request.
  // TODO(session-start-gating): add a startup gate before promising first-turn delivery.
  ctx.on('agent/session-start', ({ agent, source }) => {
    detached.track(runPoint('SessionStart', source, sessionStartPayload(ctx, agent, source), { agent, signal: detached.signal })
      .then((merged) => {
        turnSafety.detachedOutcome('SessionStart', merged, agent)
        const context = turnSafety.contextFrom(merged)
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
        .then((merged) => { turnSafety.detachedOutcome('Setup', merged, agent) })
        .catch((error: unknown) => { ctx.logger.warn(`hooks-claude-code: Setup hook failed: ${String(error)}`) }))
    }
    // SessionResume: a session resuming prior history. Only the `resume` source
    // fires it — dsh has no emit point for `clear`/`compact`, so those stay
    // unimplemented (see docs).
    if (source === 'resume') {
      detached.track(runPoint('SessionResume', '', sessionResumePayload(ctx, agent, source), { agent, signal: detached.signal })
        .then((merged) => { turnSafety.detachedOutcome('SessionResume', merged, agent) })
        .catch((error: unknown) => { ctx.logger.warn(`hooks-claude-code: SessionResume hook failed: ${String(error)}`) }))
    }
  })

  // --- UserPromptSubmit → PreStepDecision. The prompt text is the payload; no
  // matcher subject (CC ignores matchers for this event). ---
  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next): Promise<PreStepDecision> => {
    if (messages.length === 0) return next()
    // F1: a REAL user turn breaks the stop-block chain (plugin-source steering
    // and notices must not reset it — they all use `{kind:'plugin'}` sources).
    if (messages.some(message => message.source.kind === 'user')) turnSafety.resetBlocks(agent.id)
    const content = messages.flatMap(message => message.content)
    const merged = await runPoint('UserPromptSubmit', '', promptPayload(ctx, agent, content), { agent, turn, signal })
    const halted = turnSafety.applyHalt('UserPromptSubmit', merged, agent)
    turnSafety.surfaceNotices('UserPromptSubmit', merged, agent)
    if (halted || merged.decision === 'deny') {
      return { kind: 'reject' }
    }
    // Delegate so later listeners may still rewrite or reject, then prepend our
    // context only to a downstream enter decision.
    const downstream = await next()
    const ours = turnSafety.contextFrom(merged)
    if (!ours || downstream.kind !== 'enter') return downstream
    return {
      kind: 'enter',
      messages: [...downstream.messages, ours],
    }
  })

  // --- PreToolUse → PreToolDecision. Matcher subject is the tool name. ---
  // Registered with `{ prepend: true }` (F4, session-cwd precedent) so the hook
  // decision is consulted ahead of permission-rules regardless of compose order.
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const turn = lastTurn(exec.agent)
    // `exec` is typed in both worlds (the in-box registry's interface merge and
    // the vendored one share the event name); at runtime the vendored registry
    // is the only `tools` service, so the value is always ours. See package README.
    const ccExec = exec as ToolExecution
    const merged = await runPoint('PreToolUse', ccExec.name, preToolPayload(ctx, ccExec), { ...exec.agent ? { agent: exec.agent } : {}, turn, signal: exec.signal })
    const halted = turnSafety.applyHalt('PreToolUse', merged, exec.agent)
    turnSafety.surfaceNotices('PreToolUse', merged, exec.agent)
    if (halted) return { kind: 'deny', reason: merged.stopReason ?? 'halted by PreToolUse hook' }
    if (merged.decision === 'deny') return { kind: 'deny', reason: merged.reason ?? 'blocked by PreToolUse hook' }
    // S1: a non-deny `additionalContext` is injected for the next model request
    // (documented ordering divergence: CC attaches it to the tool call itself;
    // here it lands in the loop's post-result FIFO).
    const context = turnSafety.contextFrom(merged)
    if (context && exec.agent) exec.agent.inject(context)
    // F4: delegate FIRST so a downstream boundary deny still beats a hook
    // ask/allow (stricter than the hook); only then apply the hook decision —
    // `allow` suppresses the permission prompt entirely.
    const downstream = await next()
    if (downstream.kind === 'deny') return downstream
    if (merged.decision === 'ask') return { kind: 'ask', ...merged.reason !== undefined ? { reason: merged.reason } : {} }
    if (merged.decision === 'allow') return { kind: 'allow' }
    return downstream
  }, { prepend: true })

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
        .then((merged) => { turnSafety.detachedOutcome('PostToolUseFailure', merged, exec.agent) })
        .catch((error: unknown) => { ctx.logger.warn(`hooks-claude-code: PostToolUseFailure hook failed: ${String(error)}`) }))
    }
    const merged = await runPoint('PostToolUse', ccExec.name, postToolPayload(ctx, ccExec, result), { ...exec.agent ? { agent: exec.agent } : {}, turn, signal: exec.signal })
    const halted = turnSafety.applyHalt('PostToolUse', merged, exec.agent)
    turnSafety.surfaceNotices('PostToolUse', merged, exec.agent)
    if (halted) {
      return { kind: 'block', feedback: [{ type: 'text', text: merged.stopReason ?? 'halted by PostToolUse hook' }] }
    }
    const context = turnSafety.contextFrom(merged)
    if (merged.decision === 'deny') {
      return { kind: 'block', feedback: [{ type: 'text', text: merged.reason ?? 'blocked by PostToolUse hook' }], ...context ? { additionalContexts: [context] } : {} }
    }
    // Our hooks did not block. DELEGATE so a later listener can still block/replace,
    // then fold our context onto its decision (a downstream block carries it too).
    const downstream = await next()
    // S2: a hook tool-RESULT replacement applies only when the downstream fold
    // is a PLAIN accept with no content/value of its own — a downstream block
    // beats replacement (downstream/boundaries win). The MCP variant applies
    // only to `mcp__*` tools; the mismatched field is ignored (debug log).
    let replacement: { type: 'text'; text: string } | undefined
    if (downstream.kind === 'accept' && downstream.content === undefined && downstream.value === undefined) {
      const isMcp = ccExec.name.startsWith('mcp__')
      const raw = isMcp ? merged.updatedMCPToolOutput : merged.updatedToolOutput
      const ignored = isMcp ? merged.updatedToolOutput : merged.updatedMCPToolOutput
      if (ignored !== undefined) {
        ctx.logger.debug(`hooks-claude-code: PostToolUse hook sent the ${isMcp ? 'updatedToolOutput' : 'updatedMCPToolOutput'} field for ${isMcp ? '' : 'non-'}MCP tool ${ccExec.name} — ignored`)
      }
      if (raw !== undefined) {
        replacement = { type: 'text', text: typeof raw === 'string' ? raw : JSON.stringify(raw) }
      }
    }
    if (!context && replacement === undefined) return downstream
    if (downstream.kind === 'block') {
      // A downstream block beats replacement; it carries the context when present.
      return context === undefined
        ? downstream
        : { ...downstream, additionalContexts: turnSafety.prependContext(context, downstream.additionalContexts) }
    }
    if (replacement !== undefined) {
      return {
        kind: 'accept',
        content: [replacement],
        ...context ? { additionalContexts: turnSafety.prependContext(context, downstream.additionalContexts) } : {},
      }
    }
    if (context === undefined) return downstream
    return {
      ...downstream,
      additionalContexts: turnSafety.prependContext(context, downstream.additionalContexts),
    }
  })

  // A blocking Stop hook steers at the stopping boundary, which makes the
  // machine observe pending input and run another step. F1 caps the loop: the
  // payload's `stop_hook_active` is computed BEFORE incrementing (block #1
  // observes false), and after `cap` consecutive blocks the hook is overridden.
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }): Promise<void> => {
    const merged = await runPoint('Stop', '', stopPayload(ctx, agent, turnSafety.hasBlocks(agent.id)), { agent, turn, signal })
    if (turnSafety.applyHalt('Stop', merged, agent)) {
      turnSafety.surfaceNotices('Stop', merged, agent)
      return
    }
    if (merged.decision === 'deny') {
      turnSafety.onStopDeny(agent, merged)
    }
    turnSafety.surfaceNotices('Stop', merged, agent)
  })

  // SubagentStart may inject child context; SubagentStop only observes. Both
  // use the live child's workspace and the generic agent-type matcher subject.
  ctx.on('subagent/start', (info) => {
    const child = ctx.get('agents')?.get(info.id)
    subagentIds.add(info.id)
    if (child !== undefined) subagentChildren.set(info.runId, child)
    detached.track(runPoint('SubagentStart', SUBAGENT_TYPE, subagentPayload(ctx, 'SubagentStart', info, child), { ...child ? { agent: child } : {}, signal: detached.signal })
      .then((merged) => {
        turnSafety.detachedOutcome('SubagentStart', merged, child)
        const context = turnSafety.contextFrom(merged)
        if (context && child) child.inject(context)
      })
      .catch((error: unknown) => { ctx.logger.warn(`hooks-claude-code: SubagentStart hook failed: ${String(error)}`) }))
  })
  ctx.on('subagent/end', (info) => {
    const child = subagentChildren.get(info.runId) ?? ctx.get('agents')?.get(info.id)
    subagentChildren.delete(info.runId)
    subagentIds.add(info.id)
    detached.track(runPoint('SubagentStop', SUBAGENT_TYPE, subagentPayload(ctx, 'SubagentStop', info, child), { ...child ? { agent: child } : {}, signal: detached.signal })
      .then((merged) => { turnSafety.detachedOutcome('SubagentStop', merged, child) }))
  })

  // --- The expanded observe/interception event set (see README for the full
  // supported/unsupported enumeration against Claude Code's hook events). ---

  // PermissionRequest → interception on the approval waterfall. `deny` rejects the
  // request; `allow`/`approve` pre-approves it; otherwise the downstream answerer
  // chain decides (`ask`/no-decision delegate to `next()`). F2: a `continue:false`
  // hook rejects and cancels.
  ctx.on('approval/request', async (req: ApprovalRequest, next): Promise<ApprovalOutcome> => {
    const merged = await runPoint('PermissionRequest', '', permissionRequestPayload(ctx, req), { ...req.agent ? { agent: req.agent } : {}, signal: req.signal ?? detached.signal })
    const halted = turnSafety.applyHalt('PermissionRequest', merged, req.agent)
    turnSafety.surfaceNotices('PermissionRequest', merged, req.agent)
    if (halted || merged.decision === 'deny') return 'rejected'
    if (merged.decision === 'allow') return 'allowed-once'
    return next()
  })

  // The three observe events that ride the session event firehose share one
  // observer and dispatch on the recorded event type (all emit-shaped).
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type === 'approval/decided' && event.data.outcome === 'rejected') {
      detached.track(runPoint('PermissionDenied', '', permissionDeniedPayload(ctx, session), { signal: detached.signal })
        .then((merged) => { turnSafety.detachedOutcome('PermissionDenied', merged) })
        .catch((error: unknown) => { ctx.logger.warn(`hooks-claude-code: PermissionDenied hook failed: ${String(error)}`) }))
      return
    }
    if (event.type === 'approval/asked') {
      detached.track(runPoint('Notification', 'permission_prompt', notificationPayload(ctx, session, event), { signal: detached.signal })
        .then((merged) => { turnSafety.detachedOutcome('Notification', merged) })
        .catch((error: unknown) => { ctx.logger.warn(`hooks-claude-code: Notification hook failed: ${String(error)}`) }))
      return
    }
    // `compaction/end` is declared by the compaction plugin's augmentation (not the
    // core session map), so compare the type as a widened string; the payload here
    // only needs the session.
    if ((event.type as string) === 'compaction/end') {
      detached.track(runPoint('PostCompact', '', postCompactPayload(ctx, session), { signal: detached.signal })
        .then((merged) => { turnSafety.detachedOutcome('PostCompact', merged) })
        .catch((error: unknown) => { ctx.logger.warn(`hooks-claude-code: PostCompact hook failed: ${String(error)}`) }))
    }
  })

  // SessionEnd → a disposed session. CC's `reason` is not derivable from the
  // harness seam, so it is reported as `'other'`. F1 cleanup: every stop-block
  // counter and session pairing recorded for THIS session is freed (the maps
  // are keyed by agent.id, paired to its session id at first block).
  ctx.on('session/disposed', (session: Session) => {
    turnSafety.releaseSession(session.header.id)
    detached.track(runPoint('SessionEnd', '', sessionEndPayload(ctx, session), { signal: detached.signal })
      .then((merged) => { turnSafety.detachedOutcome('SessionEnd', merged) })
      .catch((error: unknown) => { ctx.logger.warn(`hooks-claude-code: SessionEnd hook failed: ${String(error)}`) }))
  })

  // StopFailure → an agent/error, with the error mapped onto CC's error-code
  // vocabulary where possible (default `unknown`).
  ctx.on('agent/error', ({ agent, error }) => {
    detached.track(runPoint('StopFailure', '', stopFailurePayload(ctx, agent, error), { agent, signal: detached.signal })
      .then((merged) => { turnSafety.detachedOutcome('StopFailure', merged, agent) })
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
          .then((merged) => { turnSafety.detachedOutcome('TaskCreated', merged) })
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
        .then((merged) => { turnSafety.detachedOutcome('TeammateIdle', merged, agent) })
        .catch((error: unknown) => { ctx.logger.warn(`hooks-claude-code: TeammateIdle hook failed: ${String(error)}`) }))
    }
  })
}

// Public surface preserved from the pre-split monolith: prompt interpolation and
// subagent-result decoding stay importable from the package root.
export { contentToHookOutput, interpolatePrompt } from './hook-output.ts'
