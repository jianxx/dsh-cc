/**
 * The deferred-tool registry and ToolSearch tool. What it owes its caller: a
 * deferred tool is invisible until a ToolSearch hit loads it into the real
 * registry; loading is idempotent and unwinds with the deferred registration;
 * `alwaysLoad` loads immediately; and a scoped restriction denies a deferred
 * tool before it can load for that agent.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@jianxx/dsh-cc-tools'
import DeferredToolRegistry, { TOOL_SEARCH_NAME } from '@jianxx/dsh-cc-tool-search'
import type { DeferredToolRegistration } from '@jianxx/dsh-cc-tool-search'

const signal = new AbortController().signal

/** A host plane with the tool registry, system prompt, and the ToolSearch service. */
async function host(options: { toolSearch?: boolean } = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  if (options.toolSearch !== false) await ctx.plugin(DeferredToolRegistry)
  return ctx
}

/** Register one real tool definition (the "heavy" implementation a deferred tool loads). */
function bigTool(name: string, description: string) {
  return defineTool({
    name,
    description,
    parameters: { value: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: args => Promise.resolve(args.value ?? 'ok'),
  })
}

/** Register a deferred tool whose activation performs a real `ctx.tools.register`. */
function deferred(host: Context, name: string, description: string, searchHint?: string, extra: Partial<DeferredToolRegistration> = {}) {
  return host.toolSearch.registerDeferred({
    name,
    description,
    ...searchHint !== undefined ? { searchHint } : {},
    activate: () => host.tools.register(bigTool(name, description)),
    ...extra,
  })
}

/** Mint an agent-scoped context under the host, as a preset subtree does. */
async function mintAgent(host: Context, id: string): Promise<{ agent: Agent; scope: Scope }> {
  const agent = { id: SessionId(id) } as Agent
  let scope!: Scope
  const fiber = host.plugin(Object.assign((inner: Context) => {
    scope = createScope(inner, agent)
  }, { inject: ['tools', 'systemPrompt', 'toolSearch'] }))
  await fiber.await()
  return { agent, scope }
}

/** Observable model-facing tool names for a scope (undefined = global). */
async function visibleNames(host: Context, scope?: Agent | Scope) {
  const context: { scope?: Agent | Scope } = scope === undefined ? {} : { scope }
  const assembly = await host.systemPrompt.assemble(context)
  return assembly.tools.map(tool => tool.name)
}

/** Execute the ToolSearch tool on the host as the model would. */
interface ToolSearchValue {
  query: string
  results: Array<{ name: string; description: string; status: string; reason?: string }>
}

async function runToolSearch(host: Context, query: string, args: { max_results?: number; agent?: Agent } = {}) {
  const result = await host.tools.execute({
    signal,
    callId: CallId('search'),
    name: TOOL_SEARCH_NAME,
    arguments: { query, ...args.max_results !== undefined ? { max_results: args.max_results } : {} },
    ...args.agent !== undefined ? { agent: args.agent } : {},
  })
  expect(result.isError).toBe(false)
  return result as typeof result & { value: ToolSearchValue }
}

describe('the deferred tool registry', () => {
  it('keeps a deferred tool invisible until it is loaded', async () => {
    const ctx = await host()
    deferred(ctx, 'big_tool', 'Heavy filesystem capability.', 'read')

    expect(await visibleNames(ctx)).toEqual([TOOL_SEARCH_NAME])
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual([TOOL_SEARCH_NAME])
  })

  it('searches the deferred set by name, searchHint, and description', async () => {
    const ctx = await host()
    deferred(ctx, 'bash_tool', 'Run shell commands.', 'shell terminal')
    deferred(ctx, 'write_file', 'Overwrite a file on disk.', 'edit write')
    deferred(ctx, 'notebook', 'Drive a Jupyter notebook.', 'python cells')

    // Name match outranks hint outranks description.
    expect(ctx.toolSearch.search('bash').map(hit => hit.name)).toContain('bash_tool')
    expect(ctx.toolSearch.search('shell').map(hit => hit.name)).toContain('bash_tool')
    expect(ctx.toolSearch.search('jupyter').map(hit => hit.name)).toEqual(['notebook'])
    // A description-only match still surfaces.
    expect(ctx.toolSearch.search('disk').map(hit => hit.name)).toEqual(['write_file'])
  })

  it('ranks name matches above hint matches above description matches', async () => {
    const ctx = await host()
    deferred(ctx, 'edit_tool', 'Change file contents.', 'write modify')
    deferred(ctx, 'write_tool', 'Create files.', 'edit')

    const names = ctx.toolSearch.search('edit').map(hit => hit.name)
    // `edit_tool` matches on its name and its hint; `write_tool` only on its
    // description. However both carry hint/description `edit`, so the name
    // exact token must break the tie deterministically.
    expect(names[0]).toBe('edit_tool')
  })

  it('respects max_results and defaults it to five', async () => {
    const ctx = await host()
    for (let index = 0; index < 7; index += 1) {
      deferred(ctx, `tool_${index}`, `capability number ${index}`, 'something')
    }

    expect(ctx.toolSearch.search('capability').length).toBe(5)
    expect(ctx.toolSearch.search('capability', 2).length).toBe(2)
  })

  it('overrides the default max_results through the tool call', async () => {
    const ctx = await host()
    for (let index = 0; index < 3; index += 1) {
      deferred(ctx, `tool_${index}`, `capability number ${index}`, 'something')
    }

    const result = await runToolSearch(ctx, 'capability', { max_results: 2 })
    expect(result.value.results.length).toBe(2)
  })
})

describe('loading a deferred tool', () => {
  it('loads a matched tool so the next assembly sees it', async () => {
    const ctx = await host()
    deferred(ctx, 'big_tool', 'Heavy capability.', 'data')
    expect(await visibleNames(ctx)).toEqual([TOOL_SEARCH_NAME])

    const result = await runToolSearch(ctx, 'data')
    expect(result.value.results[0]?.status).toBe('loaded')

    expect(await visibleNames(ctx)).toEqual([TOOL_SEARCH_NAME, 'big_tool'])
  })

  it('returns a model-readable summary naming the loaded tool', async () => {
    const ctx = await host()
    deferred(ctx, 'bash_tool', 'Run shell commands.', 'shell')

    const result = await runToolSearch(ctx, 'shell')
    const block = result.content[0]
    expect(block?.type).toBe('text')
    const text = block?.type === 'text' ? block.text : ''
    expect(text).toContain('bash_tool')
    expect(text).toContain('Run shell commands.')
  })

  it('is idempotent: loading an already-loaded tool is a no-op', async () => {
    const ctx = await host()
    deferred(ctx, 'big_tool', 'Heavy capability.', 'data')

    expect(ctx.toolSearch.activate('big_tool').status).toBe('loaded')
    // A second activation must NOT re-register (which would throw on the
    // duplicate global name) nor reload.
    expect(ctx.toolSearch.activate('big_tool').status).toBe('already-loaded')

    // Still exactly one visible registration.
    expect(await visibleNames(ctx)).toEqual([TOOL_SEARCH_NAME, 'big_tool'])
    // Once active it is directly callable, so it leaves the deferred set.
    expect(ctx.toolSearch.search('data')).toEqual([])
  })

  it('unloads the activated tool together with its deferred registration', async () => {
    const ctx = await host()
    const dispose = deferred(ctx, 'big_tool', 'Heavy capability.', 'data')

    await runToolSearch(ctx, 'data')
    expect(await visibleNames(ctx)).toContain('big_tool')

    dispose()
    expect(await visibleNames(ctx)).toEqual([TOOL_SEARCH_NAME])
  })
})

describe('alwaysLoad', () => {
  it('loads immediately and is never a deferred candidate', async () => {
    const ctx = await host()
    deferred(ctx, 'essential', 'Always-present capability.', 'core', { alwaysLoad: true })
    deferred(ctx, 'heavy', 'Deferred capability.', 'data')

    // Visible from the start, without any search.
    expect(await visibleNames(ctx)).toEqual([TOOL_SEARCH_NAME, 'essential'])
    expect(ctx.toolSearch.search('data').map(hit => hit.name)).toEqual(['heavy'])
    expect(ctx.toolSearch.search('core').map(hit => hit.name)).toEqual([])
    expect(ctx.toolSearch.activate('essential').status).toBe('already-loaded')
  })
})

describe('restriction priority', () => {
  it('does not load a deferred tool a scope denies, and says so', async () => {
    const ctx = await host()
    deferred(ctx, 'big_tool', 'Heavy capability.', 'data')
    const { agent, scope } = await mintAgent(ctx, 'restricted')

    // Deny the reserved deferred name for this one agent; the reservation makes
    // it a legal restrict target even before it loads.
    scope.ctx.tools.restrict({ deny: ['big_tool'] })

    // The agent's own ToolSearch keeps it unloaded and explains why.
    const result = await runToolSearch(ctx, 'data', { agent })
    expect(result.value.results[0]?.status).toBe('denied')
    expect(result.value.results[0]?.reason).toContain('restricted')
    expect(ctx.toolSearch.activate('big_tool', agent).status).toBe('denied')

    // It stays unloaded for that agent, and is never in its schema.
    expect(await visibleNames(ctx, agent)).not.toContain('big_tool')
  })

  it('still loads the tool for an unrestricted scope', async () => {
    const ctx = await host()
    deferred(ctx, 'big_tool', 'Heavy capability.', 'data')
    const { agent, scope } = await mintAgent(ctx, 'restricted')
    scope.ctx.tools.restrict({ deny: ['big_tool'] })

    // An unrestricted scope in the same process can still load it.
    expect(await visibleNames(ctx)).not.toContain('big_tool')
    expect(ctx.toolSearch.activate('big_tool').status).toBe('loaded')
    // The restricting agent still does not see it.
    expect(await visibleNames(ctx, agent)).not.toContain('big_tool')
  })
})

describe('presentation', () => {
  it('declares an explicit generic render intent as pure functions of args', async () => {
    const ctx = await host()
    deferred(ctx, 'big_tool', 'Heavy capability.', 'data')

    const definition = ctx.tools.get(TOOL_SEARCH_NAME)
    expect(definition).toBeDefined()
    const presentCall = definition!.presentCall!
    const presentResult = definition!.presentResult!
    const call = presentCall({ query: 'data' })
    expect(call).toMatchObject({ card: 'generic', kind: 'search', rawInput: 'data' })

    const resultView = presentResult({ query: 'data' }, {
      content: [{ type: 'text', text: 'summary' }],
      isError: false,
    })
    expect(resultView).toMatchObject({ card: 'generic', title: 'Tool search' })
  })
})
