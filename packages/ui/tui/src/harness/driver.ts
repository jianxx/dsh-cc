/**
 * In-process protocol driver: session/event → UI store, followup/steer/cancel
 * back into the agent. Only this directory imports `@deepseek-ai/*`.
 * @module @jianxx/dsh-cc-tui/harness/driver
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentHandle, type AgentSetup, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
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
import { BYPASS_MODE, PERMISSION_MODE_OPTIONS } from '@jianxx/dsh-cc-command-permissions'
import { composePreset } from './preset.ts'
import { filterSessions, sortByActivity, type SessionListEntry } from './session-list.ts'
import { allowRuleOf, isSettingsConflict, payloadOf } from './approval-preview.ts'
import {
  defaultExportDir,
  exportStamp,
  gitBranchOf,
} from './shell-output.ts'
import { runShellCommand as runShellCommandModule } from './driver-bash.ts'
import { createModalQueue, type ModalEntry } from './driver-modal.ts'
import type { DriverBashCtx } from './driver-ctx.ts'
import { createModeSection } from './driver-mode.ts'
import { createHudSection } from './driver-hud.ts'
import {
  breakdownOf,
  formatCostReport,
  occupancyOf,
  totalsOf,
  usageViewOf,
} from './usage-view.ts'

import type { Driver } from '../state/driver-types.ts'
export type { Driver } from '../state/driver-types.ts'
import type {
  AgentDefaultModelLike,
  ContextPressureStateLike,
  DriverConfig,
  LlmLike,
  PersistenceLike,
  SessionQueryLike,
  SessionTitleResultLike,
  ShellExecutorLike,
  SettingsProviderLike,
  SubagentRunEndInfoLike,
  SubagentRunInfoLike,
  TokenUsageStateLike,
  ToolsLike,
} from '../state/driver-types.ts'

import { parseSlash, LOCAL_COMMANDS } from '../slash.ts'
import { rowsToMarkdown } from '../export-markdown.ts'
import { formatModelCatalog, parseModelChoice, type CatalogEntry } from '../model-catalog.ts'
import { parseEffortChoice } from '../effort-catalog.ts'
import { clearResumeTarget, readResumeTarget, writeResumeTarget } from '../resume-target.ts'
import { HISTORY_CAP, loadHistory, saveHistory } from '../history.ts'
import { loadBashHistory, saveBashHistory } from '../bash-history.ts'
import { shortenSession } from '../statusline.ts'
import {
  applySessionEvent,
  type SessionEventLike,
  type ToolPresenters,
} from '../transcript.ts'
import type { ApprovalAnswerKind } from '../state/driver-types.ts'
import {
  backspaceQuestionText,
  clearQueue,
  clearRows,
  clearTurn,
  closeTodoPanel,
  closeUsagePanel,
  createInitialState,
  enqueue,
  markExitAttempt,
  moveEffortPickerFocus,
  movePermissionPickerFocus,
  moveModelPickerFocus,
  moveQuestionFocus,
  moveSessionSwitcherFocus,
  moveTodoPanelFocus,
  openTodoPanel,
  openUsagePanel,
  popQueued,
  resetTurnStep,
  setApproval,
  setBusy,
  setDraft,
  setEffortPicker,
  setPermissionPicker,
  setModelPicker,
  setNotice,
  setPermissionMode,
  setQuestion,
  setSessionSwitcher,
  setTurnActive,
  toggleQuestionOption,
  toggleGlobalCollapse,
  toggleThinking,
  typeQuestionText,
  upsertRow,
  upsertSubagent,
  type ApprovalPreview,
  type ApprovalView,
  type CatalogEntryView,
  type QuestionView,
  type SessionEntryView,
  type SubagentRunView,
  type TuiState,
} from '../store.ts'

export type { DriverConfig, TokenUsageTotals } from '../state/driver-types.ts'
export {
  BASH_OUTPUT_LINE_CAP,
  BASH_STDOUT_MAX_BYTES,
  BASH_TIMEOUT_MS,
  gitBranchOf,
} from './shell-output.ts'
export { formatCostReport } from './usage-view.ts'
export { allowRuleOf, payloadOf } from './approval-preview.ts'

/** Default lifetime of a transient `showNotice` hint. */
const NOTICE_TTL_MS = 3000

/**
 * OSC 52 clipboard-write prefix: `ESC ] 52 ; c ;` + base64 payload, closed
 * with BEL. The sequence is zero-width — writing it inline never disturbs the
 * rendered frame.
 */
const OSC52_PREFIX = '\x1b]52;c;'

function liveMode(agent: Agent, fallback: string): string {
  if (foldPlanMode(agent.session.events)) return 'plan'
  return foldPermissionMode(agent.session.events) ?? fallback
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
  const createArgs = {
    sessionId,
    meta: { cwd, ...composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset } },
    setup: withSelection,
    ...agentOptions === undefined ? {} : { agentOptions },
  }
  let resumed = false
  let handle: AgentHandle
  if (resume) {
    try {
      handle = await ctx.agents.resume({
        resumeSessionId: sessionId,
        setup: withSelection,
        ...agentOptions === undefined ? {} : { agentOptions },
      })
      resumed = true
    } catch {
      // Stale marker: the recorded session is gone. Clear it so the next
      // `dsh-cc` boot does not loop on the same failure, then degrade to a
      // fresh session. The empty session must not steal the (now-cleared)
      // marker — persistResumeTarget only fires after real content.
      clearResumeTarget()
      showNotice('上次会话已失效，已开启新会话，可 /resume 手动选择')
      handle = await ctx.agents.create({
        ...createArgs,
        sessionId: SessionId(`tui-${randomUUID()}`),
      })
    }
  } else {
    handle = await ctx.agents.create(createArgs)
  }

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
  // selection. A carried reasoningEffort is seeded too, after resolveModelInfo
  // validation; an invalid or unresolvable effort is silently dropped to the
  // bare pair.
  const agentDefaultModel = ctx.get('agentDefaultModel') as AgentDefaultModelLike | undefined

  /**
   * Advertised reasoning-effort levels of `provider`/`model`, or undefined
   * when they cannot be resolved: the llm service is absent, does not expose
   * `resolveModelInfo` (legacy stubs), the lookup rejects, or the model
   * carries no reasoning metadata. Every effort write fails closed on
   * undefined — the selection must never hold a model/effort pair the llm
   * layer would reject (it throws UNSUPPORTED_REASONING_EFFORT, it does not
   * degrade).
   */
  const resolveEfforts = async (
    provider: string,
    model: string,
  ): Promise<readonly { id: string; name: string }[] | undefined> => {
    const llm = ctx.get('llm') as LlmLike | undefined
    if (llm?.resolveModelInfo === undefined) return undefined
    try {
      const info = await llm.resolveModelInfo(provider, model)
      return info.reasoning === undefined ? undefined : info.reasoning.efforts
    } catch {
      return undefined
    }
  }

  /**
   * Stale-pair guard for detached (submit-then-continue) writes: the captured
   * `{provider, model}` must still be the live selection when the continuation
   * resumes. A mismatch — a concurrent `/model` or a switchSession re-seed
   * happened while validation was parked — emits the notice and reports true;
   * the caller must not write.
   */
  const stalePair = (captured: { provider: string; model: string }): boolean => {
    const live = selection.current
    if (live !== undefined && live.provider === captured.provider && live.model === captured.model) {
      return false
    }
    emit(upsertRow(state, { kind: 'status', text: 'Model changed; effort not applied.' }))
    return true
  }

  /**
   * Seed `selection.current` from the deployment default when no explicit
   * provider/model is configured. Explicit config (DriverConfig) and resolved
   * agent options always win — the service only fills the gap the headless
   * bundle would otherwise fill. Called at boot and after switchSession rebinds
   * the agent; both call sites await it so the banner/notice reads that follow
   * never observe a half-seeded selection. `reset` clears a stale selection
   * first (switchSession) so a previous session's model never leaks across a
   * switch. A carried `reasoningEffort` is seeded only when the model's
   * advertised efforts confirm it; llm missing or effort invalid → silently
   * dropped (the bare pair is always legal).
   */
  const seedDefaultModel = async (reset = false): Promise<void> => {
    if (reset) selection.current = undefined
    if (selection.current !== undefined) return
    if (current.agent.options.provider !== undefined && current.agent.options.model !== undefined) {
      selection.current = { provider: current.agent.options.provider, model: current.agent.options.model }
      return
    }
    if (agentOptions === undefined) {
      const dep = agentDefaultModel?.currentSelection()
      if (dep !== undefined) {
        let effort: string | undefined
        if (dep.reasoningEffort !== undefined) {
          const efforts = await resolveEfforts(dep.provider, dep.model)
          if (efforts?.some(level => level.id === dep.reasoningEffort) === true) {
            effort = dep.reasoningEffort
          }
        }
        selection.current = effort === undefined
          ? { provider: dep.provider, model: dep.model }
          : { provider: dep.provider, model: dep.model, reasoningEffort: ReasoningEffortId(effort) }
      }
    }
  }
  await seedDefaultModel()
  // Marker semantics: write on resume (self-heal) and after the first real
  // user prompt — never on an empty fresh boot, which would steal the
  // previous session from the launcher's auto-resume channel. persistResumeTarget
  // is idempotent (equal id → skip).
  let markedContent = resumed
  const persistResumeTarget = (): void => {
    const id = String(current.agent.session.id)
    if (readResumeTarget() === id) return
    writeResumeTarget(id)
  }
  if (resumed) persistResumeTarget()
  // Composer history: load once at boot (oldest→newest); seeded into the
  // editor by root.ts. New prompts are appended on submit (see submit()).
  const historyDir = config.historyDir
  let history = loadHistory(historyDir)
  // Bash-mode history: a separate stack (own file, same dir resolution) so
  // shell commands never dilute composer prompt recall. Kept newest-first in
  // memory for direct ↑ indexing; the file stays oldest→newest.
  let bashHistory: string[] = loadBashHistory(historyDir).reverse()
  const appendBashHistory = (command: string): void => {
    if (bashHistory[0] === command) return
    bashHistory = [command, ...bashHistory].slice(0, HISTORY_CAP)
    saveBashHistory([...bashHistory].reverse(), historyDir)
  }
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
  // Shell executor seam for `!` commands; absent → runShellCommand degrades
  // to a direct child process.
  const shell = ctx.get('shell') as ShellExecutorLike | undefined
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
  // Migrated to a free-function collaborator (harness/driver-hud.ts) so the
  // factory stays under budget. Boot sequence runs inside the section on
  // construction; switchSession re-seeds via the exposed handles.
  const hud = createHudSection({
    emit,
    state: () => state,
    ctx,
    cwd,
    current,
    selection,
    branchProbe: config.branchProbe ?? gitBranchOf,
  })
  // Handles createDriver still calls directly: the usage panel (runLocal)
  // applies live projections, the public driver getters read the statusline,
  // and switchSession re-seeds HUD/todos/branch after a rebind.
  const { refreshBranch, seedHud, seedTodos, applyUsage, projections, statusLineOf } = hud

  ctx.on('session/event', (session, event: SessionEvent) => {
    if (session.id !== current.agent.session.id) return
    emit(applySessionEvent(state, event as SessionEventLike, presenters))
    const eventType = event.type as string
    if (eventType === 'permission/mode' || eventType === 'plan/mode') {
      emit(setPermissionMode(state, liveMode(current.agent, state.permissionMode)))
    }
    // Working-line anchor backstop: a live `turn/start` (or `agent/status`
    // running) can be the first evidence of a turn this UI never saw
    // submitted. Anchor only when none exists — re-anchoring a live turn
    // would reset elapsed time and the token delta to zero. steerQueued
    // deliberately does not anchor: it fires mid-turn.
    if (eventType === 'turn/start' && state.turn === undefined) {
      emit(setTurnActive(state, { startedAt: Date.now(), outputBase: state.hud?.tokens?.output }))
    } else if (eventType === 'agent/status' && state.turn === undefined) {
      const status = (event as SessionEventLike).data as { status?: unknown } | undefined
      if (status?.status === 'running') {
        emit(setTurnActive(state, { startedAt: Date.now(), outputBase: state.hud?.tokens?.output }))
      }
    }
    // Working-line step clock: each tool call (and each tool result — the model
    // is thinking again once a tool finishes) resets the elapsed timer, so the
    // line shows the current step's duration instead of the whole turn's.
    // Strictly turn-modifying (resetTurnStep no-ops without a live turn) — an
    // idle replay must never conjure a phantom anchor. Known semantics, not
    // bugs: subagent tool events carry the subagent's session id and are
    // filtered above (a Task step's clock spans the whole subagent run), and
    // tool/call fires before the pre-execute approval, so approval
    // deliberation counts as step time. outputBase is preserved — the token
    // delta stays turn-cumulative.
    if ((eventType === 'tool/call' || eventType === 'tool/result') && state.turn !== undefined) {
      emit(resetTurnStep(state, Date.now()))
    }
    // Outbox flush anchor: the durable `turn/end` fires exactly once per turn
    // (aborts and errors included). agent/status is unusable here — live
    // events never reach the session log — and busy flips jitter per step, so
    // turn/end is the only per-turn heartbeat. An empty queue makes the flush
    // a no-op (e.g. after interrupt() already cleared it).
    if (eventType === 'turn/end') {
      // Fixed order: the fold above already emitted the turn's last rows, the
      // working-line anchor clears next, and only then does the queue flush —
      // its dispatch re-anchors for the followup turn.
      emit(clearTurn(state))
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
  const modal = createModalQueue({ emit, state: () => state })

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
      const entry: ModalEntry = {
        kind: 'approval',
        view,
        resolve,
        ...req.signal === undefined ? {} : { signal: req.signal },
      }
      modal.push(entry)
      req.signal?.addEventListener('abort', () => {
        modal.dequeue(entry)
        resolve('cancelled')
      }, { once: true })
      modal.publishHead()
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
            const entry: ModalEntry = {
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
            modal.push(entry)
            request.signal?.addEventListener('abort', () => {
              modal.dequeue(entry)
              reject(new UserQuestionError('question cancelled', 'CANCELLED'))
            }, { once: true })
            modal.publishHead()
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
    const head = modal.peekHead()
    if (head === undefined || head.kind !== 'question') return
    modal.shiftHead()
    modal.publishHead()
    head.resolve({
      answers: [{
        id: head.id,
        selected: [...selected],
        ...custom === undefined ? {} : { custom },
      }],
    })
  }

  // Mode writes serialize per driver: Shift+Tab fires synchronously and rapid
  // presses must not interleave a '/plan off' with the engine setMode. The
  // chain is failure-contained — rejections surface as notices, never as
  // unhandled rejections. The picker and typed '/permissions …' bypass this
  // chain deliberately: the host command re-derives the plan phase per
  // dispatch and plan-mode's set() is convergent
  // (docs/plan-mode-command-channel.md §6.2).
  // /plan writes run through a late-bound holder: runHarness is declared below
  // this section, but the /plan channel is the only cross-plane mode seam, so
  // the mode section reads it lazily after createDriver wires it up.
  const actions: {
    runHarness(line: string): Promise<{ kind: string; text?: string } | undefined | null>
  } = { runHarness: async () => { throw new Error('runHarness used before init') } }

  const modeSection = createModeSection({
    emit,
    state: () => state,
    current,
    projections,
    showNotice,
    runHarness: (line) => actions.runHarness(line),
    getRules: () => ctx.get('permissionRules') as PermissionRulesLike | undefined,
    liveMode,
  })

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

  /**
   * Apply a `/model` switch to `provider`/`model`, carrying the live effort
   * when the new model still supports it. The bare pair needs no validation,
   * so the no-carried-effort path writes synchronously in the caller's tick;
   * the carried path validates via {@link resolveEfforts} and degrades to a
   * bare pair + reset notice when the effort is unsupported OR unresolvable —
   * the switch itself never fails on validation. The stale-pair guard covers
   * the detached continuation: a selection that moved while validation was in
   * flight is never clobbered.
   */
  const applyModelSwitch = async (provider: string, model: string): Promise<void> => {
    const captured = selection.current
    const carried = captured?.reasoningEffort
    if (captured === undefined || carried === undefined) {
      selection.current = { provider, model }
      emit(upsertRow(state, { kind: 'status', text: `Model is now ${provider}/${model}.` }))
      return
    }
    const efforts = await resolveEfforts(provider, model)
    if (stalePair(captured)) return
    const supported = efforts?.some(level => level.id === carried) === true
    selection.current = supported
      ? { provider, model, reasoningEffort: ReasoningEffortId(carried) }
      : { provider, model }
    emit(upsertRow(state, { kind: 'status', text: `Model is now ${provider}/${model}.` }))
    if (!supported) {
      emit(upsertRow(state, {
        kind: 'status',
        text: `Effort "${carried}" not supported by ${model}; reset to default.`,
      }))
    }
  }

  /**
   * Open the `/effort` picker: resolve the live model's advertised efforts
   * and park `effortPicker` state — entries are the effort ids plus the
   * trailing reserved `default` entry, focus on the live effort (the
   * `default` entry when none is set or it is no longer in the list). Fail
   * closed: an unresolved model emits the no-model notice and unresolvable
   * levels emit a notice — never a fabricated list.
   */
  const openEffortPicker = async (): Promise<void> => {
    const route = selection.current
    if (route === undefined) {
      emit(upsertRow(state, { kind: 'status', text: 'No model configured. Use /model first.' }))
      return
    }
    const efforts = await resolveEfforts(route.provider, route.model)
    if (efforts === undefined || efforts.length === 0) {
      emit(upsertRow(state, { kind: 'status', text: `Cannot resolve effort levels for ${route.model}.` }))
      return
    }
    const entries = [...efforts.map(level => level.id), 'default']
    const index = route.reasoningEffort === undefined ? -1 : entries.indexOf(route.reasoningEffort)
    emit(setEffortPicker(state, {
      entries,
      focused: index >= 0 ? index : entries.length - 1,
      current: route.reasoningEffort,
    }))
  }

  /**
   * Open the `/permissions` picker: park the five CC rule-engine modes,
   * focused on the live mode (row 0 when the live mode is not in the list).
   * The overlay always opens — an unmounted engine surfaces as a host-command
   * error on submit, matching the argued `/permissions <mode>` path.
   */
  const openPermissionPicker = (): void => {
    const currentMode = liveMode(current.agent, state.permissionMode)
    const index = PERMISSION_MODE_OPTIONS.findIndex(option => option.id === currentMode)
    emit(setPermissionPicker(state, {
      entries: PERMISSION_MODE_OPTIONS,
      focused: index >= 0 ? index : 0,
      current: currentMode,
    }))
  }

  // --- Session switching: /resume overlay + driver.switchSession ----------
  // The overlay mirrors the model picker: state field + open/move/submit/cancel.
  // switchSession is the in-process engine: dispose old, resume new, replay
  // history through foldHistory (same as boot). Ordering is resume-first-
  // dispose-after so a failed resume leaves the old session alive.

  const listSessions = async (): Promise<readonly SessionListEntry[]> => {
    const persistence = ctx.get('sessionPersistence') as PersistenceLike | undefined
    if (persistence === undefined) return []
    return persistence.list()
  }

  // /resume picker working set: the full unfiltered list lives here while the
  // overlay is open (state.sessionSwitcher.sessions is the visible slice
  // only), and a generation token invalidates an in-flight title decoration
  // when the picker closes or reopens.
  let allSessions: SessionListEntry[] = []
  let switcherGeneration = 0

  const toSessionEntryView = (s: SessionListEntry): SessionEntryView => ({
    id: s.id,
    ...s.cwd === undefined ? {} : { cwd: s.cwd },
    createdAt: s.createdAt,
    ...s.updatedAtMs === undefined ? {} : { updatedAtMs: s.updatedAtMs },
    ...s.title === undefined ? {} : { title: s.title },
    ...s.parentSession === undefined ? {} : { parentSession: s.parentSession },
  })

  /**
   * Async title decoration for the open picker. The generation token read
   * before the await guards the continuation: a result landing after the
   * picker closed (or was reopened, which re-bumped the token) is dropped
   * instead of mutating a stale view. Per-id rejections are skipped; a
   * whole-call failure or abort just skips decoration — the overlay never
   * fails because titles are missing.
   */
  const decorateSessionTitles = async (ids: readonly string[]): Promise<void> => {
    const generation = switcherGeneration
    const sessionQuery = ctx.get('sessionQuery') as SessionQueryLike | undefined
    if (sessionQuery === undefined || ids.length === 0) return
    let results: readonly SessionTitleResultLike[]
    try {
      results = await sessionQuery.readTitleSnapshots(ids)
    } catch {
      return
    }
    if (generation !== switcherGeneration || state.sessionSwitcher === undefined) return
    const titles = new Map<string, string>()
    for (const result of results) {
      if (result.status !== 'fulfilled') continue
      const title = result.value.title?.title
      if (title === undefined || title.length === 0) continue
      // Join on the requested id (`sessionId`), not `value.session.id`.
      // The latter is a cloned header and is not the batch's identity key —
      // using it stamps one title onto every row when headers collide.
      titles.set(result.sessionId, title)
    }
    if (titles.size === 0) return
    const withTitle = (entry: SessionListEntry): SessionListEntry => {
      const title = titles.get(entry.id)
      return title === undefined ? entry : { ...entry, title }
    }
    allSessions = allSessions.map(withTitle)
    const sw = state.sessionSwitcher
    if (sw !== undefined) {
      emit(setSessionSwitcher(state, { ...sw, sessions: sw.sessions.map(withTitle) }))
    }
  }

  // Re-derive the visible list from the working set after a query/scope edit.
  // Focus follows the current session when it survives the filter, else row 0.
  const refilterSessionSwitcher = (): void => {
    const sw = state.sessionSwitcher
    if (sw === undefined) return
    const visible = filterSessions(allSessions, {
      cwd: current.agent.session.header.cwd ?? cwd,
      scope: sw.scope,
      query: sw.query,
      currentId: sw.currentId,
    })
    const index = visible.findIndex(s => s.id === sw.currentId)
    emit(setSessionSwitcher(state, {
      ...sw,
      sessions: visible.map(toSessionEntryView),
      focused: index >= 0 ? index : 0,
      totalCount: allSessions.length,
    }))
    // Second-chance decoration for newly visible, still-untitled rows
    // (same generation rules, same 50-id cap as the initial open).
    const untitled = visible.filter(s => s.title === undefined).slice(0, 50).map(s => s.id)
    if (untitled.length > 0) void decorateSessionTitles(untitled)
  }

  const openSessionSwitcher = async (): Promise<void> => {
    const sessions = await listSessions()
    if (sessions.length === 0) {
      emit(upsertRow(state, { kind: 'status', text: 'No sessions are available to resume.' }))
      return
    }
    switcherGeneration += 1
    allSessions = sortByActivity(sessions)
    // Live header cwd wins over the process cwd: a marker-resumed session can
    // have been created elsewhere, and the current session must always be
    // visible in the default (cwd) scope.
    const scopeCwd = current.agent.session.header.cwd ?? cwd
    const currentId = String(current.agent.session.id)
    const visible = filterSessions(allSessions, {
      cwd: scopeCwd,
      scope: 'cwd',
      query: '',
      currentId,
    })
    const index = visible.findIndex(s => s.id === currentId)
    emit(setSessionSwitcher(state, {
      sessions: visible.map(toSessionEntryView),
      focused: index >= 0 ? index : 0,
      switching: false,
      currentId,
      query: '',
      scope: 'cwd',
      totalCount: allSessions.length,
    }))
    // Decorate the first screenful asynchronously — the overlay must appear
    // immediately, not wait for the title reads.
    void decorateSessionTitles(visible.slice(0, 50).map(s => s.id))
  }

  const closeSessionSwitcher = (): void => {
    // Bump the generation so an in-flight decoration lands nowhere, and drop
    // the working set with the overlay.
    switcherGeneration += 1
    allSessions = []
    emit(setSessionSwitcher(state, undefined))
  }

  const switchSession = async (id: string): Promise<void> => {
    // No-op guard: same id → stay.
    if (id === String(current.agent.session.id)) return

    // Clear pending overlays and the modal queue (mirror the abort paths):
    // every parked approval resolves cancelled and every parked question
    // rejects cancelled. The session switcher overlay itself is managed by the
    // caller (sessionSwitcherSubmit).
    for (const entry of modal.spliceAll()) {
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
    await seedDefaultModel(true)
    writeResumeTarget(id)
    markedContent = false

    // Reset the transcript: clear + boot banner + fold new history + mode/busy.
    emit(clearRows(state))
    const modelLabel = selection.current?.model ?? 'default model'
    emit(upsertRow(state, {
      kind: 'status',
      text: `dsh cc-mode — ${modelLabel} · ${cwd} · /tui-help for keys`,
    }))
    emit(foldHistory())
    emit(setPermissionMode(state, liveMode(current.agent, 'default')))
    // Success path: drop the previous session's anchor together with the busy
    // sync (a failed resume returned above and keeps it), then re-anchor
    // below once the new session's HUD is seeded.
    emit(clearTurn(setBusy(state, current.agent.status === 'running')))
    // Refresh the HUD, todos, and branch for the new session: stateOf may
    // already be populated (or absent — stale fields must not leak), and the
    // cwd may point at a different repo.
    seedHud()
    seedTodos()
    // Resumed log may end mid-turn: re-anchor the working line after seedHud
    // so outputBase reads the new session's seeded token totals.
    if (state.busy) {
      emit(setTurnActive(state, { startedAt: Date.now(), outputBase: state.hud?.tokens?.output }))
    }
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
      closeSessionSwitcher()
    }
  }

  // --- /export-md + /copy: local transcript utilities ------------------------
  // /export-md serializes the live rows via rowsToMarkdown — an explicit path
  // is resolved against the session cwd; no argument lands under the export
  // dir as <sessionId>-<timestamp>.md. Failures degrade to a notice, never a
  // throw into the composer path.
  const exportTranscript = (rawInput: string): void => {
    const target = rawInput.length > 0
      ? resolve(cwd, rawInput)
      : join(config.exportDir ?? defaultExportDir(), `${String(current.agent.session.id)}-${exportStamp()}.md`)
    try {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, rowsToMarkdown(state.rows))
      showNotice(`Exported to ${target}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      showNotice(`Export failed: ${message}`)
    }
  }

  // /copy re-emits the latest assistant reply through an OSC 52 sequence so
  // the terminal itself owns the clipboard (no child process, no permissions).
  // The write sink is injected; without a sink the command still reports — it
  // just has nowhere to hand the payload.
  const copyLatestReply = (): void => {
    const last = [...state.rows].reverse().find(row => row.kind === 'assistant')
    if (last === undefined || last.kind !== 'assistant' || last.text.trim().length === 0) {
      showNotice('Nothing to copy yet — no assistant reply in the transcript.')
      return
    }
    const payload = Buffer.from(last.text, 'utf8').toString('base64')
    config.copyWrite?.(`${OSC52_PREFIX}${payload}\x07`)
    showNotice('Copied latest reply')
  }

  const runLocal = async (name: string, rawInput: string): Promise<void> => {
    if (name === 'quit' || name === 'exit') {
      if (markedContent) persistResumeTarget()
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
        text: 'Shift+Tab cycles permission modes. /permissions opens the mode picker. /model lists adapters. /agents lists subagent activity. /resume lists sessions. /quit exits.',
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
      // Validates + preserves a carried effort when possible (never blocks the
      // switch itself — see applyModelSwitch).
      await applyModelSwitch(chosen.provider, chosen.model)
    }
    if (name === 'effort') {
      if (rawInput.length === 0) {
        await openEffortPicker()
        return
      }
      const route = selection.current
      if (route === undefined) {
        emit(upsertRow(state, { kind: 'status', text: 'No model configured. Use /model first.' }))
        return
      }
      // `default` is a reserved keyword (it wins even over a model effort
      // literally named "default"): reset to the bare pair with ZERO
      // validation and zero adapter calls — the provider default is always
      // legal, even when the llm service is unreachable.
      if (parseEffortChoice(rawInput, [])?.kind === 'default') {
        selection.current = { provider: route.provider, model: route.model }
        emit(upsertRow(state, { kind: 'status', text: 'Reasoning effort reset to the provider default.' }))
        return
      }
      // Fail closed: resolve before validating — selection must never hold an
      // effort the llm layer would reject.
      const efforts = await resolveEfforts(route.provider, route.model)
      if (efforts === undefined || efforts.length === 0) {
        emit(upsertRow(state, { kind: 'status', text: `Cannot resolve effort levels for ${route.model}.` }))
        return
      }
      const choice = parseEffortChoice(rawInput, efforts.map(level => level.id))
      // `choice.kind === 'default'` cannot occur here: the reserved keyword
      // already returned above, so anything non-level is unknown.
      if (choice?.kind !== 'level') {
        emit(upsertRow(state, {
          kind: 'status',
          text: `Unknown effort "${rawInput.trim()}" for ${route.model}. Try /effort.`,
        }))
        return
      }
      const level = efforts.find(candidate => candidate.id === choice.level)!
      // Single branding seam: view layers stay plain strings.
      selection.current = {
        provider: route.provider,
        model: route.model,
        reasoningEffort: ReasoningEffortId(level.id),
      }
      // User-facing text carries the effort NAME, not the raw id.
      emit(upsertRow(state, { kind: 'status', text: `Reasoning effort is now ${level.name}.` }))
    }
    if (name === 'cost') {
      const totals = projections === undefined
        ? undefined
        : totalsOf(projections.stateOf(current.agent.session, 'tokenUsage') as TokenUsageStateLike | undefined)
      emit(upsertRow(state, { kind: 'status', text: formatCostReport(totals) }))
      return
    }
    if (name === 'usage') {
      // Seed from the live projections before opening: a resumed session (or
      // one with no projection change since boot) already holds data the
      // change feed has never delivered. From here on the onChanged feed
      // keeps the snapshot fresh, so an open panel refreshes live.
      if (projections !== undefined) {
        applyUsage(usageViewOf(
          totalsOf(projections.stateOf(current.agent.session, 'tokenUsage') as TokenUsageStateLike | undefined),
          occupancyOf(projections.stateOf(current.agent.session, 'contextPressure') as ContextPressureStateLike | undefined),
          breakdownOf(projections.stateOf(current.agent.session, 'contextBreakdown')),
        ))
      }
      emit(openUsagePanel(state))
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
      return
    }
    if (name === 'export-md') {
      exportTranscript(rawInput)
      return
    }
    if (name === 'copy') {
      copyLatestReply()
      return
    }
  }

  /**
   * Execute a slash command line through the host registry and echo its
   * result text as a status row. Tri-state return:
   * - `null` — no command registry is mounted (already noticed here).
   * - `undefined` — the registry matched nothing (the caller decides the notice).
   * - otherwise the command result.
   */
  const runHarness = async (line: string): Promise<{ kind: string; text?: string } | undefined | null> => {
    const commands = ctx.get('commands') as CommandsLike | undefined
    if (commands === undefined) {
      showNotice('No command registry is mounted.')
      return null
    }
    const execution = await commands.execute(current.agent, line, [], new AbortController().signal)
    const result = execution?.result
    if (result !== undefined && result.text !== undefined && result.text.length > 0) {
      emit(upsertRow(state, { kind: 'status', text: result.text }))
    }
    return result
  }
  // Wire the late-bound holder so the mode section's /plan writes reach the
  // real dispatch path (createDriver declares actions before runHarness).
  actions.runHarness = runHarness

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
    // Unconditional anchor: the only call site is the turn/end handler, which
    // has just cleared the previous turn's anchor, so this re-anchors for the
    // flushed followup turn and can never reset a live one.
    emit(setTurnActive(setBusy(clearQueue(state), true), { startedAt: Date.now(), outputBase: state.hud?.tokens?.output }))
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

  // --- `!` bash mode: local shell commands -----------------------------------
  // A composer line with a leading `!` is executed locally: through the
  // mounted shell executor (resolve→run, bounded spec) or, when none is
  // mounted, through a direct /bin/sh child with the same timeout and output
  // budget. The command never reaches the agent and never touches the session
  // log (status rows are UI-only), and its output is line-capped.
  const bashCtx: DriverBashCtx = {
    state: () => state,
    emit,
    cwd,
    shell,
    appendBashHistory,
  }
  const runShellCommand = (raw: string): Promise<void> => runShellCommandModule(bashCtx, raw)

  const submit = async (text?: string): Promise<void> => {
    const draft = text ?? state.draft
    if (draft.trim().length === 0) return
    emit(setDraft(state, ''))
    // A leading `!` marks a LOCAL shell command no matter how the text was
    // entered — typed in shell mode or pasted wholesale. It runs even while
    // the agent is busy (a local command never touches the turn) and is
    // neither a prompt nor a slash command.
    if (draft.startsWith('!')) {
      await runShellCommand(draft.slice(1))
      return
    }
    const parsed = parseSlash(draft)
    if (parsed.kind === 'local') {
      await runLocal(parsed.name, parsed.rawInput)
      return
    }
    if (parsed.kind === 'harness') {
      // Bare `/permissions` is the TUI analogue of the browser popupSelect
      // decoration: open the overlay instead of dumping the rule listing.
      // `/permissions <mode>` stays scriptable through the host command.
      if (/^\/permissions$/i.test(parsed.line)) {
        openPermissionPicker()
        return
      }
      await runHarness(parsed.line)
      return
    }
    // Persist the prompt (not slash commands — they are commands, not
    // prompts, and would dilute the recall signal). Consecutive duplicates
    // and the cap are handled inside saveHistory. This is also the first
    // real-content signal: mark the session so the launcher can resume it.
    history = saveHistory([...history, draft], historyDir)
    markedContent = true
    persistResumeTarget()
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
    // Anchor the working line at dispatch: elapsed counts from here, the
    // token delta from the current HUD total (undefined when unseeded — the
    // tokenUsage rebase pins it on the first change).
    emit(setTurnActive(setBusy(state, true), { startedAt: Date.now(), outputBase: state.hud?.tokens?.output }))
  }


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
    get bashHistory() {
      return bashHistory
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
      // The working-line anchor clears with the turn.
      emit(upsertRow(clearTurn(clearQueue(setBusy(state, false))), {
        kind: 'status',
        text: 'Interrupted by user.',
      }))
    },
    steerQueued,
    recallQueued,
    cyclePermissionMode() {
      return modeSection.cyclePermissionMode()
    },
    toggleGlobalCollapse() {
      emit(toggleGlobalCollapse(state))
    },
    toggleThinking() {
      emit(toggleThinking(state))
    },
    answerApproval(kind: ApprovalAnswerKind) {
      modal.answerApproval(kind, { writeAllowRule, showNotice })
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
    modelPickerSubmit(): Promise<void> {
      const picker = state.modelPicker
      if (picker === undefined) return Promise.resolve()
      const entry = picker.entries[picker.focused]
      // Read-then-close: capture the focused entry BEFORE the synchronous
      // close-emit so the overlay never lingers while validation runs.
      emit(setModelPicker(state, undefined))
      if (entry === undefined) return Promise.resolve()
      // Effort-preserving switch with the stale-pair guard inside; the bare
      // fast path writes synchronously, a carried effort continues detached.
      return applyModelSwitch(entry.provider, entry.id)
    },
    modelPickerCancel() {
      emit(setModelPicker(state, undefined))
    },
    async openEffortPicker() {
      await openEffortPicker()
    },
    effortPickerMove(delta) {
      emit(moveEffortPickerFocus(state, delta))
    },
    async effortPickerSubmit() {
      const picker = state.effortPicker
      if (picker === undefined) return
      const entry = picker.entries[picker.focused]
      // Read-then-close (mirror modelPickerSubmit): capture the focused entry
      // BEFORE the synchronous close-emit, then validate+write detached.
      emit(setEffortPicker(state, undefined))
      if (entry === undefined) return
      const captured = selection.current
      if (captured === undefined) {
        emit(upsertRow(state, { kind: 'status', text: 'No model configured. Use /model first.' }))
        return
      }
      // The reserved `default` entry resets to the bare pair with zero
      // validation (the provider default is always legal); the stale-pair
      // guard still applies.
      if (entry === 'default') {
        if (stalePair(captured)) return
        selection.current = { provider: captured.provider, model: captured.model }
        emit(upsertRow(state, { kind: 'status', text: 'Reasoning effort reset to the provider default.' }))
        return
      }
      const efforts = await resolveEfforts(captured.provider, captured.model)
      // Stale-pair guard: the captured model must still be the live selection
      // when the validation continuation resumes — a concurrent /model or
      // switchSession re-seed in between refuses the write.
      if (stalePair(captured)) return
      const level = efforts?.find(candidate => candidate.id === entry)
      if (level === undefined) {
        emit(upsertRow(state, { kind: 'status', text: `Cannot resolve effort levels for ${captured.model}.` }))
        return
      }
      selection.current = {
        provider: captured.provider,
        model: captured.model,
        reasoningEffort: ReasoningEffortId(level.id),
      }
      emit(upsertRow(state, { kind: 'status', text: `Reasoning effort is now ${level.name}.` }))
    },
    effortPickerCancel() {
      emit(setEffortPicker(state, undefined))
    },
    async openPermissionPicker() {
      openPermissionPicker()
    },
    permissionPickerMove(delta) {
      emit(movePermissionPickerFocus(state, delta))
    },
    async permissionPickerSubmit() {
      const picker = state.permissionPicker
      if (picker === undefined) return
      const entry = picker.entries[picker.focused]
      if (entry === undefined) {
        emit(setPermissionPicker(state, undefined))
        return
      }
      // bypassPermissions parks an in-overlay confirmation first; a second
      // enter (or any other mode) closes then writes through the host command.
      if (entry.id === BYPASS_MODE && picker.confirmingBypass !== true) {
        emit(setPermissionPicker(state, { ...picker, confirmingBypass: true }))
        return
      }
      emit(setPermissionPicker(state, undefined))
      await runHarness(`/permissions ${entry.id}`)
    },
    permissionPickerCancel() {
      const picker = state.permissionPicker
      if (picker === undefined) return
      if (picker.confirmingBypass === true) {
        const { confirmingBypass: _dropped, ...rest } = picker
        emit(setPermissionPicker(state, rest))
        return
      }
      emit(setPermissionPicker(state, undefined))
    },
    async openSessionSwitcher() {
      await openSessionSwitcher()
    },
    sessionSwitcherMove(delta) {
      emit(moveSessionSwitcherFocus(state, delta))
    },
    sessionSwitcherType(text) {
      const sw = state.sessionSwitcher
      if (sw === undefined || text.length === 0) return
      emit(setSessionSwitcher(state, { ...sw, query: sw.query + text }))
      refilterSessionSwitcher()
    },
    sessionSwitcherBackspace() {
      const sw = state.sessionSwitcher
      if (sw === undefined || sw.query.length === 0) return
      emit(setSessionSwitcher(state, { ...sw, query: sw.query.slice(0, -1) }))
      refilterSessionSwitcher()
    },
    sessionSwitcherToggleScope() {
      const sw = state.sessionSwitcher
      if (sw === undefined) return
      emit(setSessionSwitcher(state, { ...sw, scope: sw.scope === 'cwd' ? 'all' : 'cwd' }))
      refilterSessionSwitcher()
    },
    async sessionSwitcherSubmit() {
      await sessionSwitcherSubmit()
    },
    sessionSwitcherCancel() {
      const sw = state.sessionSwitcher
      if (sw === undefined) return
      // Two-stage escape: a non-empty query clears the filter first (the
      // overlay stays open); an empty query closes it.
      if (sw.query.length > 0) {
        emit(setSessionSwitcher(state, { ...sw, query: '' }))
        refilterSessionSwitcher()
        return
      }
      closeSessionSwitcher()
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
    usagePanelClose() {
      emit(closeUsagePanel(state))
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
    async loadModelEfforts() {
      const route = selection.current
      if (route === undefined) return []
      const efforts = await resolveEfforts(route.provider, route.model)
      if (efforts === undefined) return []
      return [...efforts.map(level => level.id), 'default']
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
      if (markedContent) persistResumeTarget()
      await current.handle.dispose()
    },
  }
}
