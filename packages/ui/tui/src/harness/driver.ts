/**
 * In-process protocol driver: session/event → UI store, followup/steer/cancel
 * back into the agent. Only this directory imports `@deepseek-ai/*`.
 * @module @jianxx/dsh-cc-tui/harness/driver
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentHandle, type AgentSetup, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { foldPlanMode } from '@deepseek-ai/dsh-plan-mode'
import { foldPermissionMode } from '@jianxx/dsh-cc-permission-rules'
import { composePreset } from './preset.ts'
import { createSessionsSection } from './driver-sessions.ts'
import { gitBranchOf } from './shell-output.ts'
import { runShellCommand as runShellCommandModule } from './driver-bash.ts'
import { createApprovalsSection } from './driver-approvals.ts'
import { createCatalogSection } from './driver-catalog.ts'
import type { DriverBashCtx, DriverQueueCtx } from './driver-ctx.ts'
import { createModeSection } from './driver-mode.ts'
import { createHudSection } from './driver-hud.ts'
import { createPickersSection } from './driver-pickers.ts'
import { createQueueSection } from './driver-queue.ts'
import { createRunLocalSection } from './driver-run-local.ts'

import type { Driver } from '../state/driver-types.ts'
export type { Driver } from '../state/driver-types.ts'
import type {
  AgentDefaultModelLike,
  DriverConfig,
  LlmLike,
  ShellExecutorLike,
  ToolsLike,
} from '../state/driver-types.ts'

import { type CatalogEntry } from '../model-catalog.ts'
import { clearResumeTarget, readResumeTarget, writeResumeTarget } from '../resume-target.ts'
import { HISTORY_CAP, loadHistory } from '../history.ts'
import { loadBashHistory, saveBashHistory } from '../bash-history.ts'
import {
  applySessionEvent,
  type SessionEventLike,
  type ToolPresenters,
} from '../transcript.ts'
import type { ApprovalAnswerKind } from '../state/driver-types.ts'
import {
  clearTurn,
  closeTodoPanel,
  closeUsagePanel,
  createInitialState,
  markExitAttempt,
  moveTodoPanelFocus,
  openTodoPanel,
  resetTurnStep,
  setBusy,
  setDraft,
  setNotice,
  setPermissionMode,
  setTurnActive,
  toggleGlobalCollapse,
  toggleThinking,
  upsertRow,
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
      queue.flushQueue()
    }
  })

  // --- Modal pipeline: approvals + questions share one FIFO ------------------
  // Extracted to harness/driver-approvals.ts: the section owns the FIFO
  // (createModalQueue), routes `approval/request`, persists allow rules, and
  // answers user questions. `state`/`current` are read live via the ctx so the
  // section always sees the current view-model.
  const approvals = createApprovalsSection({
    emit,
    state: () => state,
    ctx,
    current,
    showNotice,
  })
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

  // Slash-command catalog + subagent lifecycle listeners live in a section so
  // the harness factory stays lean. listCommands() back-ends the Driver API.
  const catalog = createCatalogSection({ emit, state: () => state, current, ctx })

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

  // Model/effort/permission pickers live in a collaborator that reads all
  // shared state/functions through a ctx; createDriver keeps resolveEfforts /
  // stalePair / loadCatalog (they read `llm` off the host ctx) and passes them
  // in. pickers.* return-literal bodies delegate back to these locals.
  const pickers = createPickersSection({
    emit,
    state: () => state,
    selection,
    current,
    liveMode,
    resolveEfforts,
    stalePair,
    loadCatalog,
    runHarness: (line) => actions.runHarness(line),
  })
  const {
    openModelPicker,
    applyModelSwitch,
    openEffortPicker,
    openPermissionPicker,
    modelPickerMove,
    modelPickerSubmit,
    modelPickerCancel,
    effortPickerMove,
    effortPickerSubmit,
    effortPickerCancel,
    permissionPickerMove,
    permissionPickerSubmit,
    permissionPickerCancel,
  } = pickers

  // --- Session switching: /resume overlay + driver.switchSession ----------
  // Delegated to a free-function collaborator (harness/driver-sessions.ts);
  // see that file for the switch engine, overlay picker, and session listing.
  const sessions = createSessionsSection({
    emit,
    state: () => state,
    ctx,
    cwd,
    current,
    selection,
    liveMode,
    seedDefaultModel,
    foldHistory,
    seedHud,
    seedTodos,
    refreshBranch,
    writeResumeTarget,
    setMarkedContent: (value) => { markedContent = value },
    spliceAll: () => approvals.spliceAll(),
    withSelection,
    agentOptions,
  })
  const {
    listSessions,
    openSessionSwitcher,
    switchSession,
    sessionSwitcherMove,
    sessionSwitcherType,
    sessionSwitcherBackspace,
    sessionSwitcherToggleScope,
    sessionSwitcherSubmit,
    sessionSwitcherCancel,
  } = sessions
  // Local slash commands (/export-md, /copy, runLocal) + host-command dispatch
  // (runHarness) migrate to a free-function collaborator (harness/driver-run-
  // local.ts) so the factory stays under budget. createDriver keeps the aliases
  // submit() needs and the late-bound actions holder, then wires it after
  // destructuring so the mode section's /plan writes reach the real dispatch.
  const runLocalSection = createRunLocalSection({
    emit,
    state: () => state,
    ctx,
    cwd,
    config,
    current,
    selection,
    projections,
    applyUsage,
    showNotice,
    switchSession,
    openSessionSwitcher,
    openModelPicker,
    applyModelSwitch,
    openEffortPicker,
    loadCatalog,
    resolveEfforts,
    persistResumeTarget,
    getMarkedContent: () => markedContent,
  })
  const { runLocal, runHarness } = runLocalSection
  actions.runHarness = runHarness

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

  // Outbox queue + submit/interrupt pipeline: extracted to driver-queue.ts.
  // `history`/`markedContent` rebind through the getter/setter seams so the
  // leaf stays decoupled from createDriver's locals.
  const queue = createQueueSection({
    emit,
    state: () => state,
    current,
    runLocal,
    runHarness,
    openPermissionPicker,
    runShellCommand,
    getHistory: () => history,
    setHistory: (next) => { history = next },
    historyDir,
    persistResumeTarget,
    setMarkedContent: (value) => { markedContent = value },
  } satisfies DriverQueueCtx)


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
    submit: queue.submit,
    interrupt: queue.interrupt,
    steerQueued: queue.steerQueued,
    recallQueued: queue.recallQueued,
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
      approvals.answerApproval(kind)
    },
    questionMove(delta) {
      approvals.questionMove(delta)
    },
    questionToggle() {
      approvals.questionToggle()
    },
    questionPick(index) {
      approvals.questionPick(index)
    },
    questionType(text) {
      approvals.questionType(text)
    },
    questionBackspace() {
      approvals.questionBackspace()
    },
    questionSubmit() {
      approvals.questionSubmit()
    },
    questionCancel() {
      approvals.questionCancel()
    },
    async openModelPicker() {
      await openModelPicker()
    },
    modelPickerMove(delta) {
      modelPickerMove(delta)
    },
    modelPickerSubmit(): Promise<void> {
      return modelPickerSubmit()
    },
    modelPickerCancel() {
      modelPickerCancel()
    },
    async openEffortPicker() {
      await openEffortPicker()
    },
    effortPickerMove(delta) {
      effortPickerMove(delta)
    },
    async effortPickerSubmit() {
      await effortPickerSubmit()
    },
    effortPickerCancel() {
      effortPickerCancel()
    },
    async openPermissionPicker() {
      openPermissionPicker()
    },
    permissionPickerMove(delta) {
      permissionPickerMove(delta)
    },
    async permissionPickerSubmit() {
      await permissionPickerSubmit()
    },
    permissionPickerCancel() {
      permissionPickerCancel()
    },
    async openSessionSwitcher() {
      await openSessionSwitcher()
    },
    sessionSwitcherMove(delta) {
      sessionSwitcherMove(delta)
    },
    sessionSwitcherType(text) {
      sessionSwitcherType(text)
    },
    sessionSwitcherBackspace() {
      sessionSwitcherBackspace()
    },
    sessionSwitcherToggleScope() {
      sessionSwitcherToggleScope()
    },
    async sessionSwitcherSubmit() {
      await sessionSwitcherSubmit()
    },
    sessionSwitcherCancel() {
      sessionSwitcherCancel()
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
      return pickers.loadModelCatalog()
    },
    async loadModelEfforts() {
      return pickers.loadModelEfforts()
    },
    listCommands() {
      return catalog.listCommands()
    },
    async dispose() {
      if (noticeTimer !== undefined) {
        clearTimeout(noticeTimer)
        noticeTimer = undefined
      }
      approvals.dispose()
      if (markedContent) persistResumeTarget()
      await current.handle.dispose()
    },
  }
}
