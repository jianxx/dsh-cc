/**
 * The dsh-cc epoch collector: inline first-epoch collection of a continuable
 * subagent child with zero harness changes (normative design:
 * `docs/plans/2026-09-10-epoch-collector-dsh-cc.md`).
 *
 * One shared `subagent/start` + `subagent/end` listener pair and one watch
 * map (`Map<childId, { runId?, resolve }>`) serve every collector of the
 * process. The reservation is placed BEFORE `startContinuable` so an
 * immediate settle cannot fall between start and subscription; the runId is
 * captured from the child's first `subagent/start` and the end event is
 * matched by runId (a cold-resumed later epoch has a new runId and never
 * satisfies a stale watcher). The shared listeners are disposed when the map
 * empties.
 *
 * This module is the ONE-FILE swap seam (§7): when upstream later ships the
 * collectable continuable handle, only this file's `collectFirstEpoch`
 * implementation is replaced — the Task tool and TUI surfaces are untouched.
 *
 * @module @jianxx/dsh-cc-subagent-task/epoch-collector
 */

import type { Agent } from '@deepseek-ai/dsh-agent'

/** One output content block of the child's closing message. */
export interface EpochOutputBlock {
  type: string
  text?: string
}

/** The child's terminal as observed on `subagent/end`. */
export interface EpochTerminal {
  stopReason: string
  output?: readonly EpochOutputBlock[]
}

/**
 * The collect race outcome: the epoch's real terminal, or the prompt
 * synthetic `aborted` (abort never awaits child quiescence — §4).
 */
export type EpochOutcome =
  | ({ kind: 'epoch' } & EpochTerminal)
  | { kind: 'aborted'; stopReason: 'aborted' }

/** Duck-typed interrupt surface on the subagents seam (harness `interrupt`). */
export interface SubagentsInterruptLike {
  /**
   * Interrupt a live child's current turn. Admission is synchronous; an
   * absent/settled target is an accepted no-op. Absent on a seam without the
   * capability → the collector degrades to a non-interrupting prompt resolve.
   */
  interrupt?(childId: string, authority: { kind: 'ancestor'; agent: Agent }): void
}

/** Duck-typed event bus (cordis `ctx.on`) the lifecycle events arrive on. */
export interface EpochEventBus {
  on(event: string, listener: (info: Record<string, unknown>) => void): (() => void) | void
}

interface WatchEntry {
  /** Captured from the child's first `subagent/start` with `id === childId`. */
  runId?: string
  resolve: (terminal: EpochTerminal) => void
}

/** The one shared watch map (per-process singleton, §3 "Parallel collects"). */
const watches = new Map<string, WatchEntry>()
/** The bus the shared listener pair is currently subscribed to. */
let watchedBus: EpochEventBus | undefined
/** Disposer of the shared listener pair on {@link watchedBus}. */
let disposeWatchers: (() => void) | undefined

function ensureWatchers(bus: EpochEventBus): void {
  if (disposeWatchers !== undefined && watchedBus === bus) return
  // A collect on a different bus (never happens in production, where every
  // collector shares the one cordis context) re-subscribes on the new bus.
  if (disposeWatchers !== undefined) disposeWatchers()
  const offStart = bus.on('subagent/start', info => {
    const entry = watches.get(String(info.id))
    if (entry !== undefined && entry.runId === undefined) entry.runId = String(info.runId)
  })
  const offEnd = bus.on('subagent/end', info => {
    const runId = String(info.runId)
    for (const [childId, entry] of watches) {
      if (entry.runId !== runId) continue
      watches.delete(childId)
      const output = info.lastAssistantMessage as EpochOutputBlock[] | undefined
      entry.resolve({
        stopReason: String(info.stopReason),
        ...(output !== undefined ? { output } : {}),
      })
      if (watches.size === 0 && disposeWatchers !== undefined) disposeWatchers()
      return
    }
  })
  watchedBus = bus
  disposeWatchers = () => {
    offStart?.()
    offEnd?.()
    watchedBus = undefined
  }
}

function release(childId: string): void {
  watches.delete(childId)
  if (watches.size === 0 && disposeWatchers !== undefined) disposeWatchers()
}

/** Instrumentation for tests and diagnostics: live watch entries. */
export function epochWatchSize(): number {
  return watches.size
}

// ── Duplicate-notice suppression bookkeeping (§5) ─────────────────────────

/**
 * The pop-once "collected" set: senderSessionIds whose `subagent-settled`
 * notice must be dropped because the epoch was consumed inline. Entries are
 * popped by the suppression pre-step listener on first delivery, so a later
 * epoch of the same child delivers normally.
 */
const collectedForSuppression = new Set<string>()

/** Mark a child's settlement notice for drop (done at collect reservation). */
export function markCollectedForSuppression(childId: string): void {
  collectedForSuppression.add(childId)
}

/**
 * Un-mark a child (a promoted child is never suppressed — its notice flows
 * normally; Slice 3's `promote()` calls this).
 */
export function releaseCollectedForSuppression(childId: string): void {
  collectedForSuppression.delete(childId)
}

/** Whether a child's settlement notice is currently marked for drop. */
export function isCollectedForSuppression(childId: string): boolean {
  return collectedForSuppression.has(childId)
}

// ── Slice 3 promotion registry (§6) — exported, published next slice ──────

/** A live foreground collect the TUI can promote (Ctrl+B) or abort. */
export interface CollectorRegistration {
  childId: string
  /** Release the wait to background: un-suppress + resolve `async_launched`. */
  promote(): void
  /** Interrupt exactly once + prompt synthetic resolve (§4). */
  abort(): void
}

const registrations = new Map<string, CollectorRegistration>()

/** Registry key: parentSessionId + toolCallToken. */
export function collectorKey(parentSessionId: string, toolCallToken: string): string {
  return `${parentSessionId}\u0000${toolCallToken}`
}

export function registerCollector(key: string, handle: CollectorRegistration): void {
  registrations.set(key, handle)
}

export function unregisterCollector(key: string): void {
  registrations.delete(key)
}

export function collectorFor(key: string): CollectorRegistration | undefined {
  return registrations.get(key)
}

// ── The collect loop (§3) ─────────────────────────────────────────────────

export interface CollectFirstEpochDeps {
  /** The cordis context (bus) the subagent lifecycle events arrive on. */
  bus: EpochEventBus
  /** The preallocated durable child id the watch is keyed by. */
  childId: string
  /** The calling agent — the interrupt authority credential. */
  agent: Agent
  /** The tool call's signal; abort maps to the §4 semantics. */
  signal: AbortSignal
  /** The subagents seam, probed for `interrupt` (M5). */
  subagents?: SubagentsInterruptLike
  /**
   * Performs the actual `startContinuable` call. The reservation is placed
   * BEFORE this runs (subscribe-before-start, §8); a throw from it releases
   * the reservation and the suppression mark (tombstone parity lives in the
   * caller, mirroring `startBackground`).
   */
  start: () => Promise<void>
}

/**
 * Collect a continuable child's first epoch inline. Never awaits the parent's
 * inbound messages — only bus events (§3 deadlock rule).
 */
export async function collectFirstEpoch(deps: CollectFirstEpochDeps): Promise<EpochOutcome> {
  const { bus, childId, agent, signal, subagents, start } = deps
  markCollectedForSuppression(childId)
  let resolveEntry!: (terminal: EpochTerminal) => void
  const entry: WatchEntry = { resolve: terminal => resolveEntry(terminal) }
  const epochPromise = new Promise<EpochTerminal>(resolve => {
    resolveEntry = resolve
  })
  let interrupted = false
  let raceAbort: ((outcome: EpochOutcome) => void) | undefined
  const abortPromise = new Promise<EpochOutcome>(resolve => {
    raceAbort = resolve
  })
  const onAbort = (): void => {
    if (interrupted) return
    interrupted = true
    // Interrupt exactly once (M5); an absent/settled target is an accepted
    // no-op, and an admission throw must never block the prompt resolve.
    if (subagents?.interrupt !== undefined) {
      try {
        subagents.interrupt(childId, { kind: 'ancestor', agent })
      } catch {
        // Degraded: the prompt resolve below is still prompt and observable.
      }
    }
    raceAbort?.({ kind: 'aborted', stopReason: 'aborted' })
  }
  signal.addEventListener('abort', onAbort, { once: true })
  // Reserve BEFORE start (§8 race register).
  watches.set(childId, entry)
  ensureWatchers(bus)
  try {
    await start()
  } catch (error) {
    signal.removeEventListener('abort', onAbort)
    release(childId)
    releaseCollectedForSuppression(childId)
    throw error
  }
  if (signal.aborted) onAbort()
  const outcome = await Promise.race([
    epochPromise.then((terminal): EpochOutcome => ({ kind: 'epoch', ...terminal })),
    abortPromise,
  ])
  signal.removeEventListener('abort', onAbort)
  if (outcome.kind === 'aborted') {
    // Keep the watch entry armed ONLY to drive suppression bookkeeping: the
    // child's real `subagent/end` arrives later and releases the entry.
    return outcome
  }
  // Epoch end already released the entry (and disposed the shared listeners
  // when the map emptied); the suppression mark stays until the pop-once
  // listener consumes the duplicated settled notice.
  return outcome
}
