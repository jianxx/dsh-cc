/**
 * In-process protocol driver: session/event → UI store, followup/steer/cancel
 * back into the agent. Only this directory imports `@deepseek-ai/*`.
 * @module @jianxx/dsh-cc-tui/harness/driver
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
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
import { nextPermissionMode, type PermissionCommandMode } from '../mode-cycle.ts'
import { parseSlash } from '../slash.ts'
import {
  applySessionEvent,
  type SessionEventLike,
} from '../transcript.ts'
import {
  clearRows,
  createInitialState,
  setApproval,
  setBusy,
  setDraft,
  setNotice,
  setPermissionMode,
  setQuestion,
  upsertRow,
  type TuiState,
} from '../store.ts'

export interface DriverConfig {
  cwd?: string
  agentPreset?: string
  sessionId?: string
}

export interface Driver {
  readonly state: TuiState
  subscribe(listener: (state: TuiState) => void): () => void
  setDraft(draft: string): void
  submit(): Promise<void>
  interrupt(): void
  cyclePermissionMode(): void
  answerApproval(allowed: boolean): void
  answerQuestion(selected: string): void
  dispose(): Promise<void>
}

type PermissionRulesLike = {
  setMode(agent: Agent, mode: string): void
}

type PlanModeLike = {
  set(agent: Agent, active: boolean): unknown
}

type CommandsLike = {
  execute(
    agent: Agent,
    line: string,
    images: readonly unknown[],
    signal: AbortSignal,
  ): Promise<{ result?: { kind: string; text?: string } } | undefined>
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

  const resume = config.sessionId !== undefined && config.sessionId.length > 0
  const handle: AgentHandle = resume
    ? await ctx.agents.resume({
      resumeSessionId: sessionId,
      ...composition.setup === undefined ? {} : { setup: composition.setup },
    })
    : await ctx.agents.create({
      sessionId,
      meta: { cwd, ...composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset } },
      ...composition.setup === undefined ? {} : { setup: composition.setup },
    })

  const agent = handle.agent
  emit(setPermissionMode(state, liveMode(agent, 'default')))

  ctx.on('session/event', (session, event: SessionEvent) => {
    if (session.id !== agent.session.id) return
    emit(applySessionEvent(state, event as SessionEventLike))
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

  let pendingQuestion: { resolve: (answer: AskUserQuestionAnswer) => void; reject: (error: unknown) => void } | undefined
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
            options: (first?.options ?? []).map(option => option.label),
          }))
          return await new Promise<AskUserQuestionAnswer>((resolve, reject) => {
            pendingQuestion = {
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

  const runLocal = async (name: string): Promise<void> => {
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
        text: 'Shift+Tab cycles permission modes. /quit exits. Other /commands go to the CC catalog.',
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

  const submit = async (): Promise<void> => {
    const draft = state.draft
    if (draft.trim().length === 0) return
    emit(setDraft(state, ''))
    const parsed = parseSlash(draft)
    if (parsed.kind === 'local') {
      await runLocal(parsed.name)
      return
    }
    if (parsed.kind === 'harness') {
      await runHarness(parsed.line)
      return
    }
    emit(upsertRow(setBusy(state, true), { kind: 'user', text: draft }))
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: draft }],
      source: { kind: 'user' },
    }))
  }

  return {
    get state() {
      return state
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
      emit(setBusy(state, false))
    },
    cyclePermissionMode() {
      const current = liveMode(agent, state.permissionMode)
      const next = nextPermissionMode(current)
      if (!(PERMISSION_COMMAND_MODES as readonly string[]).includes(next)) return
      applyMode(next)
    },
    answerApproval(allowed) {
      pendingApproval?.resolve(allowed ? 'allowed-once' : 'rejected')
      pendingApproval = undefined
      emit(setApproval(state, undefined))
    },
    answerQuestion(selected) {
      pendingQuestion?.resolve({ answers: [{ id: '', selected: [selected] }] })
      pendingQuestion = undefined
      emit(setQuestion(state, undefined))
    },
    async dispose() {
      questionsDispose?.()
      await handle.dispose()
    },
  }
}
