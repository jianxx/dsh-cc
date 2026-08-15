import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from '../src/manifest.ts'
import { mountCommands } from '../src/commands.ts'
import { mountHooks } from '../src/hooks.ts'
import { mountMcpServers } from '../src/mcp.ts'
import { mountSettings } from '../src/settings.ts'
import { mountAgents } from '../src/agents.ts'
import { tempPluginRoot, writeFileAt } from './helpers.ts'

describe('mountCommands', () => {
  it('registers inline commands and reports them loaded', () => {
    const manifest = parsePluginManifest({
      name: 'p',
      commands: { hello: { content: 'say hi' }, byebye: { content: 'say bye' } },
    }, 'p')
    const defs: unknown[] = []
    const { disposers, tally } = mountCommands({
      pluginRoot: '/tmp',
      manifest,
      commands: { register: (def) => { defs.push(def); return () => {} } },
    })
    expect(tally.result().loaded).toBe(2)
    expect(tally.result().failed).toBe(0)
    expect(defs).toHaveLength(2)
    expect(disposers).toHaveLength(2)
  })

  it('skips commands when the commands seam is absent', () => {
    const manifest = parsePluginManifest({ name: 'p' }, 'p')
    const { tally } = mountCommands({ pluginRoot: '/tmp', manifest, commands: undefined })
    const result = tally.result()
    expect(result.skipped).toBe(1)
    expect(result.loaded).toBe(0)
  })

  it('reports a command whose source file is missing as failed', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      const manifest = parsePluginManifest({ name: 'p', commands: { a: { source: './missing.md' } } }, 'p')
      const { tally } = mountCommands({ pluginRoot: root, manifest, commands: { register: () => () => {} } })
      const result = tally.result()
      expect(result.failed).toBe(1)
      expect(result.reasons[0]).toMatch(/could not read command file/)
    } finally {
      await dispose()
    }
  })

  it('reads a source command file from the plugin root', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'hello.md', '# hello')
      const manifest = parsePluginManifest({ name: 'p', commands: { hello: { source: './hello.md' } } }, 'p')
      const defs: Array<{ handler(): unknown }> = []
      mountCommands({ pluginRoot: root, manifest, commands: { register: (d) => { defs.push(d as never); return () => {} } } })
      const result = await defs[0]!.handler()
      expect(result).toEqual({ kind: 'success', text: '# hello' })
    } finally {
      await dispose()
    }
  })
})

describe('mountHooks', () => {
  it('skips hooks when the hooks seam is absent', () => {
    const manifest = parsePluginManifest({ name: 'p' }, 'p')
    const { tally } = mountHooks({ pluginRoot: '/tmp', manifest, hooks: undefined })
    const result = tally.result()
    expect(result.skipped).toBe(1)
    expect(result.loaded).toBe(0)
  })

  it('injects inline manifest hooks through the seam', () => {
    const manifest = parsePluginManifest({
      name: 'p',
      hooks: { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'echo hi' }] }] } },
    }, 'p')
    let merged: unknown
    const { tally } = mountHooks({
      pluginRoot: '/tmp',
      manifest,
      hooks: { mergePluginHooks: (name, config) => { merged = { name, config }; return () => {} } },
    })
    const result = tally.result()
    expect(result.loaded).toBe(1)
    const record = merged as { name: string; config: unknown }
    expect(record.name).toBe('p')
    expect((record.config as Record<string, unknown>)['PreToolUse']).toBeDefined()
  })

  it('injects hooks from hooks/hooks.json', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'hooks/hooks.json', JSON.stringify({ hooks: { SessionStart: [] } }))
      const manifest = parsePluginManifest({ name: 'p' }, 'p')
      let merged: unknown
      const { tally } = mountHooks({
        pluginRoot: root,
        manifest,
        hooks: { mergePluginHooks: (name, config) => { merged = { name, config }; return () => {} } },
      })
      expect(tally.result().loaded).toBe(1)
      expect((merged as { config: Record<string, unknown> }).config['SessionStart']).toEqual([])
    } finally {
      await dispose()
    }
  })
})

describe('mountMcpServers', () => {
  it('skips mcpServers when the mcp seam is absent', () => {
    const manifest = parsePluginManifest({ name: 'p' }, 'p')
    const { tally } = mountMcpServers({ pluginRoot: '/tmp', manifest, mcp: undefined })
    const result = tally.result()
    expect(result.skipped).toBe(1)
    expect(result.loaded).toBe(0)
  })

  it('registers inline mcp servers through the seam', () => {
    const manifest = parsePluginManifest({ name: 'p', mcpServers: { one: { command: 'a' }, two: { command: 'b' } } }, 'p')
    const seen: string[] = []
    const { tally } = mountMcpServers({
      pluginRoot: '/tmp',
      manifest,
      mcp: { registerServer: (name) => { seen.push(name); return () => {} } },
    })
    expect(tally.result().loaded).toBe(2)
    expect(seen).toEqual(['one', 'two'])
  })

  it('registers servers from an mcp.json path', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, '.mcp.json', JSON.stringify({ mcpServers: { fileServer: { command: 'x' } } }))
      const manifest = parsePluginManifest({ name: 'p', mcpServers: './.mcp.json' }, 'p')
      const seen: string[] = []
      const { tally } = mountMcpServers({
        pluginRoot: root,
        manifest,
        mcp: { registerServer: (name) => { seen.push(name); return () => {} } },
      })
      expect(tally.result().loaded).toBe(1)
      expect(seen).toEqual(['fileServer'])
    } finally {
      await dispose()
    }
  })
})

describe('mountSettings', () => {
  it('skips settings when the settings seam is absent', () => {
    const manifest = parsePluginManifest({ name: 'p' }, 'p')
    const { tally } = mountSettings({ manifest, settings: undefined })
    const result = tally.result()
    expect(result.skipped).toBe(1)
  })

  it('writes only allowlisted settings through the seam', () => {
    const manifest = parsePluginManifest({
      name: 'p',
      settings: { agent: { model: 'x' }, nonce: 42, language: 'en' },
    }, 'p')
    let written: unknown
    const { tally } = mountSettings({
      manifest,
      settings: { set: (name, value) => { written = { name, value }; return () => {} } },
    })
    expect(tally.result().loaded).toBe(1)
    const record = written as { name: string; value: Record<string, unknown> }
    expect(record.name).toBe('p')
    expect(Object.keys(record.value)).toEqual(['agent'])
  })

  it('skips when no allowlisted settings are present', () => {
    const manifest = parsePluginManifest({ name: 'p', settings: { nonce: 1 } }, 'p')
    const { tally } = mountSettings({ manifest, settings: { set: () => () => {} } })
    expect(tally.result().skipped).toBe(1)
  })
})

describe('mountAgents', () => {
  it('registers each agent file as a provider', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'agents/researcher.md', '---\ndescription: researcher agent\ntools: [read]\n---\nYou are the researcher.')
      const manifest = parsePluginManifest({ name: 'p' }, 'p')
      const names: string[] = []
      const { tally } = await mountAgents({
        pluginRoot: root,
        manifest,
        subagents: { registerProvider: (p) => { names.push((p as { name: string }).name); return () => {} }, getProvider: () => undefined },
      })
      expect(tally.result().loaded).toBe(1)
      expect(names).toEqual(['researcher'])
    } finally {
      await dispose()
    }
  })

  it('skips agents when the subagent seam is absent', async () => {
    const manifest = parsePluginManifest({ name: 'p' }, 'p')
    const { tally } = await mountAgents({ pluginRoot: '/tmp', manifest, subagents: undefined })
    expect(tally.result().skipped).toBe(1)
  })

  it('skips agents when the plugin ships none', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      const manifest = parsePluginManifest({ name: 'p' }, 'p')
      const { tally } = await mountAgents({
        pluginRoot: root,
        manifest,
        subagents: { registerProvider: () => () => {}, getProvider: () => undefined },
      })
      expect(tally.result().skipped).toBe(1)
    } finally {
      await dispose()
    }
  })
})
