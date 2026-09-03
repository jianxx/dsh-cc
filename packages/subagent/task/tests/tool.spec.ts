/**
 * Tests for the CC-compatible Task tool: subagent_type dispatch over the
 * per-workspace AgentRegistry, persona-based definition delivery, model-alias
 * route resolution, and the toolFilter sanitization that keeps disabled
 * harness rows out of scoped restricts.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@jianxx/dsh-cc-tools'
import type { ToolRestriction } from '@jianxx/dsh-cc-claude-code-agents'
import { AgentRegistry } from '../src/registry.ts'
import { registerTaskTool, TASK_TOOL } from '../src/tool.ts'

/** A faithfully-capability-checking fake subagents seam (mirrors assertCapabilities). */
interface FakeProvider {
  name: string
  capabilities: { outputSchema: boolean; depthLimit: boolean; toolFilter: boolean; persona: boolean }
  /** Present only on providers implementing the continuable-creation capability. */
  prepareContinuable?: () => Promise<unknown>
  start(request: Record<string, unknown>): Promise<{ result: Promise<{ stopReason: string; output?: readonly { type: string; text?: string }[] }> }>
}

/** One recorded `startContinuable` call (the background dispatch path). */
interface RecordedContinuable {
  provider: string
  label: string
  request: Record<string, unknown>
}

interface StartedRun {
  provider: string
  request: Record<string, unknown>
}

interface FakeRun {
  result: Promise<{ stopReason: string; output?: readonly { type: string; text?: string }[] }>
}

function makeSeam(providers: FakeProvider[]): { seam: unknown; runs: StartedRun[]; continuableStarts: RecordedContinuable[] } {
  const runs: StartedRun[] = []
  const continuableStarts: RecordedContinuable[] = []
  const byName = new Map(providers.map(p => [p.name, p]))
  const seam: Record<string, unknown> = {
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
    async startContinuable(spec: Record<string, unknown>): Promise<{ childId: string; messageId: string }> {
      const providerName = spec['provider'] as string
      const provider = byName.get(providerName)
      if (provider === undefined) throw new Error(`unknown provider "${providerName}"`)
      if (provider.prepareContinuable === undefined) {
        const error = new Error(
          `subagent provider "${providerName}" does not support continuable children (no prepareContinuable capability)`,
        ) as Error & { code?: string }
        error.code = 'UNSUPPORTED_CAPABILITY'
        throw error
      }
      continuableStarts.push({
        provider: providerName,
        label: spec['label'] as string,
        request: spec['request'] as Record<string, unknown>,
      })
      return { childId: 'child-1', messageId: 'm-1' }
    },
    getProvider(name: string) { return byName.get(name) },
    list() { return [...byName.keys()] },
  }
  return { seam, runs, continuableStarts }
}

/** A capable in-process provider with a captured result. */
function capableProvider(
  name: string,
  result: { stopReason: string; output?: readonly { type: string; text?: string }[] },
  continuable = false,
): FakeProvider {
  return {
    name,
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    ...(continuable ? { prepareContinuable: async () => ({}) } : {}),
    start: async () => ({ result: Promise.resolve(result) }),
  }
}

const COMPLETED = { stopReason: 'completed', output: [{ type: 'text', text: 'done' }] } as const

/** The two in-process providers a Task dispatch can legally name. */
function defaultProviders(
  result: { stopReason: string; output?: readonly { type: string; text?: string }[] } = COMPLETED,
): FakeProvider[] {
  return [capableProvider('spawn', result, true), capableProvider('fork', result)]
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
  omitStartContinuable?: boolean
} = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const { seam, runs, continuableStarts } = makeSeam(opts.seamProviders ?? defaultProviders())
  if (opts.omitStartContinuable === true) delete (seam as Record<string, unknown>)['startContinuable']
  ctx.provide('subagents', seam)
  if (opts.routes !== undefined) ctx.provide('ccModelRoutes', opts.routes)
  const registry = new AgentRegistry()
  registerTaskTool(ctx, registry)
  return { ctx, runs, continuableStarts, registry }
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

/** Reserve names on the host tool registry so a scoped `restrict()` accepts them. */
function reserveNames(ctx: Context, ...names: string[]): void {
  for (const name of names) ctx.tools.reserve(name)
}

/** Replace (or install) the context logger's warn with a captured vi.fn. */
function captureWarn(ctx: Context): ReturnType<typeof vi.fn> {
  const warn = vi.fn()
  const existing = (ctx as { logger?: Record<string, unknown> }).logger
  ;(ctx as { logger: Record<string, unknown> }).logger = { ...existing, warn }
  return warn
}

let restrictCounter = 0
/**
 * Mint a scoped child context (the same pattern tool-search's `mintAgent`
 * uses) and apply the filter through a real scoped `restrict()` — it must
 * NOT throw. Without this, a filter carrying an unrestrictable name would
 * only fail later at the child's own start.
 */
async function assertRestrictable(ctx: Context, filter: ToolRestriction): Promise<void> {
  // The scope key is opaque to dsh-scope; a plain unique string is a legal
  // key (SessionId branding is irrelevant to restrict()).
  const agent = { id: `restrict-${++restrictCounter}` } as Agent
  let scope!: Scope
  const fiber = ctx.plugin(Object.assign((inner: Context) => {
    scope = createScope(inner, agent)
  }, { inject: ['tools'] }))
  await fiber.await()
  try {
    expect(() => scope.ctx.tools.restrict(filter)).not.toThrow()
  } finally {
    await scope.dispose()
  }
}

describe('Task tool', () => {
  it('spawns a fresh child when subagent_type is omitted', async () => {
    const { ctx, runs } = await mount()
    const result = await call(ctx, { description: 'do thing', prompt: 'task body' }, agentAt('/any'))
    expect(result.content[0]!.text).toBe('done')
    expect(runs).toHaveLength(1)
    expect(runs[0]!.provider).toBe('spawn')
    expect(runs[0]!.request['persona']).toBeUndefined()
    expect(runs[0]!.request['agentOptions']).toBeUndefined()
    expect(runs[0]!.request['toolFilter']).toBeUndefined()
    expect(runs[0]!.request['prompt']).toEqual([{ type: 'text', text: 'task body' }])
  })

  it('spawns a fresh child for the general-purpose sentinel', async () => {
    const { ctx, runs } = await mount()
    await call(ctx, { subagent_type: 'general-purpose', description: 'x', prompt: 'task' }, agentAt('/any'))
    expect(runs[0]!.provider).toBe('spawn')
    expect(runs[0]!.request['persona']).toBeUndefined()
    expect(runs[0]!.request['toolFilter']).toBeUndefined()
  })

  it('spawns a fresh child for a blank subagent_type', async () => {
    const { ctx, runs } = await mount()
    await call(ctx, { subagent_type: '   ', description: 'x', prompt: 'task' }, agentAt('/any'))
    expect(runs[0]!.provider).toBe('spawn')
    expect(runs[0]!.request['persona']).toBeUndefined()
  })

  it('the fork sentinel inherits completed parent turns and never consults the registry', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'fork', '---\nname: fork\ndescription: A file named fork\n---\nUnreachable.\n')
    const { ctx, runs, registry } = await mount()
    const resolve = vi.spyOn(registry, 'resolve')
    await call(ctx, { subagent_type: 'fork', description: 'x', prompt: 'task' }, agentAt(ws))
    expect(runs[0]!.provider).toBe('fork')
    expect(runs[0]!.request['persona']).toBeUndefined()
    expect(runs[0]!.request['toolFilter']).toBeUndefined()
    expect(runs[0]!.request['prompt']).toEqual([{ type: 'text', text: 'task' }])
    expect(resolve).not.toHaveBeenCalled()
  })

  it('dispatches a workspace definition via persona + resolved route', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'deep-reasoner', '---\nname: deep-reasoner\ndescription: Review heavy work\nmodel: opus\n---\nYou are a Staff Engineer.\n')
    const routes = { resolve: (m: string | undefined) => m === 'opus' ? { provider: 'orchestrix', model: 'glm-5.2' } : undefined }
    const { ctx, runs } = await mount({ routes })
    const result = await call(ctx, { subagent_type: 'deep-reasoner', description: 'review', prompt: 'audit the doc' }, agentAt(ws))
    expect(result.content[0]!.text).toBe('done')
    expect(runs[0]!.provider).toBe('spawn')
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
    expect(first.content[0]!.text).toMatch(/explore/)
    expect(runs).toHaveLength(0)
  })

  it('dispatches the bundled explore agent on a bare workspace with haiku route stamps', async () => {
    const ws = freshWorkspace()
    const routes = { resolve: (m: string | undefined) => m === 'haiku' ? { provider: 'p', model: 'cheap' } : undefined }
    const { ctx, runs } = await mount({ routes })
    reserveNames(ctx, 'read', 'read_image', 'glob', 'grep')
    const result = await call(ctx, { subagent_type: 'explore', description: 'find it', prompt: 'where is X defined?' }, agentAt(ws))
    expect(result.content[0]!.text).toBe('done')
    expect(runs[0]!.request['agentOptions']).toEqual({ provider: 'p', model: 'cheap' })
    expect(runs[0]!.request['persona']).toContain('read-only codebase scout')
    const filter = runs[0]!.request['toolFilter'] as { allow?: string[] } | undefined
    expect(filter?.allow).toEqual(expect.arrayContaining(['read', 'read_image', 'glob', 'grep']))
    expect(filter?.allow?.includes('write')).toBe(false)
    await assertRestrictable(ctx, filter as ToolRestriction)
  })

  it('omits agentOptions for a bundled agent when the alias does not resolve', async () => {
    const ws = freshWorkspace()
    const routes = { resolve: () => undefined }
    const { ctx, runs } = await mount({ routes })
    reserveNames(ctx, 'read', 'read_image', 'glob', 'grep')
    await call(ctx, { subagent_type: 'explore', description: 'x', prompt: 't' }, agentAt(ws))
    expect(runs[0]!.request['agentOptions']).toBeUndefined()
  })

  it('maps a child failure stopReason to an isError result', async () => {
    const seamProviders = defaultProviders({ stopReason: 'error' })
    const { ctx } = await mount({ seamProviders })
    const result = await call(ctx, { description: 'x', prompt: 't' }, agentAt('/any'))
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/stopped with reason "error"/)
  })

  it('extracts only text blocks from the child output', async () => {
    const seamProviders = defaultProviders({ stopReason: 'completed', output: [
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'answer A' },
      { type: 'text', text: ' answer B' },
    ] })
    const { ctx } = await mount({ seamProviders })
    const result = await call(ctx, { description: 'x', prompt: 't' }, agentAt('/any'))
    expect(result.content[0]!.text).toBe('answer A answer B')
  })

  it('keeps reserved and registered names in a definition toolFilter', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'guarded', '---\nname: guarded\ndescription: With tools\ntools: [Read, Task, Bash]\n---\nGuarded.\n')
    // `Task` translates to ['subagent', 'subagent_fork']; `subagent` is
    // reserved by registerTaskTool and `subagent_fork` is the registered Task
    // tool. `read`/`read_image`/`bash` must be mounted (registered or
    // reserved) or sanitization drops them — here they are reserved, as the
    // cc preset registers them.
    const { ctx, runs } = await mount()
    reserveNames(ctx, 'read', 'read_image', 'bash')
    await call(ctx, { subagent_type: 'guarded', description: 'x', prompt: 't' }, agentAt(ws))
    expect(runs).toHaveLength(1)
    const filter = runs[0]!.request['toolFilter'] as { allow?: string[]; deny?: string[] } | undefined
    expect(filter?.allow).toBeDefined()
    expect(filter?.allow).toContain('read')
    expect(filter?.allow).toContain('read_image')
    expect(filter?.allow).toContain('subagent')
    expect(filter?.allow).toContain('subagent_fork')
    expect(filter?.allow).toContain('bash')
    await assertRestrictable(ctx, filter!)
  })

  it('drops a frontmatter name that is not mounted (typo defence)', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'typoed', '---\nname: typoed\ndescription: Typo\ntools: [Read, Tas]\n---\nTypo.\n')
    const { ctx, runs } = await mount()
    reserveNames(ctx, 'read', 'read_image')
    await call(ctx, { subagent_type: 'typoed', description: 'x', prompt: 't' }, agentAt(ws))
    const filter = runs[0]!.request['toolFilter'] as { allow?: string[]; deny?: string[] } | undefined
    expect(filter?.allow).toEqual(['read', 'read_image'])
  })

  it('keeps an exact mounted MCP public name and auto-includes mounted ToolSearch', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'mcp-user', '---\nname: mcp-user\ndescription: MCP\ntools: [Read, mcp__github__create_issue]\n---\nMCP.\n')
    const { ctx, runs } = await mount()
    reserveNames(ctx, 'mcp__github__create_issue', 'mcp__github__search', 'read', 'read_image', 'ToolSearch')
    const warn = captureWarn(ctx)
    await call(ctx, { subagent_type: 'mcp-user', description: 'x', prompt: 't' }, agentAt(ws))
    const filter = runs[0]!.request['toolFilter'] as { allow?: string[]; deny?: string[] } | undefined
    expect(filter?.allow).toContain('read')
    expect(filter?.allow).toContain('read_image')
    expect(filter?.allow).toContain('mcp__github__create_issue')
    expect(filter?.allow).toContain('ToolSearch')
    expect(filter?.allow).not.toContain('mcp__github__search')
    expect(warn).not.toHaveBeenCalled()
    await assertRestrictable(ctx, filter!)
  })

  it('expands server-level MCP wildcards in both forms and auto-includes mounted ToolSearch', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'wild-a', '---\nname: wild-a\ndescription: A\ntools: [mcp__github]\n---\nA.\n')
    writeAgent(ws, 'wild-b', '---\nname: wild-b\ndescription: B\ntools: [mcp__github__*]\n---\nB.\n')
    const { ctx, runs } = await mount()
    reserveNames(ctx, 'mcp__github__create_issue', 'mcp__github__search', 'ToolSearch')
    await call(ctx, { subagent_type: 'wild-a', description: 'x', prompt: 't' }, agentAt(ws))
    await call(ctx, { subagent_type: 'wild-b', description: 'x', prompt: 't' }, agentAt(ws))
    for (const run of runs) {
      const filter = run.request['toolFilter'] as { allow?: string[] } | undefined
      expect(filter?.allow).toContain('mcp__github__create_issue')
      expect(filter?.allow).toContain('mcp__github__search')
      expect(filter?.allow).toContain('ToolSearch')
      await assertRestrictable(ctx, filter as ToolRestriction)
    }
  })

  it('sees MCP names reserved on an ancestor standing-scope layer', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'mcp-user', '---\nname: mcp-user\ndescription: MCP\ntools: [mcp__github__create_issue]\n---\nMCP.\n')
    const { ctx, runs } = await mount()
    // Production shape: mcp-client registers on the cc standing-scope layer,
    // and the calling session agent is a child of that standing key. `view()`
    // without the calling agent only sees the global layer and would drop
    // those names.
    const standingKey = { id: 'standing' } as Agent
    const caller = agentAt(ws)
    let standing!: Scope
    let child!: Scope
    const fiber = ctx.plugin(Object.assign((inner: Context) => {
      standing = createScope(inner, standingKey)
      child = createScope(inner, caller, { parent: standingKey })
    }, { inject: ['tools'] }))
    await fiber.await()
    standing.ctx.tools.reserve('mcp__github__create_issue')
    standing.ctx.tools.reserve('ToolSearch')
    await call(ctx, { subagent_type: 'mcp-user', description: 'x', prompt: 't' }, caller)
    const filter = runs[0]!.request['toolFilter'] as { allow?: string[]; deny?: string[] } | undefined
    expect(filter?.allow).toContain('mcp__github__create_issue')
    expect(filter?.allow).toContain('ToolSearch')
    await child.dispose()
    await standing.dispose()
  })

  it('never auto-includes ToolSearch when it is not mounted', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'mcp-user', '---\nname: mcp-user\ndescription: MCP\ntools: [mcp__github__create_issue]\n---\nMCP.\n')
    const { ctx, runs } = await mount()
    reserveNames(ctx, 'mcp__github__create_issue')
    await call(ctx, { subagent_type: 'mcp-user', description: 'x', prompt: 't' }, agentAt(ws))
    const filter = runs[0]!.request['toolFilter'] as { allow?: string[]; deny?: string[] } | undefined
    expect(filter?.allow).toContain('mcp__github__create_issue')
    expect(filter?.allow).not.toContain('ToolSearch')
    await assertRestrictable(ctx, filter!)
  })

  it('emits a deny-all allow list (with a warning) when the allow-list matches no mounted tools', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'missing', '---\nname: missing\ndescription: M\ntools: [mcp__missing__foo]\n---\nM.\n')
    const { ctx, runs } = await mount()
    const warn = captureWarn(ctx)
    await call(ctx, { subagent_type: 'missing', description: 'x', prompt: 't' }, agentAt(ws))
    const filter = runs[0]!.request['toolFilter'] as { allow?: string[]; deny?: string[] } | undefined
    expect(filter).toEqual({ allow: [] })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('mcp__missing__foo'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no mounted tools'))
    await assertRestrictable(ctx, filter!)
  })

  it('keeps a mounted MCP name in a disallowedTools deny-list', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'mcp-denied', '---\nname: mcp-denied\ndescription: D\ndisallowedTools: [mcp__github__search]\n---\nD.\n')
    const { ctx, runs } = await mount()
    reserveNames(ctx, 'mcp__github__search')
    await call(ctx, { subagent_type: 'mcp-denied', description: 'x', prompt: 't' }, agentAt(ws))
    const filter = runs[0]!.request['toolFilter'] as { allow?: string[]; deny?: string[] } | undefined
    expect(filter?.deny).toContain('mcp__github__search')
    await assertRestrictable(ctx, filter!)
  })

  it('passes no toolFilter when the definition declares no tools key', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'plain', '---\nname: plain\ndescription: P\n---\nP.\n')
    const { ctx, runs } = await mount()
    await call(ctx, { subagent_type: 'plain', description: 'x', prompt: 't' }, agentAt(ws))
    expect(runs[0]!.request['toolFilter']).toBeUndefined()
  })

  it('rejects a bare mcp__ wildcard with a deny-all allow list', async () => {
    const ws = freshWorkspace()
    writeAgent(ws, 'bare', '---\nname: bare\ndescription: B\ntools: [mcp__]\n---\nB.\n')
    const { ctx, runs } = await mount()
    const warn = captureWarn(ctx)
    await call(ctx, { subagent_type: 'bare', description: 'x', prompt: 't' }, agentAt(ws))
    const filter = runs[0]!.request['toolFilter'] as { allow?: string[]; deny?: string[] } | undefined
    expect(filter).toEqual({ allow: [] })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid MCP wildcard'))
    await assertRestrictable(ctx, filter!)
  })

  it('requires a calling agent', async () => {
    const { ctx } = await mount()
    const result = await call(ctx, { description: 'x', prompt: 't' })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toMatch(/agent/)
  })

  describe('run_in_background', () => {
    it('starts a continuable child on spawn and returns the durable id without awaiting a result', async () => {
      const { ctx, runs, continuableStarts } = await mount()
      const result = await call(ctx, {
        description: 'long work',
        prompt: 'grind in the background',
        run_in_background: true,
      }, agentAt('/any'))
      expect(result.isError).toBe(false)
      expect(runs).toHaveLength(0)
      expect(continuableStarts).toHaveLength(1)
      const start = continuableStarts[0]!
      expect(start.provider).toBe('spawn')
      expect(start.label).toBe('long work')
      expect(start.request['prompt']).toEqual([{ type: 'text', text: 'grind in the background' }])
      expect(start.request['maxDepth']).toBe(3)
      expect(start.request['persona']).toBeUndefined()
      expect(start.request['agentOptions']).toBeUndefined()
      expect(start.request['toolFilter']).toBeUndefined()
      expect(result.content[0]!.text).toContain('child-1')
      expect(result.content[0]!.text).toContain('list_agents')
      expect(result.content[0]!.text).toContain('send_message')
      expect(result.content[0]!.text).toContain('interrupt_agent')
      expect(JSON.stringify(result)).not.toContain('outputFile')
    })

    it('folds a named definition exactly like the foreground path into the continuable request', async () => {
      const ws = freshWorkspace()
      writeAgent(ws, 'deep-reasoner', '---\nname: deep-reasoner\ndescription: Review heavy work\nmodel: opus\ntools: [Read, Bash]\n---\nYou are a Staff Engineer.\n')
      const routes = { resolve: (m: string | undefined) => m === 'opus' ? { provider: 'orchestrix', model: 'glm-5.2' } : undefined }
      const { ctx, runs, continuableStarts } = await mount({ routes })
      reserveNames(ctx, 'read', 'bash')
      await call(ctx, {
        subagent_type: 'deep-reasoner',
        description: 'review',
        prompt: 'audit the doc',
        run_in_background: true,
      }, agentAt(ws))
      expect(runs).toHaveLength(0)
      expect(continuableStarts[0]!.provider).toBe('spawn')
      const req = continuableStarts[0]!.request
      expect(req['persona']).toBe('You are a Staff Engineer.')
      expect(req['prompt']).toEqual([{ type: 'text', text: 'audit the doc' }])
      expect(req['agentOptions']).toEqual({ provider: 'orchestrix', model: 'glm-5.2' })
      expect(req['maxDepth']).toBe(3)
      const filter = req['toolFilter'] as { allow?: string[] }
      expect(filter.allow).toEqual(expect.arrayContaining(['read', 'bash']))
      await assertRestrictable(ctx, filter as ToolRestriction)
    })

    it('rejects fork + background before touching the seam, naming issue #2124 and the workaround', async () => {
      const { ctx, runs, continuableStarts } = await mount()
      const result = await call(ctx, {
        subagent_type: 'fork',
        description: 'x',
        prompt: 't',
        run_in_background: true,
      }, agentAt('/any'))
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toMatch(/2124/)
      expect(result.content[0]!.text).toMatch(/run_in_background|background/)
      expect(runs).toHaveLength(0)
      expect(continuableStarts).toHaveLength(0)
    })

    it('errors with the available type list for an unknown background type', async () => {
      const ws = freshWorkspace()
      writeAgent(ws, 'deep-reasoner', '---\nname: deep-reasoner\ndescription: Review\n---\nBody.\n')
      const { ctx, runs, continuableStarts } = await mount()
      const result = await call(ctx, {
        subagent_type: 'nope',
        description: 'x',
        prompt: 't',
        run_in_background: true,
      }, agentAt(ws))
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toMatch(/unknown subagent_type "nope"/)
      expect(result.content[0]!.text).toMatch(/deep-reasoner/)
      expect(runs).toHaveLength(0)
      expect(continuableStarts).toHaveLength(0)
    })

    it('maps a provider without prepareContinuable to an actionable capability error', async () => {
      const seamProviders = defaultProviders().map(p =>
        p.name === 'spawn' ? { ...p, prepareContinuable: undefined } : p,
      )
      const { ctx, runs, continuableStarts } = await mount({ seamProviders })
      const result = await call(ctx, { description: 'x', prompt: 't', run_in_background: true }, agentAt('/any'))
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toMatch(/UNSUPPORTED_CAPABILITY/)
      expect(result.content[0]!.text).toMatch(/background subagent/i)
      expect(result.content[0]!.text).toMatch(/prepareContinuable|capability/i)
      expect(runs).toHaveLength(0)
      expect(continuableStarts).toHaveLength(0)
    })

    it('maps a seam without startContinuable to an actionable capability error', async () => {
      const { ctx, runs } = await mount({ omitStartContinuable: true })
      const result = await call(ctx, { description: 'x', prompt: 't', run_in_background: true }, agentAt('/any'))
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toMatch(/background subagent/i)
      expect(result.content[0]!.text).toMatch(/capabilit|continuable/i)
      expect(runs).toHaveLength(0)
    })

    it('keeps the foreground path byte-identical when run_in_background is absent or false', async () => {
      const { ctx, runs, continuableStarts } = await mount()
      const omitted = await call(ctx, { description: 'x', prompt: 't' }, agentAt('/any'))
      const explicitFalse = await call(ctx, { description: 'x', prompt: 't', run_in_background: false }, agentAt('/any'))
      expect(omitted.content[0]!.text).toBe('done')
      expect(explicitFalse.content[0]!.text).toBe('done')
      expect(runs).toHaveLength(2)
      expect(runs.every(r => r.provider === 'spawn')).toBe(true)
      expect(continuableStarts).toHaveLength(0)
    })

    it('renders the background contract text naming the durable id and the control loop', async () => {
      const { ctx } = await mount()
      const result = await call(ctx, { description: 'x', prompt: 't', run_in_background: true }, agentAt('/any'))
      const text = result.content[0]!.text
      expect(text).toContain('child-1')
      expect(text).toMatch(/wak(e|ing)|finish/)
      expect(text).toMatch(/list_agents/)
      expect(text).toMatch(/send_message/)
      expect(text).toMatch(/interrupt_agent/)
      expect(text.toLowerCase()).not.toContain('outputfile')
    })

    it('starts the bundled explore agent in the background with its persona and read-only allow-list', async () => {
      const ws = freshWorkspace()
      const routes = { resolve: (m: string | undefined) => m === 'haiku' ? { provider: 'p', model: 'cheap' } : undefined }
      const { ctx, runs, continuableStarts } = await mount({ routes })
      reserveNames(ctx, 'read', 'read_image', 'glob', 'grep')
      await call(ctx, {
        subagent_type: 'explore',
        description: 'find it',
        prompt: 'where is X?',
        run_in_background: true,
      }, agentAt(ws))
      expect(runs).toHaveLength(0)
      expect(continuableStarts[0]!.provider).toBe('spawn')
      const req = continuableStarts[0]!.request
      expect(req['persona']).toContain('read-only codebase scout')
      expect(req['agentOptions']).toEqual({ provider: 'p', model: 'cheap' })
      const filter = req['toolFilter'] as { allow?: string[] }
      expect(filter.allow).toEqual(expect.arrayContaining(['read', 'read_image', 'glob', 'grep']))
      expect(filter.allow?.includes('write')).toBe(false)
      await assertRestrictable(ctx, filter as ToolRestriction)
    })
  })
})
