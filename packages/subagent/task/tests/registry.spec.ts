/**
 * Tests for the per-workspace AgentRegistry: lazy `loadClaudeCodeAgents`
 * discovery keyed by the session cwd, project shadowing user, and the
 * process-level cache contract (no file watching in v1).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentRegistry } from '../src/registry.ts'

const tmpRoots: string[] = []

function freshDir(...parts: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-registry-'))
  tmpRoots.push(dir)
  const target = parts.length > 0 ? join(dir, ...parts) : dir
  mkdirSync(target, { recursive: true })
  return target
}

function writeAgent(dir: string, name: string, body: { description: string; model?: string }, mode: 'project' | 'user' = 'project'): void {
  const agents = mode === 'project' ? join(dir, '.claude', 'agents') : dir
  mkdirSync(agents, { recursive: true })
  const model = body.model === undefined ? '' : `model: ${body.model}\n`
  writeFileSync(join(agents, `${name}.md`), `---\nname: ${name}\ndescription: ${body.description}\n${model}---\n\nSystem prompt for ${name}.\n`, 'utf8')
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('AgentRegistry', () => {
  it('discovers project agents under the session cwd', async () => {
    const root = freshDir('ws')
    writeAgent(root, 'deep-reasoner', { description: 'Review heavy work' })
    const registry = new AgentRegistry()
    const defs = await registry.list(root)
    expect(defs.map(d => d.agentType)).toEqual(['deep-reasoner'])
  })

  it('returns an empty list when no agents dir exists', async () => {
    const root = freshDir('empty')
    const registry = new AgentRegistry()
    await expect(registry.list(root)).resolves.toEqual([])
  })

  it('resolves one definition by type', async () => {
    const root = freshDir('ws')
    writeAgent(root, 'fast-worker', { description: 'Mechanical execution', model: 'sonnet' })
    const registry = new AgentRegistry()
    const def = await registry.resolve(root, 'fast-worker')
    expect(def?.whenToUse).toBe('Mechanical execution')
    expect(def?.model).toBe('sonnet')
    await expect(registry.resolve(root, 'nope')).resolves.toBeUndefined()
  })

  it('project layer shadows the user layer on a name collision', async () => {
    const project = freshDir('ws')
    const user = freshDir('user-agents')
    writeAgent(project, 'shared', { description: 'project wins' })
    writeAgent(user, 'shared', { description: 'user layer' }, 'user')
    const registry = new AgentRegistry({ userDir: user })
    const def = await registry.resolve(project, 'shared')
    expect(def?.whenToUse).toBe('project wins')
  })

  it('caches per root: edits after the first load are invisible', async () => {
    const root = freshDir('ws')
    writeAgent(root, 'a', { description: 'first' })
    const registry = new AgentRegistry()
    await registry.list(root)
    writeAgent(root, 'b', { description: 'added later' })
    const defs = await registry.list(root)
    expect(defs.map(d => d.agentType)).toEqual(['a'])
  })
})
