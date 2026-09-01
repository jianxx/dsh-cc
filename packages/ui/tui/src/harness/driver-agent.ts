/**
 * Agent-model + history cluster of the TUI driver factory.
 *
 * createDriver used to hold these locals inline: resolveEfforts / stalePair /
 * seedDefaultModel, the resume marker + prompt/bash histories, the tool
 * presenters, history folding, and the model-command catalog. They only read
 * `ctx`/`current`/`selection`/`liveMode` off `rt` (DriverAgentCtx), so they
 * migrate here as a free-function collaborator to keep the factory under the
 * 500-line budget — the same pattern as the other harness/driver-*.ts leaves.
 *
 * Mutable state the other sections rebind (`markedContent`, `history`,
 * `bashHistory`) is owned HERE and exposed through get/set/append handles so
 * no other module captures a stale copy.
 * @module @jianxx/dsh-cc-tui/harness/driver-agent
 */

import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { loadHistory, HISTORY_CAP } from '../history.ts'
import { loadBashHistory, saveBashHistory } from '../bash-history.ts'
import { writeResumeTarget } from '../resume-target.ts'
import {
  clearTurn,
  resetTurnStep,
  setBusy,
  setPermissionMode,
  setTurnActive,
  upsertRow,
  type TuiState,
} from '../store.ts'
import {
  applySessionEvent,
  type SessionEventLike,
  type ToolPresenters,
} from '../transcript.ts'
import type { CatalogEntry } from '../model-catalog.ts'
import type {
  AgentDefaultModelLike,
  LlmLike,
  ShellExecutorLike,
  ToolsLike,
} from '../state/driver-types.ts'
import type { DriverAgentCtx, DriverSessionEventsCtx } from './driver-ctx.ts'

/**
 * The slice of createDriver's model/history cluster that the session/event
 * listener needs: it folds events onto fresh state and presents tool cards for
 * the live agent.
 */
export function attachSessionEvents(rt: DriverSessionEventsCtx): void {
  // Whether a compact this driver anchored owns the working line: a manual
  // `/compact` on an IDLE agent starts its own pseudo-turn (busy + anchor),
  // and its `compaction/end` clears that anchor and flushes the outbox. An
  // auto-compact riding a live turn never touches the anchor.
  let compactOwnedTurn = false
  rt.ctx.on('session/event', (session, event: SessionEvent) => {
    // Late events from a disposed session are dropped by id mismatch.
    if (session.id !== rt.current.agent.session.id) return
    const eventType = (event as SessionEventLike).type as string
    rt.emit(applySessionEvent(rt.state(), event as SessionEventLike, rt.presenters))
    if (eventType === 'permission/mode' || eventType === 'plan/mode') {
      rt.emit(setPermissionMode(rt.state(), rt.liveMode(rt.current.agent, rt.state().permissionMode)))
    }
    // Manual-compaction working line: an idle agent's `/compact` runs outside
    // any turn, so anchor the working line for its duration. A live turn's
    // anchor (auto-compact mid-request) is left untouched.
    if (eventType === 'compaction/start') {
      if (rt.state().turn === undefined) {
        compactOwnedTurn = true
        rt.emit(setBusy(rt.state(), true))
        rt.emit(setTurnActive(rt.state(), { startedAt: Date.now(), outputBase: rt.state().hud?.tokens?.output }))
      }
    } else if (eventType === 'compaction/end' && compactOwnedTurn) {
      compactOwnedTurn = false
      rt.emit(clearTurn(rt.state()))
      rt.emit(setBusy(rt.state(), false))
      // Same contract as turn/end: entries submitted during the compaction
      // flush into the next durable turn.
      rt.flushQueue()
    }
    // Working-line anchor backstop: a live `turn/start` (or `agent/status`
    // running) can be the first evidence of a turn this UI never saw
    // submitted. Anchor only when none exists — re-anchoring a live turn
    // would reset elapsed time and the token delta to zero.
    const liveState = rt.state()
    if (eventType === 'turn/start' && liveState.turn === undefined) {
      rt.emit(setTurnActive(rt.state(), { startedAt: Date.now(), outputBase: liveState.hud?.tokens?.output }))
    } else if (eventType === 'agent/status' && liveState.turn === undefined) {
      const status = (event as SessionEventLike).data as { status?: unknown } | undefined
      if (status?.status === 'running') {
        rt.emit(setTurnActive(rt.state(), { startedAt: Date.now(), outputBase: liveState.hud?.tokens?.output }))
      }
    }
    // Working-line step clock: each tool call (and each tool result) resets
    // the elapsed timer, so the line shows the current step's duration.
    const stepState = rt.state()
    if ((eventType === 'tool/call' || eventType === 'tool/result') && stepState.turn !== undefined) {
      rt.emit(resetTurnStep(rt.state(), Date.now()))
    }
    // Outbox flush anchor: the durable `turn/end` fires exactly once per turn.
    if (eventType === 'turn/end') {
      rt.emit(clearTurn(rt.state()))
      rt.flushQueue()
    }
  })
}

/**
 * The handle object returned by {@link createAgentSection}. createDriver
 * destructures these into its locals and threads them into the other sections.
 */
export interface AgentSection {
  resolveEfforts(provider: string, model: string): Promise<readonly { id: string; name: string }[] | undefined>
  stalePair(captured: { provider: string; model: string }): boolean
  seedDefaultModel(reset?: boolean): Promise<void>
  persistResumeTarget(): void
  getMarkedContent(): boolean
  setMarkedContent(value: boolean): void
  historyDir: string | undefined
  /**
   * Rebind prompt/bash history to a new data directory and reload both from
   * disk. Used by /resume to re-scope history onto the switched session's
   * project (a no-op caller-side when the project is unchanged).
   */
  bindHistoryDir(dir: string | undefined): void
  getHistory(): string[]
  setHistory(next: string[]): void
  getBashHistory(): string[]
  appendBashHistory(command: string): void
  /** Tool presenters (absent when no tools service mounted). */
  presenters: ToolPresenters | undefined
  /** Shell executor seam for `!` commands (used by the bash section). */
  shell: ShellExecutorLike | undefined
  /** Fold the live session's event log onto the current view-model. */
  foldHistory(): TuiState
  loadCatalog(): Promise<CatalogEntry[]>
}

/**
 * Build the agent-model/history cluster. Returns handles createDriver threads
 * into the picker/session/run-local/queue sections and the Driver API, and
 * exposes the owned `markedContent`/`history`/`bashHistory` state through
 * get/set seams so no other module captures a stale copy.
 */
export function createAgentSection(rt: DriverAgentCtx): AgentSection {
  const { ctx, current, selection, agentOptions } = rt

  // Deployment default-model service (settings.yaml's agent-default-model).
  const agentDefaultModel = ctx.get('agentDefaultModel') as AgentDefaultModelLike | undefined

  /**
   * Advertised reasoning-effort levels of `provider`/`model`, or undefined
   * when they cannot be resolved: the llm service is absent, does not expose
   * `resolveModelInfo` (legacy stubs), the lookup rejects, or the model
   * carries no reasoning metadata.
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
   * resumes.
   */
  const stalePair = (captured: { provider: string; model: string }): boolean => {
    const live = selection.current
    if (live !== undefined && live.provider === captured.provider && live.model === captured.model) {
      return false
    }
    rt.emit(upsertRow(rt.state(), { kind: 'status', text: 'Model changed; effort not applied.' }))
    return true
  }

  /**
   * Seed `selection.current` from the deployment default when no explicit
   * provider/model is configured.
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

  /**
   * Marker semantics: write on resume (self-heal) and after the first real
   * user prompt — never on an empty fresh boot.
   */
  let markedContent = false
  const persistResumeTarget = (): void => {
    const id = String(current.agent.session.id)
    // The NEW marker keys off the LIVE session's project (a resumed session
    // created elsewhere writes its own bucket); legacy dual-write stays in
    // the boot-cwd bucket. Dedupe is internal to writeResumeTarget (F4) —
    // no read-compare here.
    writeResumeTarget(id, {
      cwd: current.agent.session.header.cwd ?? rt.cwd,
      legacyCwd: rt.cwd,
    })
  }

  // Composer + bash histories: owned here, rebound through get/set seams.
  // `historyDir` is mutable so /resume can point it at the switched session's
  // project directory (bindHistoryDir); every reader uses the live value via
  // `get historyDir()` rather than a captured snapshot.
  let historyDir = rt.historyDir
  let history = loadHistory(historyDir)
  let bashHistory: string[] = loadBashHistory(historyDir).reverse()
  const appendBashHistory = (command: string): void => {
    if (bashHistory[0] === command) return
    bashHistory = [command, ...bashHistory].slice(0, HISTORY_CAP)
    saveBashHistory([...bashHistory].reverse(), historyDir)
  }
  const bindHistoryDir = (dir: string | undefined): void => {
    historyDir = dir
    history = loadHistory(dir)
    bashHistory = loadBashHistory(dir).reverse()
  }

  const tools = ctx.get('tools') as ToolsLike | undefined
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

  /**
   * Replay the durable event log so a resumed session shows its prior
   * conversation. Folding is a reduce, not a per-event broadcast.
   */
  const foldHistory = (): TuiState => {
    let folded = rt.state()
    for (const event of current.agent.session.events) {
      folded = applySessionEvent(folded, event as SessionEventLike, presenters)
    }
    return folded
  }

  /**
   * Model-command catalog (`/model` picker). Reads the llm service providers
   * it advertises.
   */
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

  return {
    resolveEfforts,
    stalePair,
    seedDefaultModel,
    persistResumeTarget,
    getMarkedContent: () => markedContent,
    setMarkedContent: (value) => { markedContent = value },
    get historyDir() { return historyDir },
    bindHistoryDir,
    getHistory: () => history,
    setHistory: (next) => { history = next },
    getBashHistory: () => bashHistory,
    appendBashHistory,
    presenters,
    shell,
    foldHistory,
    loadCatalog,
  }
}
