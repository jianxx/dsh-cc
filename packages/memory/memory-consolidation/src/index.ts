/**
 * Background memory consolidation: turn-end extraction and the three-gate
 * dream rewrite.
 *
 * `agent/turn-stopping` fires an extraction subagent (via `ctx.jobs` +
 * `ctx.subagents`, tools restricted to the memory directory) to save durable
 * facts, and evaluates the dream gates (time, session count, lock) to schedule
 * a read-only rewrite of MEMORY.md and topic files. A failed dream rolls back
 * the lock so the time gate re-opens.
 *
 * @module @jianxx/dsh-cc-memory-consolidation
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import { defaultDshHome } from '@deepseek-ai/dsh-home-paths'
import { MEMORY_TOOL_FILTER } from './tools.ts'
import { buildConsolidationPrompt, buildExtractionPrompt } from './prompts.ts'
import { gatesPass } from './gates.ts'
import { readLastConsolidatedAt, rollbackLock, tryAcquireLock, LOCK_STALE_MS } from './lock.ts'

export { LOCK_FILE, LOCK_STALE_MS, readLastConsolidatedAt, rollbackLock, tryAcquireLock } from './lock.ts'
export { gatesPass, timeGatePasses, sessionGatePasses } from './gates.ts'
export type { ConsolidationGateInput } from './gates.ts'
export { MEMORY_AGENT_TOOLS, MEMORY_TOOL_FILTER } from './tools.ts'
export { buildConsolidationPrompt, buildExtractionPrompt } from './prompts.ts'

export const name = 'memory-consolidation'
/** Services required for background jobs and the subagent provider. */
export const inject = ['jobs', 'subagents']

/** Memory consolidation configuration. */
export interface Config {
  /** Memory directory root. Defaults to the harness home `memory/`. */
  memoryHome?: string
  /** Turn-end extraction runs (default true). */
  extractEnabled?: boolean
  /** The three-gate dream runs (default true). */
  dreamEnabled?: boolean
  /** Minimum hours between consolidations (default 24). */
  minHours?: number
  /** Minimum new transcripts to consolidate (default 5). */
  minSessions?: number
  /** A lock holder is stale past this window (default 1 hour). */
  lockStaleMs?: number
  /** One-shot subagent provider for forks (default `fork`). */
  subagentProviderName?: string
}

export const Config: z<Config> = z.object({
  memoryHome: z.string(),
  extractEnabled: z.boolean().default(true),
  dreamEnabled: z.boolean().default(true),
  minHours: z.number().default(24),
  minSessions: z.number().default(5),
  lockStaleMs: z.number().default(LOCK_STALE_MS),
  subagentProviderName: z.string().default('fork'),
})

/** Structural subset of the jobs seam used here. */
interface JobService {
  start(spec: {
    kind: 'subagent'
    label: string
    owner: Agent
    run(): { cancel(reason?: string): void; done: Promise<unknown> }
  }): unknown
}

/** Structural subset of the subagent seam used here. */
interface SubagentService {
  start(name: string, request: {
    label?: string
    prompt: readonly { type: 'text'; text: string }[]
    parent: Agent
    signal: AbortSignal
    toolFilter?: { allow: readonly string[] }
    maxDepth?: number
  }): Promise<{ result: Promise<unknown> }>
}

/** Structural subset of the sessions seam used here. */
interface SessionsService {
  list(): Array<{ id: string; header?: { createdAt?: unknown; delegationDepth?: unknown } }>
}

/**
 * Start a memory-scoped forked subagent as a background job. Resolves to a
 * control object with an abort hook and a settle promise.
 */
async function startMemoryJob(
  ctx: Context,
  agent: Agent,
  provider: string,
  label: string,
  prompt: string,
): Promise<{ abort(reason?: string): void; settled: Promise<boolean> }> {
  const jobs = ctx.get('jobs') as JobService | undefined
  const subagents = ctx.get('subagents') as SubagentService | undefined
  if (jobs === undefined || subagents === undefined) {
    return { abort: () => {}, settled: Promise.resolve(false) }
  }
  const controller = new AbortController()
  // `subagents.start` is async upstream — awaiting it is what exposes the run's
  // `result` promise. Reading `run.result` on the un-awaited Promise throws
  // "Cannot read properties of undefined (reading 'then')" and poisons the
  // turn-stopping dispatch.
  const run = await subagents.start(provider, {
    label,
    signal: controller.signal,
    prompt: [{ type: 'text', text: prompt }],
    parent: agent,
    toolFilter: MEMORY_TOOL_FILTER,
    // Defense-in-depth recursion cap: the top-level listener already gates on
    // depth zero, so this fork's child never delegates. maxDepth is compared
    // against the CHILD's resolved depth (parent + 1); a top-level parent's
    // child resolves to 1 and passes, a grandchild to 2 is rejected.
    maxDepth: 1,
  })
  // Real job-done wiring: `done` maps the subagent outcome onto the JobHooks
  // contract (must never reject). Aborted → killed (rolls back the dream lock),
  // otherwise failure → failed. Both branches resolve.
  const done = run.result.then(
    (): { status: 'completed' } => ({ status: 'completed' }),
    (err): { status: 'killed' } | { status: 'failed'; detail: string } =>
      controller.signal.aborted ? { status: 'killed' } : { status: 'failed', detail: String(err) },
  )
  const settled = done.then(o => o.status === 'completed')
  jobs.start({
    kind: 'subagent',
    label,
    owner: agent,
    run: () => ({
      cancel: (reason?: string) => { controller.abort(reason) },
      done,
    }),
  })
  return { abort: (reason?: string) => { controller.abort(reason) }, settled }
}

/**
 * Register the consolidation plugin.
 * @param ctx - the host context with jobs, subagents, fs, and sessions.
 * @param config - consolidation behavior knobs.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const dir = config.memoryHome ?? join(defaultDshHome(), 'memory')
  const provider = config.subagentProviderName ?? 'fork'
  const minHours = config.minHours ?? 24
  const minSessions = config.minSessions ?? 5

  // Per-session extraction single-flight. Keyed by session id so each top-level
  // agent's in-flight flag and last-spawned event count are isolated.
  const flight = new Map<string, { extracting: boolean; lastEvents: number }>()
  // One dream in flight across the whole plugin instance (per memory dir).
  let dreamInFlight = false
  // Reset the flight state when this plugin fiber is disposed (hygiene / test
  // isolation). cordis `ctx.on` is typed strictly to `keyof Events`, so cleanup
  // is registered as a fiber effect rather than a 'dispose' listener.
  ctx.effect(() => () => {
    flight.clear()
    dreamInFlight = false
  }, 'memory-consolidation: reset flight state')

  ctx.on('agent/turn-stopping', ({ agent, signal }) => {
    // All predicates are synchronous and run before any await, so the flags
    // below are set before a second, interleaved turn-stopping could observe
    // them.
    if (signal.aborted) return
    if (!isTopLevel(agent)) return
    const sessionId = agent.session.header.id
    if (config.extractEnabled ?? true) {
      const entry = flight.get(sessionId)
      // Single-flight: skip while an extraction is in flight or when no new
      // events have arrived since the last spawn.
      if (!entry?.extracting && agent.session.events.length !== entry?.lastEvents) {
        flight.set(sessionId, { extracting: true, lastEvents: agent.session.events.length })
        void runExtraction(ctx, agent, dir, provider).finally(() => {
          const cur = flight.get(sessionId)
          if (cur) cur.extracting = false
        })
      }
    }
    if (config.dreamEnabled ?? true) {
      if (!dreamInFlight) {
        dreamInFlight = true
        void runDream(ctx, agent, dir, provider, minHours, minSessions)
          .catch(() => {})
          .finally(() => { dreamInFlight = false })
      }
    }
  })
}

/**
 * Whether an agent is top-level (not a delegated subagent). This is the root
 * fix for the extraction/dream recursion: a subagent's own turn-end must never
 * spawn another memory fork. Fails CLOSED — any throw from reading the depth
 * treats the agent as a child so nothing is spawned.
 */
function isTopLevel(agent: Agent): boolean {
  try {
    return delegationDepthOf(agent) === 0
  } catch {
    return false
  }
}

function runExtraction(ctx: Context, agent: Agent, dir: string, provider: string): Promise<void> {
  const prompt = buildExtractionPrompt(agent.session.events.length, dir, '')
  // Fire-and-forget: extraction failure must never fail the turn itself. The
  // resolved value is discarded so the returned promise is always `void`.
  return startMemoryJob(ctx, agent, provider, 'extract-memories', prompt)
    .catch(() => {})
    .then(() => {})
}

async function runDream(
  ctx: Context,
  agent: Agent,
  dir: string,
  provider: string,
  minHours: number,
  minSessions: number,
): Promise<void> {
  const fs = ctx.get('fs')
  if (fs === undefined) return
  const now = Date.now()
  const lastAt = await readLastConsolidatedAt(fs, dir)
  const sessionIds = listNewSessions(ctx, lastAt)
  if (!gatesPass({
    lastConsolidatedAt: lastAt,
    now,
    minHours,
    sessionCount: sessionIds.length,
    minSessions,
  })) return
  const priorAt = await tryAcquireLock(fs, dir, process.pid, now)
  if (priorAt === null) return
  const prompt = buildConsolidationPrompt(dir, sessionTranscriptDir(agent), sessionIds)
  const job = await startMemoryJob(ctx, agent, provider, 'memory-consolidation', prompt)
  void job.settled.then((ok) => {
    if (!ok) void rollbackLock(fs, dir, priorAt)
  })
}

/** Live sessions are the transcripts available to review; absent sessions skip. */
function listNewSessions(ctx: Context, lastAt: number): string[] {
  const sessions = ctx.get('sessions') as SessionsService | undefined
  if (sessions === undefined) return []
  return sessions
    .list()
    // Subagent sessions (validated delegationDepth > 0) are excluded from both
    // the min-sessions count and the dream input: their content is already
    // covered by turn-end extraction. Absent/invalid depth is treated as 0.
    .filter(session => {
      const d = session.header?.delegationDepth
      return !(Number.isSafeInteger(d) && (d as number) > 0)
    })
    .map(session => ({ id: session.id, at: sessionStartOf(session) }))
    .filter(session => session.at > lastAt)
    .sort((a, b) => a.at - b.at)
    .map(session => session.id)
}

/**
 * Session start epoch, defensively read from the header. The dream gate is
 * skip-oriented, so an unreadable or absent timestamp conservatively counts as
 * NEW (over-inclusion only costs a re-read). Accepted limitation: a session
 * created before `lastAt` but still active after it is excluded from the dream
 * input — turn-end extraction covers recent content; dream is a coarse
 * periodic pass.
 */
function sessionStartOf(session: { header?: { createdAt?: unknown } }): number {
  const at = session.header?.createdAt
  return Number.isSafeInteger(at) && (at as number) > 0 ? (at as number) : Number.MAX_SAFE_INTEGER
}


/** The transcript directory is the agent's cwd. */
function sessionTranscriptDir(agent: Agent): string {
  return agent.session.header.cwd ?? process.cwd()
}
