/**
 * In-process protocol driver: session/event → UI store, followup/steer/cancel
 * back into the agent. Only this directory imports `@deepseek-ai/*`.
 * @module @jianxx/dsh-cc-tui/harness/driver
 */

import { randomUUID } from 'node:crypto'
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
import { foldPermissionMode } from '@jianxx/dsh-cc-permission-rules'
import { PERMISSION_COMMAND_MODES } from '@jianxx/dsh-cc-command-permissions'
import { composePreset } from './preset.ts'
import type { Driver } from '../state/driver-types.ts'
export type { Driver } from '../state/driver-types.ts'
import { nextPermissionMode, type PermissionCommandMode } from '../mode-cycle.ts'
import { parseSlash, LOCAL_COMMANDS } from '../slash.ts'
import { formatModelCatalog, parseModelChoice, type CatalogEntry } from '../model-catalog.ts'
import { writeResumeTarget } from '../resume-target.ts'
import { loadHistory, saveHistory } from '../history.ts'
import { formatStatusLine } from '../statusline.ts'
import {
  applySessionEvent,
  type SessionEventLike,
  type ToolPresenters,
} from '../transcript.ts'
import type { ToolCallView, ToolResultView } from '../tool-card.ts'
import {
  backspaceQuestionText,
  clearQueue,
  clearRows,
  createInitialState,
  enqueue,
  moveModelPickerFocus,
  moveQuestionFocus,
  setApproval,
  setBusy,
  setDraft,
  setModelPicker,
  setNotice,
  setPermissionMode,
  setQuestion,
  toggleQuestionOption,
  toggleThinking,
  typeQuestionText,
  upsertRow,
  type CatalogEntryView,
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

function liveMode(agent: Agent, fallback: string): string {
  if (foldPlanMode(agent.session.events)) return 'plan'
  return foldPermissionMode(agent.session.events) ?? fallback
}

function commandOf(req: ApprovalRequest): string | undefined {
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
      if (parsed !== null && typeof parsed === 'object' && 'command' in parsed) {
        const command = (parsed as { command: unknown }).command
        return typeof command === 'string' ? command : undefined
      }
    } catch {
      return raw.slice(0, 500)
    }
    return raw.slice(0, 500)
  }
  return undefined
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

  const agent = handle.agent
  if (agent.options.provider !== undefined && agent.options.model !== undefined) {
    selection.current = { provider: agent.options.provider, model: agent.options.model }
  }
  writeResumeTarget(String(agent.session.id))
  // Composer history: load once at boot (oldest→newest); seeded into the
  // editor by root.ts. New prompts are appended on submit (see submit()).
  const historyDir = config.historyDir
  let history = loadHistory(historyDir)
  emit(setPermissionMode(state, liveMode(agent, 'default')))

  // Boot banner: one status row greeting. Emitted before the resume fold so it
  // lands as row 0, above replayed history (matching the host's header block).
  const modelLabel = selection.current?.model ?? 'default model'
  emit(upsertRow(state, {
    kind: 'status',
    text: `dsh cc-mode — ${modelLabel} · ${cwd} · /tui-help for keys`,
  }))

  const tools = ctx.get('tools') as ToolsLike | undefined
  const presenters: ToolPresenters | undefined = tools === undefined
    ? undefined
    : {
      presentCall(name, args) {
        return tools.get(name, agent)?.presentCall?.(args)
      },
      presentResult(name, args, result) {
        return tools.get(name, agent)?.presentResult?.(args, result)
      },
    }

  // Replay the durable event log so a resumed session shows its prior
  // conversation. Presenters are already built, so tool cards re-run
  // presentCall/presentResult on stored args (pure by contract). One emit for
  // the whole fold — folding is a reduce, not a per-event broadcast.
  let folded = state
  for (const event of agent.session.events) {
    folded = applySessionEvent(folded, event as SessionEventLike, presenters)
  }
  emit(folded)
  // A historical log may end mid-turn if the process crashed; sync busy from
  // the ground-truth agent status before live events continue.
  emit(setBusy(state, agent.status === 'running'))

  ctx.on('session/event', (session, event: SessionEvent) => {
    if (session.id !== agent.session.id) return
    emit(applySessionEvent(state, event as SessionEventLike, presenters))
    const eventType = event.type as string
    if (eventType === 'permission/mode' || eventType === 'plan/mode') {
      emit(setPermissionMode(state, liveMode(agent, state.permissionMode)))
    }
  })

  let pendingApproval: { resolve: (outcome: ApprovalOutcome) => void } | undefined
  ctx.on('approval/request', async (req: ApprovalRequest, next) => {
    if (req.agent.id !== agent.id) return next()
    const command = commandOf(req)
    emit(setApproval(state, {
      toolName: req.toolName,
      ...req.reason === undefined ? {} : { reason: req.reason },
      ...command === undefined ? {} : { command },
    }))
    return await new Promise<ApprovalOutcome>(resolve => {
      pendingApproval = { resolve }
      req.signal?.addEventListener('abort', () => {
        pendingApproval = undefined
        emit(setApproval(state, undefined))
        resolve('cancelled')
      }, { once: true })
    })
  })

  let pendingQuestion: {
    id: string
    resolve: (answer: AskUserQuestionAnswer) => void
    reject: (error: unknown) => void
  } | undefined
  const userQuestions = ctx.get('userQuestions') as
    | { registerProvider(provider: { ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> }): () => void }
    | undefined
  let questionsDispose: (() => void) | undefined
  if (userQuestions !== undefined) {
    try {
      questionsDispose = userQuestions.registerProvider({
        ask: async (request: AskUserQuestionRequest) => {
          const first = request.questions[0]
          emit(setQuestion(state, {
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
          }))
          return await new Promise<AskUserQuestionAnswer>((resolve, reject) => {
            pendingQuestion = {
              id: first?.id ?? '',
              resolve: (answer) => resolve({
                answers: answer.answers.map((item, index) => ({
                  id: request.questions[index]?.id ?? item.id,
                  selected: item.selected,
                  ...item.custom === undefined ? {} : { custom: item.custom },
                })),
              }),
              reject,
            }
            request.signal?.addEventListener('abort', () => {
              pendingQuestion = undefined
              emit(setQuestion(state, undefined))
              reject(new UserQuestionError('question cancelled', 'CANCELLED'))
            }, { once: true })
          })
        },
      })
    } catch (error) {
      if ((error as { code?: string }).code !== 'DUPLICATE_PROVIDER') throw error
    }
  }

  /**
   * Resolve the open question and dismiss the overlay. Labels are echoed
   * verbatim — the plan-review `intent.approve` contract requires the exact
   * label string, never an inferred or re-indexed one.
   */
  const resolveQuestion = (selected: readonly string[], custom?: string): void => {
    const pending = pendingQuestion
    if (pending === undefined) return
    pendingQuestion = undefined
    emit(setQuestion(state, undefined))
    pending.resolve({
      answers: [{
        id: pending.id,
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
        emit(setNotice(state, 'plan mode is not mounted in this composition'))
        return
      }
      planMode.set(agent, true)
      emit(setPermissionMode(state, 'plan'))
      return
    }
    if (foldPlanMode(agent.session.events)) {
      planMode?.set(agent, false)
    }
    if (rules === undefined) {
      emit(setNotice(state, 'The permission-rules engine is not mounted in this composition.'))
      return
    }
    rules.setMode(agent, mode)
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
        const harnessList = commandsService.list(agent)
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
    const current = selection.current === undefined
      ? undefined
      : { provider: selection.current.provider, model: selection.current.model }
    if (catalog.length === 0) {
      emit(upsertRow(state, { kind: 'status', text: formatModelCatalog(catalog, current) }))
      return
    }
    const entries: CatalogEntryView[] = catalog.map(entry => ({
      provider: entry.provider,
      id: entry.id,
      name: entry.name,
    }))
    let focused = 0
    if (current !== undefined) {
      const index = entries.findIndex(
        entry => entry.provider === current.provider && entry.id === current.model,
      )
      if (index >= 0) focused = index
    }
    emit(setModelPicker(state, {
      entries,
      focused,
      ...current === undefined ? {} : { current },
    }))
  }

  const runLocal = async (name: string, rawInput: string): Promise<void> => {
    if (name === 'quit' || name === 'exit') {
      await handle.dispose()
      return
    }
    if (name === 'clear') {
      emit(clearRows(state))
      return
    }
    if (name === 'tui-help') {
      emit(upsertRow(state, {
        kind: 'status',
        text: 'Shift+Tab cycles permission modes. /model lists adapters. /resume lists sessions. /quit exits.',
      }))
      return
    }
    if (name === 'resume') {
      if (rawInput.length > 0) {
        writeResumeTarget(rawInput)
        emit(upsertRow(state, {
          kind: 'status',
          text: `Resume target set to ${rawInput}. Restart with dsh --profile tui --resume ${rawInput}`,
        }))
        return
      }
      const persistence = ctx.get('sessionPersistence') as PersistenceLike | undefined
      if (persistence === undefined) {
        emit(setNotice(state, 'No session persistence is mounted in this composition.'))
        return
      }
      const headers = await persistence.list()
      if (headers.length === 0) {
        emit(upsertRow(state, { kind: 'status', text: 'No sessions are available to resume.' }))
        return
      }
      const lines = headers
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(header => `- ${header.id}${header.cwd === undefined ? '' : ` — cwd: ${header.cwd}`}`)
      emit(upsertRow(state, {
        kind: 'status',
        text: ['Recent sessions:', ...lines, 'To switch: /resume <sessionId> then restart, or dsh --profile tui --resume <id>'].join('\n'),
      }))
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
        emit(setNotice(state, `Unknown model "${rawInput}". Try /model for the catalog.`))
        return
      }
      selection.current = { provider: chosen.provider, model: chosen.model }
      emit(upsertRow(state, {
        kind: 'status',
        text: `Model is now ${chosen.provider}/${chosen.model}.`,
      }))
    }
  }

  const runHarness = async (line: string): Promise<void> => {
    const commands = ctx.get('commands') as CommandsLike | undefined
    if (commands === undefined) {
      emit(setNotice(state, 'No command registry is mounted.'))
      return
    }
    const execution = await commands.execute(agent, line, [], new AbortController().signal)
    const text = execution?.result?.text
    if (text !== undefined && text.length > 0) {
      emit(upsertRow(state, { kind: 'status', text }))
    }
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
    // Always queue the text; the chip clears when the durable user/message
    // event folds the row into the transcript (near-instant in-process).
    // No optimistic user row — both paths surface it from the durable event.
    emit(enqueue(state, draft))
    if (state.busy) {
      agent.steer(createUserMessage({
        content: [{ type: 'text', text: draft }],
        source: { kind: 'user' },
      }))
      return
    }
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: draft }],
      source: { kind: 'user' },
    }))
    emit(setBusy(state, true))
  }

  const statusLineOf = (): string => formatStatusLine({
    cwd: agent.session.header.cwd ?? cwd,
    sessionId: String(agent.session.id),
    permissionMode: state.permissionMode,
    ...selection.current === undefined ? {} : { model: selection.current.model },
    busy: state.busy,
  })

  return {
    get state() {
      return state
    },
    get statusLine() {
      return statusLineOf()
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
      agent.cancel({ kind: 'user' })
      // cancel discards queued/steering inbox items; mirror that in UI state.
      emit(upsertRow(clearQueue(setBusy(state, false)), {
        kind: 'status',
        text: 'Interrupted by user.',
      }))
    },
    cyclePermissionMode() {
      const current = liveMode(agent, state.permissionMode)
      const next = nextPermissionMode(current)
      if (!(PERMISSION_COMMAND_MODES as readonly string[]).includes(next)) return
      applyMode(next)
    },
    toggleThinking() {
      emit(toggleThinking(state))
    },
    answerApproval(allowed) {
      pendingApproval?.resolve(allowed ? 'allowed-once' : 'rejected')
      pendingApproval = undefined
      emit(setApproval(state, undefined))
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
    listCommands() {
      return commandCatalog
    },
    async dispose() {
      questionsDispose?.()
      await handle.dispose()
    },
  }
}
