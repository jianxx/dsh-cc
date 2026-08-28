/**
 * In-process protocol driver: session/event → UI store, followup/steer/cancel
 * back into the agent. Only this directory imports `@deepseek-ai/*`.
 * @module @jianxx/dsh-cc-tui/harness/driver
 */

import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentHandle, type AgentSetup, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import {
  UserQuestionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import { foldPlanMode } from '@deepseek-ai/dsh-plan-mode'
import { PERMISSION_SETTINGS_NAMESPACE, foldPermissionMode } from '@jianxx/dsh-cc-permission-rules'
import { ruleString } from '@jianxx/dsh-cc-permission-rules/src/parser.ts'
import { PERMISSION_COMMAND_MODES } from '@jianxx/dsh-cc-command-permissions'
import { composePreset } from './preset.ts'
import type { Driver } from '../state/driver-types.ts'
export type { Driver } from '../state/driver-types.ts'
import { nextPermissionMode, type PermissionCommandMode } from '../mode-cycle.ts'
import { parseSlash, LOCAL_COMMANDS } from '../slash.ts'
import { formatModelCatalog, parseModelChoice, type CatalogEntry } from '../model-catalog.ts'
import { writeResumeTarget } from '../resume-target.ts'
import { loadHistory, saveHistory } from '../history.ts'
import { formatStatusLine, shortenSession } from '../statusline.ts'
import {
  applySessionEvent,
  type SessionEventLike,
  type ToolPresenters,
} from '../transcript.ts'
import type { ToolCallView, ToolResultView } from '../tool-card.ts'
import type { ApprovalAnswerKind } from '../state/driver-types.ts'
import {
  backspaceQuestionText,
  clearQueue,
  clearRows,
  closeTodoPanel,
  createInitialState,
  enqueue,
  markExitAttempt,
  moveModelPickerFocus,
  moveQuestionFocus,
  moveSessionSwitcherFocus,
  moveTodoPanelFocus,
  openTodoPanel,
  popQueued,
  setApproval,
  setBusy,
  setDraft,
  setHud,
  setModelPicker,
  setNotice,
  setPermissionMode,
  setQuestion,
  setSessionSwitcher,
  setTodos,
  toggleQuestionOption,
  toggleGlobalCollapse,
  toggleThinking,
  typeQuestionText,
  upsertRow,
  upsertSubagent,
  type ApprovalPreview,
  type ApprovalView,
  type CatalogEntryView,
  type HudView,
  type QuestionView,
  type SessionEntryView,
  type SubagentRunView,
  type TodoItemView,
  type TuiState,
} from '../store.ts'

export interface DriverConfig {
  cwd?: string
  agentPreset?: string
  sessionId?: string
  provider?: string
  model?: string
  /** Directory for the persisted history file (defaults to `$DSH_HOME/tui`). */
  historyDir?: string
  /**
   * Git-branch probe used by the statusline (best-effort, never throws).
   * Injectable so tests avoid a real child process; defaults to
   * {@link gitBranchOf}.
   */
  branchProbe?: (cwd: string) => Promise<string | undefined>
}

type PermissionRulesLike = {
  readonly ruleSet: {
    readonly allow: readonly unknown[]
    readonly deny: readonly unknown[]
    readonly ask: readonly unknown[]
    readonly bypassImmune: readonly unknown[]
  }
  setMode(agent: Agent, mode: string): void
}

type PlanModeLike = {
  set(agent: Agent, active: boolean): unknown
}

type CommandsLike = {
  list(agent: Agent): readonly {
    name: string
    description?: string
    input?: { hint?: string }
  }[]
  execute(
    agent: Agent,
    line: string,
    images: readonly unknown[],
    signal: AbortSignal,
  ): Promise<{ result?: { kind: string; text?: string } } | undefined>
}

type LlmLike = {
  listProviders(): { id: string }[]
  listModels(provider: string): Promise<{ provider: string; id: string; name: string }[]>
}

type PersistenceLike = {
  list(signal?: AbortSignal): Promise<{ id: string; cwd?: string; createdAt: number }[]>
}

type ToolsLike = {
  get(name: string, scope?: unknown): {
    presentCall?(args: unknown): ToolCallView | undefined
    presentResult?(args: unknown, result: { content: unknown; isError: boolean; meta?: unknown }): ToolResultView | undefined
  } | undefined
}

/**
 * Structural stand-in for the deployment's `agentDefaultModel` service
 * (settings.yaml's `agent-default-model`), which the headless bundle seeds
 * agents from. `currentSelection()` returns the resolved default or undefined
 * when no default is configured. `reasoningEffort` is intentionally ignored on
 * the read path: undefined means the provider's default effort applies, which
 * is the correct behavior for the TUI's seed.
 */
type AgentDefaultModelLike = {
  currentSelection(): { provider: string; model: string; reasoningEffort?: string } | undefined
}

/**
 * `subagent/start` snapshot. The real `SubagentRunInfo` is declared in
 * @deepseek-ai/subagent (via cordis module augmentation), which the tui
 * package doesn't import — so a structural local type stands in. Fields are
 * `unknown` because the driver stringifies them into the view layer.
 */
type SubagentRunInfoLike = {
  runId: unknown
  provider: unknown
  id: unknown
  local: boolean
}

/**
 * `subagent/end` snapshot. `stopReason` and `lastAssistantMessage` are
 * optional on the payload; only `stopReason` is surfaced to the view.
 */
type SubagentRunEndInfoLike = {
  runId: unknown
  provider: unknown
  id: unknown
  local: boolean
  stopReason?: unknown
  lastAssistantMessage?: unknown
}

/**
 * Structural stand-in for the sessionProjections registry
 * (@deepseek-ai/dsh-session-projection via token-meter's augmentation),
 * which the tui package doesn't import — same pattern as the other `*Like`
 * seams. `onChanged` fires once per client-visible unit whose state changed;
 * `stateOf` is the live read (undefined when the key is not registered).
 */
type SessionProjectionsLike = {
  onChanged(listener: (session: { id: unknown }, key: string, value: unknown, seq: number) => void): () => void
  stateOf(session: unknown, key: string): unknown
}

/**
 * `tokenUsage` projection state. `uncachedInputTokens` is the harness's
 * field name; `inputTokens` is accepted defensively so a shape drift
 * degrades to "no tokens" instead of NaN. Cache fields are optional —
 * compositions without prompt caching simply omit those lines.
 */
type TokenUsageStateLike = {
  totals?: {
    uncachedInputTokens?: number
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
}

/** Normalized token totals shared by the HUD and `/cost`. */
export interface TokenUsageTotals {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

/** `contextPressure` projection state (subset the HUD reads). */
type ContextPressureStateLike = {
  contextWindow?: number
  pressureTokens?: number
  surfaceTokens?: number
  sampledSurfaceTokens?: number
}

const execFileAsync = promisify(execFile)

/** Default lifetime of a transient `showNotice` hint. */
const NOTICE_TTL_MS = 3000

/**
 * Best-effort git branch probe: `git -C <cwd> rev-parse --abbrev-ref HEAD`
 * with a short timeout. Never throws — errors (no git, no repo, detached
 * head) resolve to undefined and the statusline simply omits the segment.
 */
export async function gitBranchOf(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      timeout: 2000,
    })
    const branch = stdout.trim()
    return branch.length > 0 ? branch : undefined
  } catch {
    return undefined
  }
}

/** Pull cumulative token totals out of a `tokenUsage` state value. */
function totalsOf(usage: TokenUsageStateLike | undefined): TokenUsageTotals | undefined {
  const totals = usage?.totals
  const input = totals?.uncachedInputTokens ?? totals?.inputTokens
  if (typeof input !== 'number' || typeof totals?.outputTokens !== 'number') return undefined
  return {
    input,
    output: totals.outputTokens,
    ...typeof totals.cacheReadTokens === 'number' ? { cacheRead: totals.cacheReadTokens } : {},
    ...typeof totals.cacheWriteTokens === 'number' ? { cacheWrite: totals.cacheWriteTokens } : {},
  }
}

/** HUD-shaped subset of {@link totalsOf} (input/output only). */
function tokensOf(usage: TokenUsageStateLike | undefined): { input: number; output: number } | undefined {
  const totals = totalsOf(usage)
  return totals === undefined ? undefined : { input: totals.input, output: totals.output }
}

/**
 * `/cost` report: token counts with thousands separators, cache lines only
 * when non-zero, and an explicit note that no price table is configured —
 * the harness reports usage only, so no monetary amounts are claimed.
 */
export function formatCostReport(totals: TokenUsageTotals | undefined): string {
  if (totals === undefined) return 'No token usage recorded yet.'
  const row = (label: string, value: number): string =>
    `  ${label.padEnd(9)}${value.toLocaleString('en-US').padStart(6)}`
  const lines = [
    'Token usage this session:',
    row('input', totals.input),
    row('output', totals.output),
  ]
  if ((totals.cacheRead ?? 0) > 0) lines.push(row('cache r', totals.cacheRead!))
  if ((totals.cacheWrite ?? 0) > 0) lines.push(row('cache w', totals.cacheWrite!))
  lines.push('  Pricing is not configured — costs are not computed.')
  return lines.join('\n')
}

/**
 * Map a `todos` projection value (`TodoItem[] | null`) onto view items.
 * Non-arrays (including the pre-first-write `null`) map to undefined (no
 * strip); malformed entries inside an array are dropped defensively so one
 * bad item degrades to a shorter list instead of a crash.
 */
function todosOf(value: unknown): readonly TodoItemView[] | undefined {
  if (!Array.isArray(value)) return undefined
  const views: TodoItemView[] = []
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue
    const content = (item as { content?: unknown }).content
    const status = (item as { status?: unknown }).status
    if (typeof content !== 'string') continue
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') continue
    views.push({ content, status })
  }
  return views
}

/** Structural equality for two optional todo lists. */
function sameTodos(
  a: readonly TodoItemView[] | undefined,
  b: readonly TodoItemView[] | undefined,
): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined || a.length !== b.length) return false
  return a.every((item, i) => item.content === b[i]!.content && item.status === b[i]!.status)
}

/**
 * Raw context-window occupancy behind {@link percentOf}: the latest sample
 * plus the surface's movement since that sample was taken (the projection's
 * anchor adjustment), falling back to the bare sample when no anchor exists.
 * `window` is undefined — the result still being usable for exact-token
 * display — when the projection does not expose a positive window. Callers
 * must render from these raw counts, never back-derive them from the rounded
 * percent.
 */
function occupancyOf(pressure: ContextPressureStateLike | undefined): { used: number; window?: number } | undefined {
  const sample = pressure?.pressureTokens
  if (typeof sample !== 'number') return undefined
  const { surfaceTokens, sampledSurfaceTokens } = pressure ?? {}
  const used = typeof surfaceTokens === 'number' && typeof sampledSurfaceTokens === 'number'
    ? Math.max(0, sample + surfaceTokens - sampledSurfaceTokens)
    : sample
  const contextWindow = pressure?.contextWindow
  const window = typeof contextWindow === 'number' && contextWindow > 0 ? contextWindow : undefined
  // exactOptionalPropertyTypes: `window` must be absent, not explicitly undefined.
  return window === undefined ? { used } : { used, window }
}

/**
 * Context-occupancy percent (0-100 int) from a `contextPressure` state
 * value. Undefined until both numerator and denominator are known.
 */
function percentOf(pressure: ContextPressureStateLike | undefined): number | undefined {
  const occupancy = occupancyOf(pressure)
  if (occupancy === undefined || occupancy.window === undefined) return undefined
  return Math.max(0, Math.min(100, Math.round((occupancy.used / occupancy.window) * 100)))
}

function liveMode(agent: Agent, fallback: string): string {
  if (foldPlanMode(agent.session.events)) return 'plan'
  return foldPermissionMode(agent.session.events) ?? fallback
}

/**
 * Character cap for the pretty-printed raw-arguments preview of an approval
 * prompt (non-shell, non-file-edit tools).
 */
const ARGS_PREVIEW_MAX_CHARS = 500

/**
 * The restored arguments of an approved call: a parsed JSON object, or the
 * raw stored text when the arguments are not a JSON object (malformed JSON,
 * a bare scalar) so the preview degrades to the literal payload instead of
 * nothing.
 */
type RestoredArgs = { args: Record<string, unknown> } | { raw: string }

/**
 * Restore the approved call's arguments by scanning the session log backwards
 * for the `tool/call` event carrying the request's callId (`appendToolCall`
 * lands before the pre-execute approval, so the event is always present).
 * Returns undefined when the callId is missing, unpaired, or its arguments
 * are not stored as a string.
 */
function argsOf(req: ApprovalRequest): RestoredArgs | undefined {
  if (req.callId === undefined) return undefined
  const events = req.agent.session.events
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!
    if (event.type !== 'tool/call') continue
    if (String((event.data as { callId?: unknown }).callId) !== String(req.callId)) continue
    const raw = (event.data as { arguments?: unknown }).arguments
    if (typeof raw !== 'string') return undefined
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { args: parsed as Record<string, unknown> }
      }
    } catch {
      // Not JSON — fall through to the raw-text preview.
    }
    return { raw }
  }
  return undefined
}

/**
 * Build the approval prompt's structured payload preview from the restored
 * call arguments: shell-style `command` arguments map to the command kind;
 * Edit/MultiEdit/Write arguments map to per-file diffs (rendered with the
 * transcript's multi-hunk diff renderer); anything else pretty-prints the raw
 * arguments, and a failed recovery degrades to tool name + reason only.
 */
export function payloadOf(req: ApprovalRequest): ApprovalPreview {
  const restored = argsOf(req)
  if (restored === undefined) return { kind: 'none' }
  if ('raw' in restored) {
    return { kind: 'args', json: restored.raw.slice(0, ARGS_PREVIEW_MAX_CHARS) }
  }
  const args = restored.args
  if (typeof args.command === 'string') {
    return { kind: 'command', command: args.command }
  }
  const diffs = diffsOf(req.toolName.toLowerCase(), args)
  if (diffs !== undefined) return { kind: 'diff', diffs }
  return { kind: 'args', json: JSON.stringify(args, null, 2).slice(0, ARGS_PREVIEW_MAX_CHARS) }
}

/**
 * Extract per-file diffs from file-edit tool arguments, or undefined when the
 * arguments do not carry the expected shape (the preview then degrades to the
 * raw-arguments kind).
 */
function diffsOf(name: string, args: Record<string, unknown>): readonly { path: string; oldText: string | null; newText: string }[] | undefined {
  const path = typeof args.file_path === 'string' ? args.file_path : undefined
  if (name === 'write') {
    if (path === undefined || typeof args.content !== 'string') return undefined
    return [{ path, oldText: null, newText: args.content }]
  }
  if (name === 'edit') {
    if (path === undefined || typeof args.old_string !== 'string' || typeof args.new_string !== 'string') return undefined
    return [{ path, oldText: args.old_string, newText: args.new_string }]
  }
  if (name === 'multiedit' || name === 'multi_edit') {
    if (path === undefined || !Array.isArray(args.edits)) return undefined
    const diffs: { path: string; oldText: string | null; newText: string }[] = []
    for (const edit of args.edits) {
      if (edit === null || typeof edit !== 'object') continue
      const { old_string: oldText, new_string: newText } = edit as Record<string, unknown>
      if (typeof oldText !== 'string' || typeof newText !== 'string') continue
      diffs.push({ path, oldText, newText })
    }
    return diffs.length > 0 ? diffs : undefined
  }
  return undefined
}

/**
 * Derive the permission rule an "always" answer persists for the approved
 * call. Shell commands get a trailing-space first-word prefix rule
 * (`Bash(npm )` matches `npm install …` but not `npmx …` — the deliberate
 * trailing space replaces the colon-carrying `:*` legacy form, which would
 * otherwise embed the colon in the prefix and never match). Every other tool
 * gets a whole-tool rule. Undefined (stay once-only) when nothing usable
 * remains, e.g. a blank command.
 */
export function allowRuleOf(toolName: string, preview: ApprovalPreview | undefined): string | undefined {
  const name = toolName.trim()
  if (name === '') return undefined
  if (preview?.kind === 'command') {
    const firstWord = preview.command.trim().split(/\s+/)[0] ?? ''
    if (firstWord === '') return undefined
    // ruleString escapes parens/backslashes so a subshell-opening first word
    // round-trips through parseRuleString.
    return ruleString(name, `${firstWord} `)
  }
  return name
}

/**
 * Structural seam for the deployment settings provider: the pieces the
 * always-allow write path needs (namespace descriptors and whole-section
 * replace). Declared locally — the tui package does not import the settings
 * package, mirroring the other `*Like` seams.
 */
type SettingsProviderLike = {
  readonly writable?: boolean
  describe(options?: { redactSecrets?: boolean }): readonly {
    ns: unknown
    revision: number
    user?: unknown
  }[]
  replace(ns: unknown, section: object, expectedRevision?: number): Promise<void>
}

/** Whether an error is the settings provider's revision-conflict rejection. */
function isSettingsConflict(error: unknown): boolean {
  const candidate = error as { name?: unknown; code?: unknown } | null
  if (candidate === null || typeof candidate !== 'object') return false
  return candidate.code === 'SETTINGS_CONFLICT' || candidate.name === 'SettingsConflictError'
}

/**
 * Create the TUI driver: one agent under the CC preset, interaction providers,
 * and a folded view model.
 */
export async function createDriver(ctx: Context, config: DriverConfig = {}): Promise<Driver> {
  const listeners = new Set<(state: TuiState) => void>()
  let state = createInitialState()
  const emit = (next: TuiState): void => {
    state = next
    for (const listener of listeners) listener(state)
  }

  // Transient notice: parked in state.notice with a self-clearing timer. The
  // timer handle lives here so dispose() can cancel it (reversible effect),
  // and a newer notice replaces the pending timer of the previous one.
  let noticeTimer: ReturnType<typeof setTimeout> | undefined
  const showNotice = (text: string, ttlMs = NOTICE_TTL_MS): void => {
    if (noticeTimer !== undefined) clearTimeout(noticeTimer)
    emit(setNotice(state, text))
    noticeTimer = setTimeout(() => {
      noticeTimer = undefined
      // Same-reference guard: no churn when the notice was already cleared.
      if (state.notice !== undefined) emit(setNotice(state, undefined))
    }, ttlMs)
  }

  const composition = await composePreset(ctx, config.agentPreset ?? 'cc')
  const sessionId = SessionId(config.sessionId ?? `tui-${randomUUID()}`)
  const cwd = config.cwd ?? process.cwd()
  const selection: ModelSelectionRef = { assembled: undefined, current: undefined }

  const presetSetup = composition.setup
  const withSelection: AgentSetup = async (agentCtx) => {
    if (presetSetup !== undefined) await presetSetup(agentCtx)
    installModelSelection(agentCtx, selection)
  }

  const resume = config.sessionId !== undefined && config.sessionId.length > 0
  const agentOptions = config.provider !== undefined && config.model !== undefined
    ? { provider: config.provider, model: config.model }
    : undefined
  const handle: AgentHandle = resume
    ? await ctx.agents.resume({
      resumeSessionId: sessionId,
      setup: withSelection,
      ...agentOptions === undefined ? {} : { agentOptions },
    })
    : await ctx.agents.create({
      sessionId,
      meta: { cwd, ...composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset } },
      setup: withSelection,
      ...agentOptions === undefined ? {} : { agentOptions },
    })

  // Rebindable holder: switchSession replaces handle/agent in-place so every
  // event handler and closure reads the LIVE agent at fire time. The session
  // filter compares against current.agent.session.id; late events from a
  // disposed session are dropped by the id mismatch.
  const current: { handle: AgentHandle; agent: Agent } = { handle, agent: handle.agent }
  if (current.agent.options.provider !== undefined && current.agent.options.model !== undefined) {
    selection.current = { provider: current.agent.options.provider, model: current.agent.options.model }
  }
  // Deployment default-model service (settings.yaml's agent-default-model).
  // The headless bundle seeds agents from this; the TUI driver reads it here
  // so a fresh profile with no explicit provider/model still resolves a
  // selection. reasoningEffort is ignored on the read path (undefined = the
  // provider's default effort).
  const agentDefaultModel = ctx.get('agentDefaultModel') as AgentDefaultModelLike | undefined
  /**
   * Seed `selection.current` from the deployment default when no explicit
   * provider/model is configured. Explicit config (DriverConfig) and resolved
   * agent options always win — the service only fills the gap the headless
   * bundle would otherwise fill. Called at boot and after switchSession rebinds
   * the agent. `reset` clears a stale selection first (switchSession) so a
   * previous session's model never leaks across a switch.
   */
  const seedDefaultModel = (reset = false): void => {
    if (reset) selection.current = undefined
    if (selection.current !== undefined) return
    if (current.agent.options.provider !== undefined && current.agent.options.model !== undefined) {
      selection.current = { provider: current.agent.options.provider, model: current.agent.options.model }
      return
    }
    if (agentOptions === undefined) {
      const dep = agentDefaultModel?.currentSelection()
      if (dep !== undefined) {
        selection.current = { provider: dep.provider, model: dep.model }
      }
    }
  }
  seedDefaultModel()
  writeResumeTarget(String(current.agent.session.id))
  // Composer history: load once at boot (oldest→newest); seeded into the
  // editor by root.ts. New prompts are appended on submit (see submit()).
  const historyDir = config.historyDir
  let history = loadHistory(historyDir)
  emit(setPermissionMode(state, liveMode(current.agent, 'default')))

  // Boot banner: one status row greeting. Emitted before the resume fold so it
  // lands as row 0, above replayed history (matching the host's header block).
  const modelLabel = selection.current?.model ?? 'default model'
  emit(upsertRow(state, {
    kind: 'status',
    text: `dsh cc-mode — ${modelLabel} · ${cwd} · /tui-help for keys`,
  }))
  // If no model could be resolved at all (no explicit config, no resolved agent
  // options, no deployment default), surface a one-time boot notice so the
  // previously-silent failure is impossible to miss — F2 (/model) picks one.
  // Fires only at driver create, never on per-event emits.
  if (selection.current === undefined) {
    emit(upsertRow(state, {
      kind: 'status',
      text: 'No model configured. Pick one with /model.',
    }))
  }

  const tools = ctx.get('tools') as ToolsLike | undefined
  const presenters: ToolPresenters | undefined = tools === undefined
    ? undefined
    : {
      presentCall(name, args) {
        return tools.get(name, current.agent)?.presentCall?.(args)
      },
      presentResult(name, args, result) {
        return tools.get(name, current.agent)?.presentResult?.(args, result)
      },
    }

  // Replay the durable event log so a resumed session shows its prior
  // conversation. Presenters are already built, so tool cards re-run
  // presentCall/presentResult on stored args (pure by contract). One emit for
  // the whole fold — folding is a reduce, not a per-event broadcast.
  // Extracted as a closure so switchSession re-runs it for the new session.
  const foldHistory = (): TuiState => {
    let folded = state
    for (const event of current.agent.session.events) {
      folded = applySessionEvent(folded, event as SessionEventLike, presenters)
    }
    return folded
  }
  emit(foldHistory())
  // A historical log may end mid-turn if the process crashed; sync busy from
  // the ground-truth agent status before live events continue.
  emit(setBusy(state, current.agent.status === 'running'))

  // --- Statusline HUD: git branch + sessionProjections feed -----------------
  // Branch: one best-effort probe at boot and after each switchSession (the
  // cwd may differ per session). Async is fine — a late landing re-emits so
  // the footer picks it up; a probe superseded by a switch is dropped by the
  // sequence check. The probe never throws; failures just omit the segment.
  // No timer, one probe per (re)bind — zero polling.
  const branchProbe = config.branchProbe ?? gitBranchOf
  let branch: string | undefined
  let branchSeq = 0
  const refreshBranch = (): void => {
    const seq = ++branchSeq
    const dir = current.agent.session.header.cwd ?? cwd
    void Promise.resolve(branchProbe(dir))
      .catch(() => undefined)
      .then(next => {
        if (seq !== branchSeq || next === branch) return
        branch = next
        // Same-reference emit: re-notifies subscribers so root re-reads the
        // statusline getter with the fresh branch.
        emit(state)
      })
  }
  refreshBranch()

  // Projections: seed once from stateOf (a resumed session may already be
  // populated), then keep the hud fresh from the change feed — event-driven,
  // filtered to the live session so late events from a disposed session are
  // dropped by the id mismatch.
  const projections = ctx.get('sessionProjections') as SessionProjectionsLike | undefined
  const applyHud = (patch: Partial<HudView>): void => {
    const hud = state.hud
    const percentSame = patch.contextPercent === undefined || hud?.contextPercent === patch.contextPercent
    const tokens = patch.tokens
    const tokensSame = tokens === undefined
      || (hud?.tokens !== undefined && hud.tokens.input === tokens.input && hud.tokens.output === tokens.output)
    const detail = patch.contextTokens
    const detailSame = detail === undefined
      || (hud?.contextTokens !== undefined
        && hud.contextTokens.used === detail.used
        && hud.contextTokens.window === detail.window)
    if (percentSame && tokensSame && detailSame) return // emit only on an actual change
    emit(setHud(state, patch))
  }
  const seedHud = (): void => {
    const patch: Partial<HudView> = {}
    if (projections !== undefined) {
      const tokens = tokensOf(projections.stateOf(current.agent.session, 'tokenUsage') as TokenUsageStateLike | undefined)
      if (tokens !== undefined) patch.tokens = tokens
      const pressure = projections.stateOf(current.agent.session, 'contextPressure') as ContextPressureStateLike | undefined
      const percent = percentOf(pressure)
      if (percent !== undefined) patch.contextPercent = percent
      const occupancy = occupancyOf(pressure)
      if (occupancy !== undefined) patch.contextTokens = occupancy
    }
    // Replace wholesale: clear first so stale fields from a previous session
    // never leak, then apply whatever the new session actually has.
    let next = setHud(state, undefined)
    if (patch.contextPercent !== undefined || patch.tokens !== undefined || patch.contextTokens !== undefined) {
      next = setHud(next, patch)
    }
    if (next !== state) emit(next)
  }
  // Todos: same seeding contract as the HUD — stateOf at (re)bind, then the
  // change feed. Absent (`null` before the first write) clears the strip so
  // no cross-session leak survives a switch.
  const seedTodos = (): void => {
    const value = projections === undefined
      ? undefined
      : projections.stateOf(current.agent.session, 'todos')
    const todos = todosOf(value)
    if (sameTodos(state.todos, todos)) return
    emit(setTodos(state, todos))
  }
  seedHud()
  seedTodos()
  if (projections !== undefined) {
    projections.onChanged((session, key, value) => {
      if (session.id !== current.agent.session.id) return
      if (key === 'tokenUsage') {
        const tokens = tokensOf(value as TokenUsageStateLike | undefined)
        if (tokens !== undefined) applyHud({ tokens })
      } else if (key === 'contextPressure') {
        const pressure = value as ContextPressureStateLike | undefined
        const percent = percentOf(pressure)
        const occupancy = occupancyOf(pressure)
        if (percent === undefined && occupancy === undefined) return
        applyHud({
          ...percent === undefined ? {} : { contextPercent: percent },
          ...occupancy === undefined ? {} : { contextTokens: occupancy },
        })
      } else if (key === 'todos') {
        const todos = todosOf(value)
        if (sameTodos(state.todos, todos)) return
        emit(setTodos(state, todos))
      }
    })
  }

  ctx.on('session/event', (session, event: SessionEvent) => {
    if (session.id !== current.agent.session.id) return
    emit(applySessionEvent(state, event as SessionEventLike, presenters))
    const eventType = event.type as string
    if (eventType === 'permission/mode' || eventType === 'plan/mode') {
      emit(setPermissionMode(state, liveMode(current.agent, state.permissionMode)))
    }
    // Outbox flush anchor: the durable `turn/end` fires exactly once per turn
    // (aborts and errors included). agent/status is unusable here — live
    // events never reach the session log — and busy flips jitter per step, so
    // turn/end is the only per-turn heartbeat. An empty queue makes the flush
    // a no-op (e.g. after interrupt() already cleared it).
    if (eventType === 'turn/end') {
      flushQueue()
    }
  })

  // --- Modal pipeline: approvals + questions share one FIFO ------------------
  // Concurrent approval requests used to overwrite a single slot (leaving the
  // first request's promise hanging) and a question arriving mid-approval
  // rendered both boxes while input routing favored the approval. Instead,
  // every modal enters one FIFO; only the head renders (exactly one of the
  // approval and question slots is set), answering or aborting the head
  // promotes the next entry, and `ask()` during an active modal queues behind
  // it instead of stacking a second box.
  type ApprovalEntry = {
    kind: 'approval'
    view: ApprovalView
    resolve: (outcome: ApprovalOutcome) => void
    signal?: AbortSignal
  }
  type QuestionEntry = {
    kind: 'question'
    id: string
    view: QuestionView
    resolve: (answer: AskUserQuestionAnswer) => void
    reject: (error: unknown) => void
    signal?: AbortSignal
  }
  type ModalEntry = ApprovalEntry | QuestionEntry
  const modalQueue: ModalEntry[] = []

  /** Publish the queue head into exactly one of the two modal slots. */
  const publishHead = (): void => {
    const head = modalQueue[0]
    const behind = modalQueue.length - 1
    if (head === undefined || head.kind !== 'approval') emit(setApproval(state, undefined))
    if (head === undefined || head.kind !== 'question') emit(setQuestion(state, undefined))
    if (head === undefined) return
    if (head.kind === 'approval') {
      emit(setApproval(state, { ...head.view, ...behind === 0 ? {} : { pendingCount: behind } }))
    } else {
      emit(setQuestion(state, head.view))
    }
  }

  /** Remove an entry from the queue (no-op if already gone) and republish. */
  const dequeueModal = (entry: ModalEntry): void => {
    const index = modalQueue.indexOf(entry)
    if (index < 0) return
    modalQueue.splice(index, 1)
    publishHead()
  }

  // --- Approvals ------------------------------------------------------------
  // The head approval is parked in state.approval together with the
  // recoverable payload preview. The "always" answer resolves the current call
  // like a one-shot grant AND persists a derived permission rule through the
  // settings provider (see writeAllowRule). Already-queued requests are decided
  // one by one even after a rule lands — grants never apply retroactively.
  // Requests from the current agent and from tracked subagents (their session
  // id was seen on `subagent/start`, which fires before a subagent's first
  // approval) queue here; anything else passes through to the next provider.
  ctx.on('approval/request', async (req: ApprovalRequest, next) => {
    const ownSessions = new Set(state.subagents.map(run => run.sessionId))
    ownSessions.add(String(current.agent.session.id))
    if (!ownSessions.has(String(req.agent.session.id))) return next()
    const preview = payloadOf(req)
    const view: ApprovalView = {
      toolName: req.toolName,
      ...req.reason === undefined ? {} : { reason: req.reason },
      ...preview.kind === 'none' ? {} : { preview },
    }
    return await new Promise<ApprovalOutcome>(resolve => {
      const entry: ApprovalEntry = {
        kind: 'approval',
        view,
        resolve,
        ...req.signal === undefined ? {} : { signal: req.signal },
      }
      modalQueue.push(entry)
      req.signal?.addEventListener('abort', () => {
        dequeueModal(entry)
        resolve('cancelled')
      }, { once: true })
      publishHead()
    })
  })

  /**
   * Persist the allow rule an "always" answer grants: read the `permissions`
   * namespace descriptor, merge the rule into the raw user section's allow
   * list (re-attaching every passthrough field — `replace` overwrites the
   * whole section), and write it back at the observed revision. One retry on
   * a revision conflict (re-describe, re-merge, replace). Degradations
   * (provider missing, namespace unregistered, write failure) leave the call
   * allowed once and say so in a notice — never a crash after the fact.
   */
  const writeAllowRule = async (toolName: string, preview: ApprovalPreview | undefined): Promise<void> => {
    const rule = allowRuleOf(toolName, preview)
    if (rule === undefined) return
    const settings = ctx.get('settings') as SettingsProviderLike | undefined
    if (settings === undefined || settings.writable === false || typeof settings.describe !== 'function') {
      showNotice('Allowed once only — no writable settings provider is mounted.')
      return
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const descriptor = settings.describe().find(
        entry => String(entry.ns) === String(PERMISSION_SETTINGS_NAMESPACE),
      )
      if (descriptor === undefined) {
        showNotice('Allowed once only — the "permissions" settings namespace is not mounted.')
        return
      }
      const user = descriptor.user !== null && typeof descriptor.user === 'object'
        ? descriptor.user as Record<string, unknown>
        : {}
      const current = Array.isArray(user.allow) ? [...user.allow as unknown[]] : []
      const allow = current.includes(rule) ? current : [...current, rule]
      try {
        await settings.replace(PERMISSION_SETTINGS_NAMESPACE, { ...user, allow }, descriptor.revision)
        showNotice(`Always allow: ${rule}`)
        return
      } catch (error) {
        if (attempt === 0 && isSettingsConflict(error)) continue
        const message = error instanceof Error ? error.message : String(error)
        showNotice(`Allowed once only — saving the allow rule failed: ${message}`)
        return
      }
    }
  }

  const userQuestions = ctx.get('userQuestions') as
    | { registerProvider(provider: { ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> }): () => void }
    | undefined
  let questionsDispose: (() => void) | undefined
  if (userQuestions !== undefined) {
    try {
      questionsDispose = userQuestions.registerProvider({
        ask: async (request: AskUserQuestionRequest) => {
          const first = request.questions[0]
          const view: QuestionView = {
            header: first?.header ?? 'Question',
            question: first?.question ?? '',
            ...first?.detail === undefined ? {} : { detail: first.detail },
            options: (first?.options ?? []).map(option => ({
              label: option.label,
              ...option.description === undefined ? {} : { description: option.description },
            })),
            multiSelect: first?.multiSelect === true,
            ...first?.intent === undefined ? {} : { intent: first.intent },
            focused: 0,
            selected: [],
            custom: '',
          }
          // Queue behind any active modal; when the pipeline is empty this
          // entry becomes the head and renders immediately.
          return await new Promise<AskUserQuestionAnswer>((resolve, reject) => {
            const entry: QuestionEntry = {
              kind: 'question',
              id: first?.id ?? '',
              view,
              resolve: (answer) => resolve({
                answers: answer.answers.map((item, index) => ({
                  id: request.questions[index]?.id ?? item.id,
                  selected: item.selected,
                  ...item.custom === undefined ? {} : { custom: item.custom },
                })),
              }),
              reject,
              ...request.signal === undefined ? {} : { signal: request.signal },
            }
            modalQueue.push(entry)
            request.signal?.addEventListener('abort', () => {
              dequeueModal(entry)
              reject(new UserQuestionError('question cancelled', 'CANCELLED'))
            }, { once: true })
            publishHead()
          })
        },
      })
    } catch (error) {
      if ((error as { code?: string }).code !== 'DUPLICATE_PROVIDER') throw error
    }
  }

  /**
   * Resolve the head question and advance the modal queue. Labels are echoed
   * verbatim — the plan-review `intent.approve` contract requires the exact
   * label string, never an inferred or re-indexed one.
   */
  const resolveQuestion = (selected: readonly string[], custom?: string): void => {
    const head = modalQueue[0]
    if (head === undefined || head.kind !== 'question') return
    modalQueue.shift()
    publishHead()
    head.resolve({
      answers: [{
        id: head.id,
        selected: [...selected],
        ...custom === undefined ? {} : { custom },
      }],
    })
  }

  const applyMode = (mode: PermissionCommandMode): void => {
    const rules = ctx.get('permissionRules') as PermissionRulesLike | undefined
    const planMode = ctx.get('planMode') as PlanModeLike | undefined
    if (mode === 'plan') {
      if (planMode === undefined) {
        showNotice('plan mode is not mounted in this composition')
        return
      }
      planMode.set(current.agent, true)
      emit(setPermissionMode(state, 'plan'))
      return
    }
    if (foldPlanMode(current.agent.session.events)) {
      planMode?.set(current.agent, false)
    }
    if (rules === undefined) {
      showNotice('The permission-rules engine is not mounted in this composition.')
      return
    }
    rules.setMode(current.agent, mode)
    emit(setPermissionMode(state, mode))
  }

  // --- Slash-command catalog: merge local commands with the harness registry.
  // The catalog is rebuilt at boot and whenever the harness fires
  // `commands/change` (register/unregister). The cached array identity stays
  // stable between refreshes so root.ts can detect a change by reference
  // equality and rebuild the autocomplete provider only when needed.
  const commandsService = ctx.get('commands') as CommandsLike | undefined
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
        const harnessList = commandsService.list(current.agent)
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
    const changeEvent = 'commands/change' as Parameters<typeof ctx.on>[0]
    ctx.on(changeEvent, () => {
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
  const subagentStart = 'subagent/start' as Parameters<typeof ctx.on>[0]
  const subagentEnd = 'subagent/end' as Parameters<typeof ctx.on>[0]
  ctx.on(subagentStart, (info: SubagentRunInfoLike) => {
    emit(upsertSubagent(state, {
      runId: String(info.runId),
      provider: String(info.provider),
      sessionId: String(info.id),
      status: 'running',
    }))
  })
  ctx.on(subagentEnd, (info: SubagentRunEndInfoLike) => {
    const view: SubagentRunView = {
      runId: String(info.runId),
      provider: String(info.provider),
      sessionId: String(info.id),
      status: 'done',
      ...(info.stopReason === undefined ? {} : { stopReason: String(info.stopReason) }),
    }
    emit(upsertSubagent(state, view))
  })

  const loadCatalog = async (): Promise<CatalogEntry[]> => {
    const llm = ctx.get('llm') as LlmLike | undefined
    if (llm === undefined) return []
    const entries: CatalogEntry[] = []
    for (const provider of llm.listProviders()) {
      const models = await llm.listModels(provider.id)
      for (const model of models) {
        entries.push({ provider: model.provider, id: model.id, name: model.name })
      }
    }
    return entries
  }

  // `/model` (no args) opens a modal picker instead of dumping a text catalog.
  // The arg path (`/model <n|provider/id>`) stays text-based for scripts.
  const openModelPicker = async (): Promise<void> => {
    const catalog = await loadCatalog()
    const currentRoute = selection.current === undefined
      ? undefined
      : { provider: selection.current.provider, model: selection.current.model }
    if (catalog.length === 0) {
      emit(upsertRow(state, { kind: 'status', text: formatModelCatalog(catalog, currentRoute) }))
      return
    }
    const entries: CatalogEntryView[] = catalog.map(entry => ({
      provider: entry.provider,
      id: entry.id,
      name: entry.name,
    }))
    let focused = 0
    if (currentRoute !== undefined) {
      const index = entries.findIndex(
        entry => entry.provider === currentRoute.provider && entry.id === currentRoute.model,
      )
      if (index >= 0) focused = index
    }
    emit(setModelPicker(state, {
      entries,
      focused,
      ...currentRoute === undefined ? {} : { current: currentRoute },
    }))
  }

  // --- Session switching: /resume overlay + driver.switchSession ----------
  // The overlay mirrors the model picker: state field + open/move/submit/cancel.
  // switchSession is the in-process engine: dispose old, resume new, replay
  // history through foldHistory (same as boot). Ordering is resume-first-
  // dispose-after so a failed resume leaves the old session alive.

  const listSessions = async (): Promise<readonly { id: string; cwd?: string; createdAt: number }[]> => {
    const persistence = ctx.get('sessionPersistence') as PersistenceLike | undefined
    if (persistence === undefined) return []
    return persistence.list()
  }

  const openSessionSwitcher = async (): Promise<void> => {
    const sessions = await listSessions()
    if (sessions.length === 0) {
      emit(upsertRow(state, { kind: 'status', text: 'No sessions are available to resume.' }))
      return
    }
    const sorted = sessions.slice().sort((a, b) => b.createdAt - a.createdAt)
    const currentId = String(current.agent.session.id)
    let focused = sorted.findIndex(s => s.id === currentId)
    if (focused < 0) focused = 0
    const entries: SessionEntryView[] = sorted.map(s => ({
      id: s.id,
      ...s.cwd === undefined ? {} : { cwd: s.cwd },
      createdAt: s.createdAt,
    }))
    emit(setSessionSwitcher(state, {
      sessions: entries,
      focused,
      switching: false,
      currentId,
    }))
  }

  const switchSession = async (id: string): Promise<void> => {
    // No-op guard: same id → stay.
    if (id === String(current.agent.session.id)) return

    // Clear pending overlays and the modal queue (mirror the abort paths):
    // every parked approval resolves cancelled and every parked question
    // rejects cancelled. The session switcher overlay itself is managed by the
    // caller (sessionSwitcherSubmit).
    for (const entry of modalQueue.splice(0)) {
      if (entry.kind === 'approval') entry.resolve('cancelled')
      else entry.reject(new UserQuestionError('session switching', 'CANCELLED'))
    }
    emit(setApproval(state, undefined))
    emit(setQuestion(state, undefined))
    emit(setModelPicker(state, undefined))
    emit(closeTodoPanel(state))
    emit(clearQueue(setBusy(state, false)))

    // Resume first: keeps the old session alive if resume throws. The harness
    // supports multiple concurrent agents (each independently scoped), so a
    // brief overlap is safe. On the SESSION's stored options — omit
    // agentOptions unless config.provider/model were explicitly set (same
    // logic as boot).
    let newHandle: AgentHandle
    try {
      newHandle = await ctx.agents.resume({
        resumeSessionId: SessionId(id),
        setup: withSelection,
        ...agentOptions === undefined ? {} : { agentOptions },
      })
    } catch (error) {
      const message = (error as Error)?.message ?? String(error)
      emit(upsertRow(state, { kind: 'status', text: `Resume failed: ${message}` }))
      return
    }

    // Success — dispose old, bind new. dispose() stops the loop, unregisters
    // the agent, and removes its session from the in-memory store; it does NOT
    // delete the durable session log.
    await current.handle.dispose()
    current.handle = newHandle
    current.agent = newHandle.agent

    // Refresh the model selection from the new agent's resolved options,
    // falling back to the deployment default. Reset first so a stale selection
    // from the previous session never leaks across a switch.
    seedDefaultModel(true)
    writeResumeTarget(id)

    // Reset the transcript: clear + boot banner + fold new history + mode/busy.
    emit(clearRows(state))
    const modelLabel = selection.current?.model ?? 'default model'
    emit(upsertRow(state, {
      kind: 'status',
      text: `dsh cc-mode — ${modelLabel} · ${cwd} · /tui-help for keys`,
    }))
    emit(foldHistory())
    emit(setPermissionMode(state, liveMode(current.agent, 'default')))
    emit(setBusy(state, current.agent.status === 'running'))
    // Refresh the HUD, todos, and branch for the new session: stateOf may
    // already be populated (or absent — stale fields must not leak), and the
    // cwd may point at a different repo.
    seedHud()
    seedTodos()
    refreshBranch()
  }

  const sessionSwitcherSubmit = async (): Promise<void> => {
    const sw = state.sessionSwitcher
    if (sw === undefined || sw.switching) return
    const session = sw.sessions[sw.focused]
    if (session === undefined) return
    // Show the dim 'Switching…' state and block input while the switch is
    // in flight.
    emit(setSessionSwitcher(state, { ...sw, switching: true }))
    try {
      await switchSession(session.id)
    } finally {
      // Close the overlay whether the switch succeeded or failed.
      emit(setSessionSwitcher(state, undefined))
    }
  }

  const runLocal = async (name: string, rawInput: string): Promise<void> => {
    if (name === 'quit' || name === 'exit') {
      await current.handle.dispose()
      return
    }
    if (name === 'clear') {
      emit(clearRows(state))
      return
    }
    if (name === 'tui-help') {
      emit(upsertRow(state, {
        kind: 'status',
        text: 'Shift+Tab cycles permission modes. /model lists adapters. /agents lists subagent activity. /resume lists sessions. /quit exits.',
      }))
      return
    }
    if (name === 'resume') {
      if (rawInput.length > 0) {
        await switchSession(rawInput)
        return
      }
      await openSessionSwitcher()
      return
    }
    if (name === 'model') {
      if (rawInput.length === 0) {
        await openModelPicker()
        return
      }
      const catalog = await loadCatalog()
      const chosen = parseModelChoice(rawInput, catalog)
      if (chosen === undefined) {
        showNotice(`Unknown model "${rawInput}". Try /model for the catalog.`)
        return
      }
      selection.current = { provider: chosen.provider, model: chosen.model }
      emit(upsertRow(state, {
        kind: 'status',
        text: `Model is now ${chosen.provider}/${chosen.model}.`,
      }))
    }
    if (name === 'cost') {
      const totals = projections === undefined
        ? undefined
        : totalsOf(projections.stateOf(current.agent.session, 'tokenUsage') as TokenUsageStateLike | undefined)
      emit(upsertRow(state, { kind: 'status', text: formatCostReport(totals) }))
      return
    }
    if (name === 'agents') {
      const runs = state.subagents
      if (runs.length === 0) {
        emit(upsertRow(state, { kind: 'status', text: 'No subagent activity this session.' }))
        return
      }
      const lines = ['Subagent activity:']
      for (const run of runs) {
        const marker = run.status === 'running' ? '●' : '✓'
        const short = shortenSession(run.sessionId)
        const reason = run.stopReason === undefined ? '' : ` [${run.stopReason}]`
        lines.push(`  ${marker} ${run.provider} · ${short}${reason}`)
      }
      emit(upsertRow(state, { kind: 'status', text: lines.join('\n') }))
    }
  }

  const runHarness = async (line: string): Promise<void> => {
    const commands = ctx.get('commands') as CommandsLike | undefined
    if (commands === undefined) {
      showNotice('No command registry is mounted.')
      return
    }
    const execution = await commands.execute(current.agent, line, [], new AbortController().signal)
    const text = execution?.result?.text
    if (text !== undefined && text.length > 0) {
      emit(upsertRow(state, { kind: 'status', text }))
    }
  }

  /**
   * Outbox flush, anchored to the durable `turn/end` event: snapshot the
   * queue, dispatch every entry FIFO through `followup`, and clear the queue
   * in the same synchronous stroke as the dispatch — so the queue never holds
   * an entry that was already sent and ↑ recall cannot race a flush. Busy is
   * re-asserted optimistically (the flushed followups start a new turn
   * immediately; the fold's `turn/end` handling just set it false).
   */
  const flushQueue = (): void => {
    const pending = [...state.queued]
    if (pending.length === 0) return
    for (const text of pending) {
      current.agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }))
    }
    emit(setBusy(clearQueue(state), true))
  }

  /**
   * Ctrl+S queue-jump: inject every queued entry into the RUNNING turn
   * immediately — same synchronous snapshot-then-clear discipline as
   * {@link flushQueue}, but via `agent.steer` and without a busy flip (the
   * turn is already running).
   */
  const steerQueued = (): void => {
    const pending = [...state.queued]
    if (pending.length === 0) return
    for (const text of pending) {
      current.agent.steer(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }))
    }
    emit(clearQueue(state))
  }

  /**
   * Recall for editing: pop the most recent queued entry back out of the
   * outbox and hand it to the caller (root.ts puts it into the composer).
   * Race-free by construction — flush and steer always clear synchronously,
   * so the queue only ever holds entries that were never sent.
   */
  const recallQueued = (): string | undefined => {
    const popped = popQueued(state)
    if (popped.text === undefined) return undefined
    emit(popped.state)
    return popped.text
  }

  const submit = async (text?: string): Promise<void> => {
    const draft = text ?? state.draft
    if (draft.trim().length === 0) return
    emit(setDraft(state, ''))
    const parsed = parseSlash(draft)
    if (parsed.kind === 'local') {
      await runLocal(parsed.name, parsed.rawInput)
      return
    }
    if (parsed.kind === 'harness') {
      await runHarness(parsed.line)
      return
    }
    // Persist the prompt (not slash commands — they are commands, not
    // prompts, and would dilute the recall signal). Consecutive duplicates
    // and the cap are handled inside saveHistory.
    history = saveHistory([...history, draft], historyDir)
    if (state.busy) {
      // Outbox: park the text as a pending chip only. It reaches the agent on
      // the next durable `turn/end` (flushQueue) or immediately via Ctrl+S
      // (steerQueued). No injection into the running turn here — that is what
      // makes recall-then-edit meaningful.
      emit(enqueue(state, draft))
      return
    }
    // Idle sends bypass the outbox entirely — the row surfaces from the
    // durable `user/message` event, and a sent text must not stay recallable.
    current.agent.followup(createUserMessage({
      content: [{ type: 'text', text: draft }],
      source: { kind: 'user' },
    }))
    emit(setBusy(state, true))
  }

  const statusLineOf = (width?: number): string => formatStatusLine({
    cwd: current.agent.session.header.cwd ?? cwd,
    sessionId: String(current.agent.session.id),
    permissionMode: state.permissionMode,
    ...selection.current === undefined ? {} : { model: selection.current.model },
    ...branch === undefined ? {} : { branch },
    ...state.hud?.contextPercent === undefined ? {} : { contextPercent: state.hud.contextPercent },
    ...state.hud?.contextTokens === undefined ? {} : { contextTokens: state.hud.contextTokens },
    ...state.hud?.tokens === undefined ? {} : { tokens: state.hud.tokens },
    busy: state.busy,
  }, width === undefined ? {} : { width })

  return {
    get state() {
      return state
    },
    get statusLine() {
      return statusLineOf()
    },
    statusLineIn(width?: number) {
      return statusLineOf(width)
    },
    get cwd() {
      return cwd
    },
    get promptHistory() {
      return history
    },
    subscribe(listener) {
      listeners.add(listener)
      listener(state)
      return () => {
        listeners.delete(listener)
      }
    },
    setDraft(draft) {
      emit(setDraft(state, draft))
    },
    submit,
    interrupt() {
      current.agent.cancel({ kind: 'user' })
      // cancel discards queued/steering inbox items; mirror that in UI state.
      // Clearing BEFORE the abort's turn/end lands also guarantees the flush
      // anchor finds an empty queue — an interrupt never resurrects entries.
      emit(upsertRow(clearQueue(setBusy(state, false)), {
        kind: 'status',
        text: 'Interrupted by user.',
      }))
    },
    steerQueued,
    recallQueued,
    cyclePermissionMode() {
      const live = liveMode(current.agent, state.permissionMode)
      const next = nextPermissionMode(live)
      if (!(PERMISSION_COMMAND_MODES as readonly string[]).includes(next)) return
      applyMode(next)
    },
    toggleGlobalCollapse() {
      emit(toggleGlobalCollapse(state))
    },
    toggleThinking() {
      emit(toggleThinking(state))
    },
    answerApproval(kind: ApprovalAnswerKind) {
      const head = modalQueue[0]
      if (head === undefined || head.kind !== 'approval') return
      // Advance the queue BEFORE resolving: a resolution can immediately fire
      // the next approval/request, which must enqueue behind the survivors.
      modalQueue.shift()
      publishHead()
      head.resolve(kind === 'reject' ? 'rejected' : 'allowed-once')
      if (kind === 'always') {
        // Fire-and-forget: the call proceeds while the rule persists; a write
        // failure surfaces as a notice, never as an answer error.
        void writeAllowRule(head.view.toolName, head.view.preview).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          showNotice(`Allowed once only — saving the allow rule failed: ${message}`)
        })
      }
    },
    questionMove(delta) {
      emit(moveQuestionFocus(state, delta))
    },
    questionToggle() {
      const question = state.question
      if (question === undefined) return
      if (question.focused >= question.options.length) {
        emit(typeQuestionText(state, ' '))
        return
      }
      if (question.multiSelect) {
        emit(toggleQuestionOption(state, question.focused))
        return
      }
      resolveQuestion([question.options[question.focused]!.label])
    },
    questionPick(index) {
      const question = state.question
      if (question === undefined) return
      const option = question.options[index]
      if (option === undefined) return
      if (question.multiSelect) {
        emit(toggleQuestionOption(state, index))
        return
      }
      resolveQuestion([option.label])
    },
    questionType(text) {
      emit(typeQuestionText(state, text))
    },
    questionBackspace() {
      emit(backspaceQuestionText(state))
    },
    questionSubmit() {
      const question = state.question
      if (question === undefined) return
      const custom = question.custom.trim()
      let selected: string[]
      if (question.selected.length > 0) {
        selected = [...question.selected]
      } else if (custom.length > 0) {
        selected = []
      } else {
        // Nothing chosen and no free text: enter resolves the focused option
        // (the first option when the "Other" row holds focus) so the question
        // always gets an answer.
        const fallback = question.focused < question.options.length
          ? question.options[question.focused]!.label
          : question.options[0]?.label
        selected = fallback === undefined ? [] : [fallback]
      }
      resolveQuestion(selected, custom.length > 0 ? custom : undefined)
    },
    questionCancel() {
      const question = state.question
      resolveQuestion(question !== undefined && question.options.length > 0 ? [question.options[0]!.label] : [])
    },
    async openModelPicker() {
      await openModelPicker()
    },
    modelPickerMove(delta) {
      emit(moveModelPickerFocus(state, delta))
    },
    modelPickerSubmit() {
      const picker = state.modelPicker
      if (picker === undefined) return
      const entry = picker.entries[picker.focused]
      emit(setModelPicker(state, undefined))
      if (entry !== undefined) {
        selection.current = { provider: entry.provider, model: entry.id }
        emit(upsertRow(state, {
          kind: 'status',
          text: `Model is now ${entry.provider}/${entry.id}.`,
        }))
      }
    },
    modelPickerCancel() {
      emit(setModelPicker(state, undefined))
    },
    async openSessionSwitcher() {
      await openSessionSwitcher()
    },
    sessionSwitcherMove(delta) {
      emit(moveSessionSwitcherFocus(state, delta))
    },
    async sessionSwitcherSubmit() {
      await sessionSwitcherSubmit()
    },
    sessionSwitcherCancel() {
      emit(setSessionSwitcher(state, undefined))
    },
    toggleTodoPanel() {
      if (state.todoPanel !== undefined) {
        emit(closeTodoPanel(state))
        return
      }
      emit(openTodoPanel(state))
    },
    todoPanelMove(delta) {
      emit(moveTodoPanelFocus(state, delta))
    },
    todoPanelClose() {
      emit(closeTodoPanel(state))
    },
    showNotice,
    markExitAttempt(now) {
      emit(markExitAttempt(state, now ?? Date.now()))
    },
    async switchSession(id) {
      await switchSession(id)
    },
    async listSessions() {
      return listSessions()
    },
    async loadModelCatalog() {
      return loadCatalog()
    },
    listCommands() {
      return commandCatalog
    },
    async dispose() {
      if (noticeTimer !== undefined) {
        clearTimeout(noticeTimer)
        noticeTimer = undefined
      }
      questionsDispose?.()
      await current.handle.dispose()
    },
  }
}
