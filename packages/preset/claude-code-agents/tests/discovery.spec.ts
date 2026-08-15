import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  discoverAgents,
  findProjectAgentsDir,
  loadAgentsDir,
  loadClaudeCodeAgents,
} from '@jianxx/dsh-cc-claude-code-agents'

const AGENT_MD = (body: string): string => `---
description: test agent
---
${body}`

async function rootdir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'dsh-cc-agents-'))
}

async function writeAgent(dir: string, name: string, body: string): Promise<void> {
  const agents = join(dir, '.claude', 'agents')
  await mkdir(agents, { recursive: true })
  await writeFile(join(agents, `${name}.md`), AGENT_MD(body))
}

describe('findProjectAgentsDir', () => {
  it('finds the nearest .claude/agents by walking up', async () => {
    const root = await rootdir()
    const agentsDir = join(root, 'a', 'b', '.claude', 'agents')
    await mkdir(agentsDir, { recursive: true })
    expect(await findProjectAgentsDir(join(root, 'a', 'b', 'c')))
      .toBe(agentsDir)
  })

  it('returns undefined when no ancestor has a .claude/agents', async () => {
    const root = await rootdir()
    await mkdir(join(root, 'x'), { recursive: true })
    expect(await findProjectAgentsDir(join(root, 'x'))).toBeUndefined()
  })
})

describe('loadAgentsDir', () => {
  it('loads .md and .json files, ordered by filename, skipping non-agent files', async () => {
    const agentsDir = join(await rootdir(), '.claude', 'agents')
    await mkdir(agentsDir, { recursive: true })
    await writeFile(join(agentsDir, 'zeta.md'), AGENT_MD('z'))
    await writeFile(join(agentsDir, 'alpha.md'), AGENT_MD('a'))
    await writeFile(join(agentsDir, 'bravo.json'), JSON.stringify({ description: 'j', prompt: 'p' }))
    await writeFile(join(agentsDir, 'readme.txt'), 'not an agent')

    const agents = await loadAgentsDir(agentsDir, 'project')
    expect(agents.map(agent => agent.agentType)).toEqual(['alpha', 'bravo', 'zeta'])
    expect(agents[1]?.source).toBe('project')
  })

  it('treats an absent directory as supplying no agents', async () => {
    expect(await loadAgentsDir(join(await rootdir(), '.claude', 'agents'), 'user')).toEqual([])
  })

  it('throws when a discovered file cannot be parsed', async () => {
    const agentsDir = join(await rootdir(), '.claude', 'agents')
    await mkdir(agentsDir, { recursive: true })
    await writeFile(join(agentsDir, 'broken.md'), '---\ndescription: x\nmaxTurns: -3\n---\nbody')
    await expect(loadAgentsDir(agentsDir, 'project')).rejects.toThrow(/maxTurns must be a positive integer/)
  })
})

describe('discoverAgents', () => {
  it('projects shadow users on a name collision', async () => {
    const root = await rootdir()
    const userDir = join(await rootdir(), '.claude', 'agents')
    await mkdir(userDir, { recursive: true })
    await writeFile(join(userDir, 'git.md'), AGENT_MD('user version'))
    await writeAgent(root, 'git', 'project version')
    await writeAgent(root, 'code', 'only project')

    const agents = await discoverAgents(root, userDir)
    const git = agents.find(agent => agent.agentType === 'git')
    expect(git?.systemPrompt).toMatch(/project version/)
    expect(git?.source).toBe('project')
    expect(agents.map(agent => agent.agentType)).toEqual(expect.arrayContaining(['git', 'code']))
  })

  it('keeps only the user layer when the project layer is absent', async () => {
    const root = await rootdir()
    const userDir = join(await rootdir(), '.claude', 'agents')
    await mkdir(userDir, { recursive: true })
    await writeFile(join(userDir, 'only.md'), AGENT_MD('u'))

    const agents = await discoverAgents(root, userDir)
    expect(agents.map(agent => agent.agentType)).toEqual(['only'])
    expect(agents[0]?.source).toBe('user')
  })

  it('skips the user layer when userDir is undefined', async () => {
    const root = await rootdir()
    await writeAgent(root, 'code', 'c')
    const agents = await discoverAgents(root, undefined)
    expect(agents.map(agent => agent.agentType)).toEqual(['code'])
  })
})

describe('loadClaudeCodeAgents', () => {
  it('loads project and user agents through the public function', async () => {
    const root = await rootdir()
    await writeAgent(root, 'code', 'project body')
    const userDir = join(await rootdir(), '.claude', 'agents')
    await mkdir(userDir, { recursive: true })
    await writeFile(join(userDir, 'code.md'), AGENT_MD('user body'))
    await writeFile(join(userDir, 'user-only.md'), AGENT_MD('u'))

    const agents = await loadClaudeCodeAgents(root, { userDir })
    expect(agents.map(agent => agent.agentType).sort())
      .toEqual(['code', 'user-only'])
    const code = agents.find(agent => agent.agentType === 'code')
    expect(code?.systemPrompt).toMatch(/project body/)
  })

  it('defaults the user layer to the OS home', async () => {
    // Homing the user layer at "~/.claude/agents" does not throw when absent.
    const root = await rootdir()
    await writeAgent(root, 'code', 'c')
    const agents = await loadClaudeCodeAgents(root)
    expect(agents.map(agent => agent.agentType)).toEqual(['code'])
  })
})
