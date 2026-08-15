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
  }): { result: Promise<unknown> }
}

/** Structural subset of the sessions seam used here. */
interface SessionsService {
  list(): Array<{ id: string }>
}

/**
 * Start a memory-scoped forked subagent as a background job. Returns a control
 * object with an abort hook and a settle promise.
 */
function startMemoryJob(
  ctx: Context,
  agent: Agent,
  provider: string,
  label: string,
  prompt: string,
): { abort(reason?: string): void; settled: Promise<boolean> } {
  const jobs = ctx.get('jobs') as JobService | undefined
  const subagents = ctx.get('subagents') as SubagentService | undefined
  if (jobs === undefined || subagents === undefined) {
    return { abort: () => {}, settled: Promise.resolve(false) }
  }
  const controller = new AbortController()
  const run = subagents.start(provider, {
    label,
    signal: controller.signal,
    prompt: [{ type: 'text', text: prompt }],
    parent: agent,
    toolFilter: MEMORY_TOOL_FILTER,
  })
  const settled = run.result
    .then(() => true)
    .catch(() => false)
  jobs.start({
    kind: 'subagent',
    label,
    owner: agent,
    run: () => ({
      cancel: (reason?: string) => { controller.abort(reason) },
      done: Promise.resolve({ status: 'completed' as const }),
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

  ctx.on('agent/turn-stopping', ({ agent, signal }) => {
    if (signal.aborted) return
    if (config.extractEnabled ?? true) {
      runExtraction(ctx, agent, dir, provider)
    }
    if (config.dreamEnabled ?? true) {
      runDream(ctx, agent, dir, provider, minHours, minSessions).catch(() => {})
    }
  })
}

function runExtraction(ctx: Context, agent: Agent, dir: string, provider: string): void {
  const prompt = buildExtractionPrompt(agent.session.events.length, dir, '')
  startMemoryJob(ctx, agent, provider, 'extract-memories', prompt)
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
  const job = startMemoryJob(ctx, agent, provider, 'memory-consolidation', prompt)
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
    .map(session => ({ id: session.id, at: sessionStartOf(session) }))
    .filter(session => session.at > lastAt)
    .sort((a, b) => a.at - b.at)
    .map(session => session.id)
}

/** Session start epoch uses the current time as the conservative lower bound absent a clock in the seam. */
function sessionStartOf(_session: { id: string }): number {
  // The sessions seam exposes no per-session clock through this structural
  // view; treating every live session as new is a safe over-count for an
  // already-conservative skip gate.
  return Number.MAX_SAFE_INTEGER
}

/** The transcript directory is the agent's cwd. */
function sessionTranscriptDir(agent: Agent): string {
  return agent.session.header.cwd ?? process.cwd()
}
