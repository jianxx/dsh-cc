/**
 * Session switcher / /resume section of the in-process protocol driver.
 *
 * Moved out of harness/driver.ts's createDriver factory so the factory stays
 * under the line budget. All shared state arrives on `rt` (DriverSessionsCtx)
 * and is read through getters / by-reference holders — never a stale snapshot —
 * because createDriver rebinds `state` on every emit.
 *
 * @module @jianxx/dsh-cc-tui/harness/driver-sessions
 */

import { SessionId } from '@deepseek-ai/dsh-session'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { join } from 'node:path'
import { filterSessions, sortByActivity, type SessionListEntry } from './session-list.ts'
import { defaultTuiDir } from '../history.ts'
import { isProjectMember, resolveProject, type ProjectInfo } from '../project.ts'
import { readProjectSessionIds } from '../project-sessions.ts'
import {
  clearQueue,
  clearRows,
  clearTurn,
  closeTodoPanel,
  moveSessionSwitcherFocus,
  setApproval,
  setBusy,
  setModelPicker,
  setPermissionMode,
  setQuestion,
  setSessionSwitcher,
  setTurnActive,
  upsertRow,
  type SessionEntryView,
} from '../store.ts'
import type { DriverSessionsCtx } from './driver-ctx.ts'
import type {
  PersistenceLike,
  SessionQueryLike,
  SessionTitleResultLike,
} from '../state/driver-types.ts'

export interface SessionsSection {
  listSessions(): Promise<readonly SessionListEntry[]>
  openSessionSwitcher(): Promise<void>
  closeSessionSwitcher(): void
  switchSession(id: string): Promise<void>
  sessionSwitcherMove(delta: -1 | 1): void
  sessionSwitcherType(text: string): void
  sessionSwitcherBackspace(): void
  sessionSwitcherToggleScope(): void
  sessionSwitcherSubmit(): Promise<void>
  sessionSwitcherCancel(): void
}

const toSessionEntryView = (s: SessionListEntry): SessionEntryView => ({
  id: s.id,
  ...(s.cwd === undefined ? {} : { cwd: s.cwd }),
  createdAt: s.createdAt,
  ...(s.updatedAtMs === undefined ? {} : { updatedAtMs: s.updatedAtMs }),
  ...(s.title === undefined ? {} : { title: s.title }),
  ...(s.parentSession === undefined ? {} : { parentSession: s.parentSession }),
})

export function createSessionsSection(rt: DriverSessionsCtx): SessionsSection {
  const { emit, ctx } = rt

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
  // Project scope for the open picker: resolved once at open (git probes are
  // too expensive per refilter keystroke) and dropped on close. `members`
  // is the sidecar index of the scope project's bucket.
  let switcherProject: ProjectInfo | undefined
  let switcherMembers: ReadonlySet<string> = new Set()

  /** cwd-scope predicate: sidecar-indexed, or cwd inside the project (main
   *  root or any of its worktrees) at a separator boundary. */
  const isScopeMember = (entry: SessionListEntry): boolean =>
    switcherMembers.has(entry.id)
    || (entry.cwd !== undefined
      && switcherProject !== undefined
      && isProjectMember(entry.cwd, switcherProject))

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
    if (generation !== switcherGeneration || rt.state().sessionSwitcher === undefined) return
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
    const sw = rt.state().sessionSwitcher
    if (sw !== undefined) {
      emit(setSessionSwitcher(rt.state(), { ...sw, sessions: sw.sessions.map(withTitle) }))
    }
  }

  // Re-derive the visible list from the working set after a query/scope edit.
  // Focus follows the current session when it survives the filter, else row 0.
  const refilterSessionSwitcher = (): void => {
    const sw = rt.state().sessionSwitcher
    if (sw === undefined) return
    const visible = filterSessions(allSessions, {
      scope: sw.scope,
      query: sw.query,
      currentId: sw.currentId,
      isMember: isScopeMember,
    })
    const index = visible.findIndex((s) => s.id === sw.currentId)
    emit(setSessionSwitcher(rt.state(), {
      ...sw,
      sessions: visible.map(toSessionEntryView),
      focused: index >= 0 ? index : 0,
      totalCount: allSessions.length,
    }))
    // Second-chance decoration for newly visible, still-untitled rows
    // (same generation rules, same 50-id cap as the initial open).
    const untitled = visible.filter((s) => s.title === undefined).slice(0, 50).map((s) => s.id)
    if (untitled.length > 0) void decorateSessionTitles(untitled)
  }

  const openSessionSwitcher = async (): Promise<void> => {
    const sessions = await listSessions()
    if (sessions.length === 0) {
      emit(upsertRow(rt.state(), { kind: 'status', text: 'No sessions are available to resume.' }))
      return
    }
    switcherGeneration += 1
    allSessions = sortByActivity(sessions)
    // Live header cwd wins over the process cwd: a marker-resumed session can
    // have been created elsewhere, and the current session must always be
    // visible in the default (cwd) scope. The scope is the session's
    // *project* (main git root; worktrees collapse onto it), resolved once
    // here — refilters on query keystrokes reuse it.
    const scopeCwd = rt.current.agent.session.header.cwd ?? rt.cwd
    switcherProject = resolveProject(scopeCwd)
    switcherMembers = readProjectSessionIds(join(defaultTuiDir(), 'projects', switcherProject.projectKey))
    const currentId = String(rt.current.agent.session.id)
    const visible = filterSessions(allSessions, {
      scope: 'cwd',
      query: '',
      currentId,
      isMember: isScopeMember,
    })
    const index = visible.findIndex((s) => s.id === currentId)
    emit(setSessionSwitcher(rt.state(), {
      sessions: visible.map(toSessionEntryView),
      focused: index >= 0 ? index : 0,
      switching: false,
      currentId,
      query: '',
      scope: 'cwd',
      cwd: scopeCwd,
      totalCount: allSessions.length,
    }))
    // Decorate the first screenful asynchronously — the overlay must appear
    // immediately, not wait for the title reads.
    void decorateSessionTitles(visible.slice(0, 50).map((s) => s.id))
  }

  const closeSessionSwitcher = (): void => {
    // Bump the generation so an in-flight decoration lands nowhere, and drop
    // the working set with the overlay.
    switcherGeneration += 1
    allSessions = []
    switcherProject = undefined
    switcherMembers = new Set()
    emit(setSessionSwitcher(rt.state(), undefined))
  }

  const switchSession = async (id: string): Promise<void> => {
    // No-op guard: same id → stay.
    if (id === String(rt.current.agent.session.id)) return

    // Clear pending overlays and the modal queue (mirror the abort paths):
    // every parked approval resolves cancelled and every parked question
    // rejects cancelled. The session switcher overlay itself is managed by the
    // caller (sessionSwitcherSubmit).
    for (const entry of rt.spliceAll()) {
      if (entry.kind === 'approval') entry.resolve('cancelled')
      else entry.reject(new UserQuestionError('session switching', 'CANCELLED'))
    }
    emit(setApproval(rt.state(), undefined))
    emit(setQuestion(rt.state(), undefined))
    emit(setModelPicker(rt.state(), undefined))
    emit(closeTodoPanel(rt.state()))
    emit(clearQueue(setBusy(rt.state(), false)))

    // Resume first: keeps the old session alive if resume throws. The harness
    // supports multiple concurrent agents (each independently scoped), so a
    // brief overlap is safe. On the SESSION's stored options — omit
    // agentOptions unless config.provider/model were explicitly set (same
    // logic as boot).
    let newHandle: AgentHandle
    try {
      newHandle = await ctx.agents.resume({
        resumeSessionId: SessionId(id),
        setup: rt.withSelection,
        ...(rt.agentOptions === undefined ? {} : { agentOptions: rt.agentOptions }),
      })
    } catch (error) {
      const message = (error as Error)?.message ?? String(error)
      emit(upsertRow(rt.state(), { kind: 'status', text: `Resume failed: ${message}` }))
      return
    }

    // Success — dispose old, bind new. dispose() stops the loop, unregisters
    // the agent, and removes its session from the in-memory store; it does NOT
    // delete the durable session log.
    await rt.current.handle.dispose()
    rt.current.handle = newHandle
    rt.current.agent = newHandle.agent

    // Re-scope prompt/bash history onto the switched session's project: the
    // new session may live in a different working directory, and recall must
    // follow IT, not the boot directory. No-op for same-project switches.
    rt.rebindHistory(rt.current.agent.session.header.cwd)
    // Pin the switched session in its project's sidecar index so the picker
    // scope no longer relies on the cwd-prefix heuristic for it.
    rt.recordProjectSession(id, rt.current.agent.session.header.cwd)

    // Refresh the model selection from the new agent's resolved options,
    // falling back to the deployment default. Reset first so a stale selection
    // from the previous session never leaks across a switch.
    await rt.seedDefaultModel(true)
    rt.writeResumeTarget(id)
    rt.setMarkedContent(false)

    // Reset the transcript: clear + boot banner + fold new history + mode/busy.
    emit(clearRows(rt.state()))
    const modelLabel = rt.selection.current?.model ?? 'default model'
    emit(upsertRow(rt.state(), {
      kind: 'status',
      text: `dsh cc-mode — ${modelLabel} · ${rt.cwd} · /tui-help for keys`,
    }))
    emit(rt.foldHistory())
    emit(setPermissionMode(rt.state(), rt.liveMode(rt.current.agent, 'default')))
    // Success path: drop the previous session's anchor together with the busy
    // sync (a failed resume returned above and keeps it), then re-anchor
    // below once the new session's HUD is seeded.
    emit(clearTurn(setBusy(rt.state(), rt.current.agent.status === 'running')))
    // Refresh the HUD, todos, and branch for the new session: stateOf may
    // already be populated (or absent — stale fields must not leak), and the
    // cwd may point at a different repo.
    rt.seedHud()
    rt.seedTodos()
    // Resumed log may end mid-turn: re-anchor the working line after seedHud
    // so outputBase reads the new session's seeded token totals.
    if (rt.state().busy) {
      emit(setTurnActive(rt.state(), { startedAt: Date.now(), outputBase: rt.state().hud?.tokens?.output }))
    }
    rt.refreshBranch()
  }

  const sessionSwitcherSubmit = async (): Promise<void> => {
    const sw = rt.state().sessionSwitcher
    if (sw === undefined || sw.switching) return
    const session = sw.sessions[sw.focused]
    if (session === undefined) return
    // Show the dim 'Switching…' state and block input while the switch is
    // in flight.
    emit(setSessionSwitcher(rt.state(), { ...sw, switching: true }))
    try {
      await switchSession(session.id)
    } finally {
      // Close the overlay whether the switch succeeded or failed.
      closeSessionSwitcher()
    }
  }

  return {
    listSessions,
    openSessionSwitcher,
    closeSessionSwitcher,
    switchSession,
    sessionSwitcherMove(delta) {
      emit(moveSessionSwitcherFocus(rt.state(), delta))
    },
    sessionSwitcherType(text) {
      const sw = rt.state().sessionSwitcher
      if (sw === undefined || text.length === 0) return
      emit(setSessionSwitcher(rt.state(), { ...sw, query: sw.query + text }))
      refilterSessionSwitcher()
    },
    sessionSwitcherBackspace() {
      const sw = rt.state().sessionSwitcher
      if (sw === undefined || sw.query.length === 0) return
      emit(setSessionSwitcher(rt.state(), { ...sw, query: sw.query.slice(0, -1) }))
      refilterSessionSwitcher()
    },
    sessionSwitcherToggleScope() {
      const sw = rt.state().sessionSwitcher
      if (sw === undefined) return
      emit(setSessionSwitcher(rt.state(), { ...sw, scope: sw.scope === 'cwd' ? 'all' : 'cwd' }))
      refilterSessionSwitcher()
    },
    async sessionSwitcherSubmit() {
      await sessionSwitcherSubmit()
    },
    sessionSwitcherCancel() {
      const sw = rt.state().sessionSwitcher
      if (sw === undefined) return
      // Two-stage escape: a non-empty query clears the filter first (the
      // overlay stays open); an empty query closes it.
      if (sw.query.length > 0) {
        emit(setSessionSwitcher(rt.state(), { ...sw, query: '' }))
        refilterSessionSwitcher()
        return
      }
      closeSessionSwitcher()
    },
  }
}
