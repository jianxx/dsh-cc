/**
 * Tests for the per-agent "Available subagents" catalog section: a single
 * global section registration whose `text(context)` renders the agent's own
 * workspace definitions via `context.scope`, lazily loading on first sight
 * and publishing `system-prompt/change` when the catalog lands. Tests drive
 * the REAL assembly path (`ctx.plugin(SystemPrompt)` then
 * `ctx.systemPrompt.assemble`) rather than poking private APIs.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { AgentRegistry } from '../src/registry.ts'
import { mountAgentCatalog, CATALOG_SECTION_NAME } from '../src/catalog.ts'

const tmpRoots: string[] = []

function freshDir(...parts: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-catalog-'))
  tmpRoots.push(dir)
  const target = parts.length > 0 ? join(dir, ...parts) : dir
  mkdirSync(target, { recursive: true })
  return target
}

function writeAgent(root: string, name: string, description: string): void {
  const agents = join(root, '.claude', 'agents')
  mkdirSync(agents, { recursive: true })
  writeFileSync(join(agents, `${name}.md`), `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`, 'utf8')
}

function agentAt(cwd: string): Agent {
  return { session: { header: { cwd } } } as unknown as Agent
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Mount the real SystemPrompt seam + catalog, returning a scoped assembler. */
async function mount() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  const registry = new AgentRegistry()
  mountAgentCatalog(ctx, registry)
  // Assemble with a scope and read our section's rendered text ('' when the
  // section is absent from the assembly).
  const textOf = async (scope: unknown): Promise<string> => {
    const assembly = await ctx.systemPrompt.assemble(scope === undefined ? {} : { scope })
    return assembly.sections.find(s => s.name === CATALOG_SECTION_NAME)?.text ?? ''
  }
  return { ctx, registry, textOf }
}

describe('AgentCatalog section', () => {
  it('renders each agent its own workspace catalog, lazily, after a change event', async () => {
    const wsA = freshDir('ws-a')
    const wsB = freshDir('ws-b')
    writeAgent(wsA, 'deep-reasoner', 'Review heavy work')
    writeAgent(wsB, 'fast-worker', 'Mechanical execution')
    const { ctx, textOf } = await mount()

    const changes = vi.fn()
    ctx.on('system-prompt/change', changes)

    // The first assembly kicks background discovery; once it lands the change
    // event fires and a later assembly picks up the populated catalog.
    await vi.waitFor(async () => {
      const text = await textOf(agentAt(wsA))
      expect(text).toContain('deep-reasoner')
      expect(text).toContain('Review heavy work')
    }, { timeout: 2000 })
    await vi.waitFor(async () => {
      expect(await textOf(agentAt(wsB))).toContain('fast-worker')
    }, { timeout: 2000 })

    // The change event fired after the lazy loads completed.
    expect(changes).toHaveBeenCalled()

    // Each agent sees only its own workspace's agents.
    const a = await textOf(agentAt(wsA))
    expect(a).toContain('## Available subagents')
    expect(a).toContain('deep-reasoner')
    expect(a).not.toContain('fast-worker')
    expect(a).toContain('subagent_type')
    const b = await textOf(agentAt(wsB))
    expect(b).toContain('fast-worker')
    expect(b).not.toContain('deep-reasoner')

    await ctx.fiber.dispose()
  })

  it('keeps two loaded workspaces isolated from each other', async () => {
    const wsA = freshDir('ws-a')
    const wsB = freshDir('ws-b')
    writeAgent(wsA, 'deep-reasoner', 'Review heavy work')
    writeAgent(wsB, 'fast-worker', 'Mechanical execution')
    const { ctx, textOf } = await mount()

    // Both loaded.
    await vi.waitFor(async () => {
      expect(await textOf(agentAt(wsA))).toContain('deep-reasoner')
      expect(await textOf(agentAt(wsB))).toContain('fast-worker')
    }, { timeout: 2000 })

    expect(await textOf(agentAt(wsA))).not.toContain('fast-worker')
    expect(await textOf(agentAt(wsB))).not.toContain('deep-reasoner')
    await ctx.fiber.dispose()
  })

  it('renders nothing for a workspace with no agents', async () => {
    const empty = freshDir('empty')
    const { ctx, textOf } = await mount()
    // Let the (empty) discovery settle, then assert no content is rendered.
    await vi.waitFor(async () => {
      await ctx.systemPrompt.assemble({ scope: agentAt(empty) })
    })
    expect(await textOf(agentAt(empty))).toBe('')
    await ctx.fiber.dispose()
  })

  it('renders nothing for a non-agent scope', async () => {
    const ws = freshDir('ws')
    writeAgent(ws, 'deep-reasoner', 'Review heavy work')
    const { ctx, textOf } = await mount()
    expect(await textOf({})).toBe('')
    await ctx.fiber.dispose()
  })
})
