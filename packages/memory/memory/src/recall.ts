/**
 * Dynamic recall: an `agent/pre-step` listener that asks a small-model side
 * query (a forked subagent) which topic files are relevant to the turn, then
 * injects their bodies through `agent.inject()`. Topic files already shown
 * this session are never re-injected. Best-effort: absence of the subagent
 * service or provider skips recall without error.
 * @module @jianxx/dsh-cc-memory/recall
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { scanMemoryDirectory } from './scan.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    memory: { kind: 'memory' }
  }
}

/** How many topic files the selector may surface per query. */
export const MAX_RECALL_MEMORIES = 5

/** One topic file offered to the selector. */
export interface RecallCandidate {
  path: string
  filename: string
  description: string
}

/** The async relevance selector contract, injectable for tests. */
export interface MemorySelector {
  /**
   * Pick at most {@link MAX_RECALL_MEMORIES} filenames relevant to a query.
   * @param query - the user turn text.
   * @param candidates - topic files (filename + description) not yet shown.
   * @param signal - cancellation for the underlying model request.
   * @returns selected filenames.
   */
  select(
    query: string,
    candidates: readonly RecallCandidate[],
    signal: AbortSignal,
  ): Promise<string[]>
}

/**
 * Default selector backed by `ctx.subagents`: asks a forked small-model
 * one-shot subagent to return the filenames most useful for the query. The
 * parent agent is supplied per query so the child seeds from the right turn.
 */
export class SubagentMemorySelector implements MemorySelector {
  /**
   * Create a subagent-backed selector for one parent agent.
   * @param ctx - host context with the optional `subagents` service.
   * @param parent - the agent whose turn triggers recall.
   * @param providerName - the one-shot provider to fork (default `fork`).
   * @param agentOptions - optional model selection passed to the child.
   */
  constructor(
    private readonly ctx: Context,
    private readonly parent: Agent,
    private readonly providerName = 'fork',
    private readonly agentOptions?: unknown,
  ) {}

  async select(query: string, candidates: readonly RecallCandidate[], signal: AbortSignal): Promise<string[]> {
    const subagents = this.ctx.get('subagents') as SubagentLike | undefined
    if (subagents === undefined) return []
    const manifest = candidates
      .map(candidate => `- ${candidate.filename}: ${candidate.description}`)
      .join('\n')
    const system = [
      'You select memories useful for processing a user query.',
      `Return a JSON object with a "selected_memories" array of filenames (at most ${MAX_RECALL_MEMORIES}).`,
      'Only include memories you are certain are helpful. If none are clearly useful, return an empty array.',
    ].join('\n')
    let run
    try {
      run = await subagents.start(this.providerName, {
        label: 'memory-recall',
        signal,
        prompt: [{ type: 'text', text: `${system}\n\nQuery: ${query}\n\nAvailable memories:\n${manifest}` }],
        parent: this.parent,
        ...(this.agentOptions !== undefined ? { agentOptions: this.agentOptions } : {}),
      })
    } catch {
      // Provider absent or services unavailable: best-effort recall skips.
      return []
    }
    const result = await run.result
    if (result.stopReason === 'error') return []
    const text = result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
    const names = extractSelectedNames(text)
    const valid = new Set(candidates.map(candidate => candidate.filename))
    return names.filter(name => valid.has(name)).slice(0, MAX_RECALL_MEMORIES)
  }
}

/** Structural subset of the subagent seam used by the selector. */
interface SubagentLike {
  start(name: string, request: {
    label?: string
    prompt: readonly { type: 'text'; text: string }[]
    parent: Agent
    signal: AbortSignal
    agentOptions?: unknown
  }): Promise<{
    result: Promise<{ stopReason: string; content: readonly { type: string; text?: string }[] }>
  }>
}

/** Loose JSON extraction tolerant of code fences and prose around the array. */
export function extractSelectedNames(text: string): string[] {
  const match = /"selected_memories"\s*:\s*(\[[^\]]*\])/.exec(text)
  const encoded = match?.[1]
  if (encoded === undefined) return []
  try {
    const parsed = JSON.parse(encoded) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : []
  } catch {
    return []
  }
}

/** The per-agent recall coordinator. Holds the shown-path set per agent. */
export class MemoryRecall {
  private readonly state = new WeakMap<Agent, { shown: Set<string> }>()
  private readonly providerName: string

  /**
   * Register the `agent/pre-step` listener.
   * @param ctx - host context with `fs`, `subagents`, and the agent channel.
   * @param dir - the memory directory to scan.
   * @param options - provider name and whether recall is enabled.
   */
  constructor(
    private readonly ctx: Context,
    private readonly dir: string,
    options: { providerName?: string; enabled?: boolean } = {},
  ) {
    this.providerName = options.providerName ?? 'fork'
    if (options.enabled ?? true) {
      this.ctx.on('agent/pre-step', (payload, next) => this.onPreStep(payload, next))
    }
  }

  private async onPreStep(
    {
      agent,
      messages,
      signal,
    }: {
      agent: Agent
      messages: ReadonlyArray<{ content: readonly { type: string; text?: string }[] }>
      signal: AbortSignal
    },
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision> {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    signal.throwIfAborted()
    void this.maybeRecall(agent, messages, signal, new SubagentMemorySelector(this.ctx, agent, this.providerName))
    return decision
  }

  private async maybeRecall(
    agent: Agent,
    messages: ReadonlyArray<{ content: readonly { type: string; text?: string }[] }>,
    signal: AbortSignal,
    selector: MemorySelector,
  ): Promise<void> {
    const fileSystem = this.ctx.get('fs')
    if (fileSystem === undefined) return
    const query = messages
      .map(message => message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join(' '))
      .join('\n')
      .trim()
    if (query.length === 0) return
    const scan = await scanMemoryDirectory(fileSystem, this.dir, signal)
    if (scan.topics.length === 0) return
    let shown = this.state.get(agent)
    if (shown === undefined) {
      shown = { shown: new Set() }
      this.state.set(agent, shown)
    }
    const fresh = scan.topics.filter(topic => !shown.shown.has(topic.path))
    if (fresh.length === 0) return
    const selected = await selector.select(
      query,
      fresh.map(topic => ({ path: topic.path, filename: topic.filename, description: topic.frontmatter.description })),
      signal,
    )
    if (signal.aborted || selected.length === 0) return
    const byFilename = new Map(scan.topics.map(topic => [topic.filename, topic]))
    const bodies: string[] = []
    for (const filename of selected) {
      const topic = byFilename.get(filename)
      if (topic === undefined) continue
      shown.shown.add(topic.path)
      const raw = await readOptionalText(fileSystem, topic.path, signal)
      if (raw !== undefined && raw.trim().length > 0) {
        bodies.push(`## Memory: ${topic.frontmatter.name}\n\n${raw.trim()}`)
      }
    }
    signal.throwIfAborted()
    if (bodies.length === 0) return
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: bodies.join('\n\n') }],
      source: { kind: 'memory' },
    }))
  }
}

async function readOptionalText(fs: FileSystem, path: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const target = signal !== undefined
      ? await fs.resolve(path, { signal })
      : await fs.resolve(path)
    return await fs.readText(target, signal)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error
      && ((error as { code?: string }).code === 'FS_NOT_FOUND'
        || (error as { code?: string }).code === 'ENOENT')) return undefined
    throw error
  }
}
