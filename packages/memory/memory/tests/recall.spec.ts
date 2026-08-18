import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { extractSelectedNames, MemoryRecall, type MemorySelector } from '../src/recall.ts'
import { FakeMemoryFs } from './helpers.ts'

describe('extractSelectedNames', () => {
  it('parses a bare JSON selected_memories array', () => {
    expect(extractSelectedNames('{"selected_memories": ["a.md", "b.md"]}')).toEqual(['a.md', 'b.md'])
  })

  it('parses an array wrapped in prose and code fences', () => {
    const text = 'Here are the matches:\n```json\n{"selected_memories":["a.md"]}\n```\n'
    expect(extractSelectedNames(text)).toEqual(['a.md'])
  })

  it('returns an empty array for an empty selection', () => {
    expect(extractSelectedNames('{"selected_memories": []}')).toEqual([])
  })

  it('drops non-string entries from the array', () => {
    expect(extractSelectedNames('{"selected_memories": ["a.md", 3, {"x":1}]}')).toEqual(['a.md'])
  })

  it('returns an empty array when the key is absent or unparseable', () => {
    expect(extractSelectedNames('{"other": []}')).toEqual([])
    expect(extractSelectedNames('no json here')).toEqual([])
    expect(extractSelectedNames('{"selected_memories": not-json}')).toEqual([])
  })
})

/** A deterministic record-only selector: returns the deferred selection, echoes tools. */
class RecordingSelector implements MemorySelector {
  readonly recentToolsSeen: string[][] = []
  private readonly deferreds: Array<{ resolve: (v: string[]) => void }> = []

  select(
    _query: string,
    _candidates: Parameters<MemorySelector['select']>[1],
    _signal: AbortSignal,
    recentTools: readonly string[],
  ): Promise<string[]> {
    this.recentToolsSeen.push([...recentTools])
    return new Promise(resolve => this.deferreds.push({ resolve }))
  }

  /** Resolve the latest pending selection so the fire-and-forget recall settles. */
  resolveLatest(selection: string[]): void {
    this.deferreds.shift()?.resolve(selection)
  }
}

/** Wait until the predicate holds, flushing microtasks, or fail on timeout. */
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** A real topic file body (frontmatter + body) the scanner will parse. */
function topicBody(description: string, type: string): string {
  return `---\nname: Bash\ndescription: ${description}\ntype: ${type}\n---\nbody`
}

/** Mount a MemoryRecall with an injectable recording selector over a fake fs. */
async function mount() {
  const ctx = new Context()
  await ctx.plugin(FakeMemoryFs)
  const fs = ctx.fs as FakeMemoryFs
  // The home root is the global layer; the agent's workspace layer resolves
  // to `<home>/projects/<slug>` from its session cwd.
  fs.seed('/root/projects/work-repo/MEMORY.md', '# memory')
  fs.seed('/root/projects/work-repo/bash.md', topicBody('Bash reference documentation', 'reference'))
  const recorder = new RecordingSelector()
  const recall = new MemoryRecall(ctx, '/root', { enabled: true, createSelector: () => recorder })
  return { ctx, recall, recorder, dispose: async () => { recall.dispose(); await ctx.fiber.dispose() } }
}

/** Drive one pre-step so recall runs (fire-and-forget). */
function drivePreStep(ctx: Context): void {
  const agent = { session: { header: { cwd: '/work/repo' } } } as unknown as Agent
  const signal = new AbortController().signal
  void ctx.emit('agent/pre-step', {
    agent,
    messages: [{ content: [{ type: 'text', text: 'how do I use bash?' }] }],
    turn: 1,
    step: 1,
    signal,
  } as never, async () => ({ kind: 'enter', messages: [] }) as never)
}

describe('MemoryRecall recentTools suppression', () => {
  it('records tools from tools/post-execute and passes them to the selector', async () => {
    const { ctx, recall, recorder, dispose } = await mount()
    ctx.emit('tools/post-execute', { name: 'Bash' }, undefined, async () => ({}))
    ctx.emit('tools/post-execute', { name: 'Write' }, undefined, async () => ({}))

    drivePreStep(ctx)
    await until(() => recorder.recentToolsSeen.length > 0, 'selector invocation')
    expect(recorder.recentToolsSeen[0]).toEqual(['Bash', 'Write'])
    recorder.resolveLatest([])
    await dispose()
  })

  it('passes an empty tool list when no tools ran', async () => {
    const { ctx, recorder, dispose } = await mount()
    drivePreStep(ctx)
    await until(() => recorder.recentToolsSeen.length > 0, 'selector invocation')
    expect(recorder.recentToolsSeen[0]).toEqual([])
    recorder.resolveLatest([])
    await dispose()
  })

  it('dispose stops tracking tools from post-execute', async () => {
    const { ctx, recall, recorder, dispose } = await mount()
    recall.dispose()
    ctx.emit('tools/post-execute', { name: 'Bash' }, undefined, async () => ({}))

    drivePreStep(ctx)
    // Give any (should-be-absent) listener a chance to run, then assert none.
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(recorder.recentToolsSeen).toHaveLength(0)
    await dispose()
  })
})
