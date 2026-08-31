/**
 * In-process protocol driver: session/event → UI store, followup/steer/cancel
 * back into the agent. Only this directory imports `@deepseek-ai/*`.
 * @module @jianxx/dsh-cc-tui/harness/driver
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentHandle, type AgentSetup, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
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
import { createAgentSection, attachSessionEvents } from './driver-agent.ts'

import type { Driver } from '../state/driver-types.ts'
export type { Driver } from '../state/driver-types.ts'
import type { DriverConfig } from '../state/driver-types.ts'

import { clearResumeTarget, writeResumeTarget } from '../resume-target.ts'
import type { ApprovalAnswerKind } from '../state/driver-types.ts'
import {
  closeTodoPanel,
  closeUsagePanel,
  createInitialState,
  markExitAttempt,
  moveTodoPanelFocus,
  openTodoPanel,
  setBusy,
  setDraft,
  setNotice,
  setPermissionMode,
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
  // Deployment default-model service, effort resolution, history binding,
  // and the resume marker now live in the agent section (harness/driver-agent.ts).
  const agent = createAgentSection({
    emit,
    state: () => state,
    ctx,
    current,
    selection,
    agentOptions,
    liveMode,
    historyDir: config.historyDir,
  })
  await agent.seedDefaultModel()
  // Marker semantics: write on resume (self-heal) and after the first real
  // user prompt — never on an empty fresh boot. The agent section owns the
  // binding; seed true + persist only when this boot resumed.
  if (resumed) {
    agent.setMarkedContent(true)
    agent.persistResumeTarget()
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

  // Replay the durable event log so a resumed session shows its prior
  // conversation via the agent section's presenter-bound fold. One emit for
  // the whole fold — folding is a reduce, not a per-event broadcast.
  emit(agent.foldHistory())
  // A historical log may end mid-turn if the process crashed; sync busy from
  // the ground-truth agent status before live events continue.
  emit(setBusy(state, current.agent.status === 'running'))

  // --- Statusline HUD: git branch + sessionProjections feed -----------------
  const hud = createHudSection({
    emit,
    state: () => state,
    ctx,
    cwd,
    current,
    selection,
    branchProbe: config.branchProbe ?? gitBranchOf,
  })
  const { refreshBranch, seedHud, seedTodos, applyUsage, projections, statusLineOf } = hud

  // Late-bound cross-section handles: runHarness (mode/pickers) and flushQueue
  // (session/event listener) are wired after their sections are constructed.
  const actions: {
    runHarness(line: string): Promise<{ kind: string; text?: string } | undefined | null>
    flushQueue(): void
  } = {
    runHarness: async () => { throw new Error('runHarness used before init') },
    flushQueue: (): void => {},
  }

  // session/event listener (fold + working-line anchor/step + outbox flush).
  // Presenters come from the agent section; flush is late-bound through the
  // actions holder because the queue section is constructed later.
  attachSessionEvents({
    emit,
    state: () => state,
    ctx,
    current,
    liveMode,
    presenters: agent.presenters,
    flushQueue: () => actions.flushQueue(),
  })

  // --- Modal pipeline: approvals + questions share one FIFO ------------------
  const approvals = createApprovalsSection({ emit, state: () => state, ctx, current, showNotice })
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
  // Slash-command catalog + subagent lifecycle listeners.
  const catalog = createCatalogSection({ emit, state: () => state, current, ctx })

  // Model/effort/permission pickers; resolveEfforts/stalePair/loadCatalog come
  // from the agent section (they read `llm` off the host ctx).
  const pickers = createPickersSection({
    emit,
    state: () => state,
    selection,
    current,
    liveMode,
    resolveEfforts: agent.resolveEfforts,
    stalePair: agent.stalePair,
    loadCatalog: agent.loadCatalog,
    runHarness: (line) => actions.runHarness(line),
  })
  const { openModelPicker, applyModelSwitch, openEffortPicker, openPermissionPicker } = pickers

  // --- Session switching: /resume overlay + driver.switchSession ----------
  const sessions = createSessionsSection({
    emit,
    state: () => state,
    ctx,
    cwd,
    current,
    selection,
    liveMode,
    seedDefaultModel: agent.seedDefaultModel,
    foldHistory: agent.foldHistory,
    seedHud,
    seedTodos,
    refreshBranch,
    writeResumeTarget,
    setMarkedContent: agent.setMarkedContent,
    spliceAll: () => approvals.spliceAll(),
    withSelection,
    agentOptions,
  })
  const switchSession = sessions.switchSession
  const openSessionSwitcher = sessions.openSessionSwitcher

  // Local slash commands (/export-md, /copy, runLocal) + host-command dispatch.
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
    loadCatalog: agent.loadCatalog,
    resolveEfforts: agent.resolveEfforts,
    persistResumeTarget: agent.persistResumeTarget,
    getMarkedContent: agent.getMarkedContent,
    setMarkedContent: agent.setMarkedContent,
  })
  const { runLocal, runHarness } = runLocalSection
  actions.runHarness = runHarness

  // --- `!` bash mode: local shell commands -----------------------------------
  const bashCtx: DriverBashCtx = {
    state: () => state,
    emit,
    cwd,
    shell: agent.shell,
    appendBashHistory: agent.appendBashHistory,
  }
  const runShellCommand = (raw: string): Promise<void> => runShellCommandModule(bashCtx, raw)

  // Outbox queue + submit/interrupt pipeline; history rebinds through the agent
  // section's get/set seams.
  const queue = createQueueSection({
    emit,
    state: () => state,
    current,
    runLocal,
    runHarness,
    openPermissionPicker,
    runShellCommand,
    getHistory: agent.getHistory,
    setHistory: agent.setHistory,
    historyDir: agent.historyDir,
    persistResumeTarget: agent.persistResumeTarget,
    setMarkedContent: agent.setMarkedContent,
  } satisfies DriverQueueCtx)
  actions.flushQueue = () => queue.flushQueue()

  return {
    get state() { return state },
    get statusLine() { return statusLineOf() },
    statusLineIn: (width?: number) => statusLineOf(width),
    get cwd() { return cwd },
    get promptHistory() { return agent.getHistory() },
    get bashHistory() { return agent.getBashHistory() },
    subscribe(listener) {
      listeners.add(listener)
      listener(state)
      return () => { listeners.delete(listener) }
    },
    setDraft: (draft) => { emit(setDraft(state, draft)) },
    submit: queue.submit,
    interrupt: queue.interrupt,
    steerQueued: queue.steerQueued,
    recallQueued: queue.recallQueued,
    cyclePermissionMode: () => modeSection.cyclePermissionMode(),
    toggleGlobalCollapse() { emit(toggleGlobalCollapse(state)) },
    toggleThinking() { emit(toggleThinking(state)) },
    answerApproval: (kind: ApprovalAnswerKind) => approvals.answerApproval(kind),
    questionMove: (delta) => approvals.questionMove(delta),
    questionToggle: () => approvals.questionToggle(),
    questionPick: (index) => approvals.questionPick(index),
    questionType: (text) => approvals.questionType(text),
    questionBackspace: () => approvals.questionBackspace(),
    questionSubmit: () => approvals.questionSubmit(),
    questionCancel: () => approvals.questionCancel(),
    openModelPicker: () => pickers.openModelPicker(),
    modelPickerMove: (delta) => pickers.modelPickerMove(delta),
    modelPickerSubmit: () => pickers.modelPickerSubmit(),
    modelPickerCancel: () => pickers.modelPickerCancel(),
    openEffortPicker: () => pickers.openEffortPicker(),
    effortPickerMove: (delta) => pickers.effortPickerMove(delta),
    effortPickerSubmit: () => pickers.effortPickerSubmit(),
    effortPickerCancel: () => pickers.effortPickerCancel(),
    openPermissionPicker: async () => { pickers.openPermissionPicker() },
    permissionPickerMove: (delta) => pickers.permissionPickerMove(delta),
    permissionPickerSubmit: () => pickers.permissionPickerSubmit(),
    permissionPickerCancel: () => pickers.permissionPickerCancel(),
    openSessionSwitcher: () => sessions.openSessionSwitcher(),
    sessionSwitcherMove: (delta) => sessions.sessionSwitcherMove(delta),
    sessionSwitcherType: (text) => sessions.sessionSwitcherType(text),
    sessionSwitcherBackspace: () => sessions.sessionSwitcherBackspace(),
    sessionSwitcherToggleScope: () => sessions.sessionSwitcherToggleScope(),
    sessionSwitcherSubmit: () => sessions.sessionSwitcherSubmit(),
    sessionSwitcherCancel: () => sessions.sessionSwitcherCancel(),
    toggleTodoPanel() {
      if (state.todoPanel !== undefined) { emit(closeTodoPanel(state)); return }
      emit(openTodoPanel(state))
    },
    todoPanelMove: (delta) => emit(moveTodoPanelFocus(state, delta)),
    todoPanelClose: () => emit(closeTodoPanel(state)),
    usagePanelClose: () => emit(closeUsagePanel(state)),
    worktreeExitMove: (delta) => runLocalSection.worktreeExitMove(delta),
    worktreeExitSubmit: () => runLocalSection.worktreeExitSubmit(),
    worktreeExitCancel: () => runLocalSection.worktreeExitCancel(),
    showNotice,
    markExitAttempt: (now) => emit(markExitAttempt(state, now ?? Date.now())),
    switchSession: (id) => sessions.switchSession(id),
    listSessions: () => sessions.listSessions(),
    loadModelCatalog: () => pickers.loadModelCatalog(),
    loadModelEfforts: () => pickers.loadModelEfforts(),
    listCommands: () => catalog.listCommands(),
    async dispose() {
      if (noticeTimer !== undefined) { clearTimeout(noticeTimer); noticeTimer = undefined }
      approvals.dispose()
      if (agent.getMarkedContent()) agent.persistResumeTarget()
      await current.handle.dispose()
    },
  }
}
