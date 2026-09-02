/**
 * Tests for the CC-compatible Task tool: subagent_type dispatch over the
 * per-workspace AgentRegistry, persona-based definition delivery, model-alias
 * route resolution, and the toolFilter sanitization that keeps disabled
 * harness rows out of scoped restricts.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@jianxx/dsh-cc-tools'
import { AgentRegistry } from '../src/registry.ts'
import { registerTaskTool, TASK_TOOL } from '../src/tool.ts'

/** A faithfully-capability-checking fake subagents seam (mirrors assertCapabilities). */
interface FakeProvider {
  name: string
  capabilities: { outputSchema: boolean; depthLimit: boolean; toolFilter: boolean; persona: boolean }
  start(request: Record<string, unknown>): Promise<{ result: Promise<{ stopReason: string; output?: readonly { type: string; text?: string }[] }> }>
}

interface StartedRun {
  provider: string
  request: Record<string, unknown>
}

interface FakeRun {
  result: Promise<{ stopReason: string; output?: readonly { type: string; text?: string }[] }>
}

function makeSeam(providers: FakeProvider[]): { seam: unknown; runs: StartedRun[] } {
  const runs: StartedRun[] = []
  const byName = new Map(providers.map(p => [p.name, p]))
  const seam = {
    async start(name: string, request: Record<string, unknown>): Promise<FakeRun> {
      const provider = byName.get(name)
      if (provider === undefined) throw new Error(`unknown provider "${name}"`)
      const caps = provider.capabilities
      if (request['persona'] !== undefined && !caps.persona) throw new Error('UNSUPPORTED_CAPABILITY persona')
      if (request['toolFilter'] !== undefined && !caps.toolFilter) throw new Error('UNSUPPORTED_CAPABILITY toolFilter')
      if (request['maxDepth'] !== undefined && !caps.depthLimit) throw new Error('UNSUPPORTED_CAPABILITY maxDepth')
      if (request['outputSchema'] !== undefined && !caps.outputSchema) throw new Error('UNSUPPORTED_CAPABILITY outputSchema')
      runs.push({ provider: name, request })
      return provider.start(request)
    },
    getProvider(name: string) { return byName.get(name) },
    list() { return [...byName.keys()] },
  }
  return { seam, runs }
}

/** A fork provider with all four capabilities and a captured result. */
function forkProvider(result: { stopReason: string; output?: readonly { type: string; text?: string }[] }): FakeProvider {
  return {
    name: 'fork',
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    start: async () => ({ result: Promise.resolve(result) }),
  }
}

const tmpRoots: string[] = []

function freshWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'task-tool-'))
  tmpRoots.push(dir)
  return dir
}

function writeAgent(root: string, name: string, body: string): void {
  const agents = join(root, '.claude', 'agents')
  mkdirSync(agents, { recursive: true })
  writeFileSync(join(agents, `${name}.md`), body, 'utf8')
}

function agentAt(cwd: string): Agent {
  return { session: { header: { cwd } } } as unknown as Agent
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface ToolCallResult {
  isError: boolean
  content: { type: string; text: string }[]
}

async function mount(opts: {
  routes?: { resolve(model: string | undefined): { provider?: string; model?: string } | undefined }
  seamProviders?: FakeProvider[]
} = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const { seam, runs } = makeSeam(opts.seamProviders ?? [forkProvider({ stopReason: 'completed', output: [{ type: 'text', text: 'done' }] })])
  ctx.provide('subagents', seam)
  if (opts.routes !== undefined) ctx.provide('ccModelRoutes', opts.routes)
  const registry = new AgentRegistry()
  registerTaskTool(ctx, registry)
  return { ctx, runs, registry }
}

let callCounter = 0
async function call(ctx: Context, args: Record<string, unknown>, agent?: Agent) {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: `call-${++callCounter}` as never,
    name: TASK_TOOL,
    arguments: args,
    ...(agent !== undefined ? { agent } : {}),
  })
  return result as ToolCallResult
}

describe('Task tool', () => {
  it('forks plainly when subagent_type is omitted', async () => {
    const { ctx, runs } = await mount()
    const result = await call(ctx, { description: 'do thing', prompt: 'task body' }, agentAt('/any'))
    expect(result.content[0]!.text).toBe('done')
    expect(runs).toHaveLength(1)
    expect(runs[0]!.provider).toBe('fork')
    expect(runs[0]!.request['persona']).toBeUndefined()
    expect(runs[0]!.request['agentOptions']).toBeUndefined()
    expect(runs[0]!.request['prompt']).toEqual([{ type: 'text', text: 'task body' }])
  })

  it('forks plainly for the general-purpose sentinel', async () => {
    const { ctx, runs } = await mount()
    await call(ctx, { subagent_type: 'general-purpose', description: 'x', prompt: 'task' }, agentAt('/any'))
    expect(runs[0]!.provider).toBe('fork')
    expect(runs[0]!.request['persona']).toBeUndefined()
  })

  it('dispatches a workspace definition via persona + resolved route', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'deep-reasoner', '---\nname: deep-reasoner\ndescription: Review heavy work\nmodel: opus\n---\nYou are a Staff Engineer.\n')
    const routes = { resolve: (m: string | undefined) => m === 'opus' ? { provider: 'orchestrix', model: 'glm-5.2' } : undefined }
    const { ctx, runs } = await mount({ routes })
    const result = await call(ctx, { subagent_type: 'deep-reasoner', description: 'review', prompt: 'audit the doc' }, agentAt(ws))
    expect(result.content[0]!.text).toBe('done')
    const req = runs[0]!.request
    expect(req['persona']).toBe('You are a Staff Engineer.')
    expect(req['prompt']).toEqual([{ type: 'text', text: 'audit the doc' }])
    expect(req['agentOptions']).toEqual({ provider: 'orchestrix', model: 'glm-5.2' })
    expect(req['maxDepth']).toBe(3)
  })

  it('omits agentOptions when the model alias resolves to inherit', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'fast-worker', '---\nname: fast-worker\ndescription: Mechanical\nmodel: sonnet\n---\nFast.\n')
    const routes = { resolve: () => undefined }
    const { ctx, runs } = await mount({ routes })
    await call(ctx, { subagent_type: 'fast-worker', description: 'x', prompt: 't' }, agentAt(ws))
    expect(runs[0]!.request['agentOptions']).toBeUndefined()
  })

  it('stamps the alias-resolved reasoningEffort onto agentOptions', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'deep-reasoner', '---\nname: deep-reasoner\ndescription: Review heavy work\nmodel: opus\n---\nYou are a Staff Engineer.\n')
    const routes = {
      resolve: (m: string | undefined) => m === 'opus'
        ? { provider: 'orchestrix', model: 'glm-5.3', reasoningEffort: 'max' }
        : undefined,
    }
    const { ctx, runs } = await mount({ routes })
    await call(ctx, { subagent_type: 'deep-reasoner', description: 'review', prompt: 'audit' }, agentAt(ws))
    expect(runs[0]!.request['agentOptions']).toEqual({
      provider: 'orchestrix',
      model: 'glm-5.3',
      reasoningEffort: 'max',
    })
  })

  it('stamps effort for a provider-less route (provider omitted from agentOptions)', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'fast-worker', '---\nname: fast-worker\ndescription: Mechanical\nmodel: sonnet\n---\nFast.\n')
    const routes = {
      resolve: (m: string | undefined) => m === 'sonnet'
        ? { model: 'glm-5.3-flash', reasoningEffort: 'max' }
        : undefined,
    }
    const { ctx, runs } = await mount({ routes })
    await call(ctx, { subagent_type: 'fast-worker', description: 'x', prompt: 't' }, agentAt(ws))
    expect(runs[0]!.request['agentOptions']).toEqual({ model: 'glm-5.3-flash', reasoningEffort: 'max' })
  })

  it('inherit still omits agentOptions entirely even when a sibling alias carries effort', async () => {
    const ws = freshWorkspace()
    // fast-worker resolves to inherit; the effort-carrying alias is never consulted.
    writeAgent(ws, 'fast-worker', '---\nname: fast-worker\ndescription: Mechanical\nmodel: sonnet\n---\nFast.\n')
    const routes = {
      resolve: (m: string | undefined) => m === 'opus'
        ? { provider: 'orchestrix', model: 'glm-5.3', reasoningEffort: 'max' }
        : undefined,
    }
    const { ctx, runs } = await mount({ routes })
    await call(ctx, { subagent_type: 'fast-worker', description: 'x', prompt: 't' }, agentAt(ws))
    expect(runs[0]!.request['agentOptions']).toBeUndefined()
  })

  it('works when no ccModelRoutes service is mounted', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'plain', '---\nname: plain\ndescription: No model\n---\nPlain.\n')
    const { ctx, runs } = await mount()
    const result = await call(ctx, { subagent_type: 'plain', description: 'x', prompt: 't' }, agentAt(ws))
    expect(result.content[0]!.text).toBe('done')
    expect(runs[0]!.request['persona']).toBe('Plain.')
  })

  it('errors with the available type list for an unknown subagent_type', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'deep-reasoner', '---\nname: deep-reasoner\ndescription: Review\n---\nBody.\n')
    const { ctx, runs } = await mount()
    const first = await call(ctx, { subagent_type: 'nope', description: 'x', prompt: 't' }, agentAt(ws))
    expect(first.isError).toBe(true)
    expect(first.content[0]!.text).toMatch(/unknown subagent_type "nope"/)
    expect(first.content[0]!.text).toMatch(/deep-reasoner/)
    expect(runs).toHaveLength(0)
  })

  it('maps a child failure stopReason to an isError result', async () => {
    const seamProviders = [forkProvider({ stopReason: 'error' })]
    const { ctx } = await mount({ seamProviders })
    const result = await call(ctx, { description: 'x', prompt: 't' }, agentAt('/any'))
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/stopped with reason "error"/)
  })

  it('extracts only text blocks from the child output', async () => {
    const seamProviders = [forkProvider({ stopReason: 'completed', output: [
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'answer A' },
      { type: 'text', text: ' answer B' },
    ] })]
    const { ctx } = await mount({ seamProviders })
    const result = await call(ctx, { description: 'x', prompt: 't' }, agentAt('/any'))
    expect(result.content[0]!.text).toBe('answer A answer B')
  })

  it('keeps reserved names and strips unknown names from a definition toolFilter', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'guarded', '---\nname: guarded\ndescription: With tools\ntools: [Read, Task, Bash]\n---\nGuarded.\n')
    // `Task` translates to ['subagent', 'subagent_fork']; `subagent` is
    // reserved (not registered) but legal, `subagent_fork` is this tool, and
    // both `read` and `bash` are registered rows in the cc preset. Nothing is
    // stripped; the child's own restrict would reject a typo'd name.
    const { ctx, runs } = await mount()
    await call(ctx, { subagent_type: 'guarded', description: 'x', prompt: 't' }, agentAt(ws))
    expect(runs).toHaveLength(1)
    const filter = runs[0]!.request['toolFilter'] as { allow?: string[]; deny?: string[] } | undefined
    expect(filter?.allow).toBeDefined()
    expect(filter?.allow).toContain('subagent')
    expect(filter?.allow).toContain('subagent_fork')
  })

  it('drops a frontmatter name with no harness translation (typo defence)', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'typoed', '---\nname: typoed\ndescription: Typo\ntools: [Read, Tas]\n---\nTypo.\n')
    const { ctx, runs } = await mount()
    await call(ctx, { subagent_type: 'typoed', description: 'x', prompt: 't' }, agentAt(ws))
    const filter = runs[0]!.request['toolFilter'] as { allow?: string[]; deny?: string[] } | undefined
    expect(filter?.allow).toBeDefined()
    expect(filter?.allow).not.toContain('Tas')
  })

  it('requires a calling agent', async () => {
    const { ctx } = await mount()
    const result = await call(ctx, { description: 'x', prompt: 't' })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/agent/)
  })
})
