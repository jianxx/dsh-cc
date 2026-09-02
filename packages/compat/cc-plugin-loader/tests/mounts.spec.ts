import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from '../src/manifest.ts'
import { mountCommands } from '../src/commands.ts'
import { mountHooks } from '../src/hooks.ts'
import { mountMcpServers } from '../src/mcp.ts'
import { mountSettings } from '../src/settings.ts'
import { mountAgents } from '../src/agents.ts'
import { tempPluginRoot, writeFileAt } from './helpers.ts'

describe('mountCommands', () => {
  const makeAgent = () => {
    const sent: unknown[] = []
    return {
      sent,
      agent: { followup: (message: unknown) => { sent.push(message) } },
    }
  }
  const textOf = (message: unknown): string => {
    const content = (message as { content?: Array<{ text?: string }> }).content ?? []
    return content.map(part => part.text ?? '').join('')
  }
  const seamPushing = (defs: Array<unknown>) => ({
    register: (d: unknown) => { defs.push(d); return () => {} },
  })

  it('registers a namespaced name and a bare alias per command', () => {
    const manifest = parsePluginManifest({
      name: 'p',
      commands: { hello: { content: 'say hi' }, byebye: { content: 'say bye' } },
    }, 'p')
    const defs: Array<{ name: string }> = []
    const { disposers, tally } = mountCommands({
      pluginRoot: '/tmp',
      manifest,
      commands: seamPushing(defs),
    })
    expect(tally.result().loaded).toBe(2)
    expect(tally.result().failed).toBe(0)
    expect(defs.map(d => d.name)).toEqual(['p:hello', 'hello', 'p:byebye', 'byebye'])
    expect(disposers).toHaveLength(4)
  })

  it('skips the bare alias but keeps the namespaced command when the alias name is taken', () => {
    const manifest = parsePluginManifest({ name: 'p', commands: { hello: { content: 'hi' } } }, 'p')
    const defs: Array<{ name: string }> = []
    const { disposers, tally } = mountCommands({
      pluginRoot: '/tmp',
      manifest,
      commands: {
        register: (d) => {
          const def = d as { name: string }
          if (!def.name.includes(':')) throw new Error('name already registered')
          defs.push(def as never)
          return () => {}
        },
      },
    })
    expect(defs.map(d => d.name)).toEqual(['p:hello'])
    expect(tally.result().loaded).toBe(1)
    expect(tally.result().skipped).toBe(1)
    expect(tally.result().reasons.some(reason => /bare name "hello"/.test(reason))).toBe(true)
    expect(disposers).toHaveLength(1)
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

  it('injects a source command file as a user prompt instead of echoing it', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'hello.md', '# hello')
      const manifest = parsePluginManifest({ name: 'p', commands: { hello: { source: './hello.md' } } }, 'p')
      const defs: Array<{ handler(invocation: unknown): Promise<unknown> }> = []
      mountCommands({ pluginRoot: root, manifest, commands: seamPushing(defs) })
      const { sent, agent } = makeAgent()
      const result = await defs[0]!.handler({ agent, rawInput: '' })
      expect(result).toEqual({ kind: 'success' })
      expect(sent).toHaveLength(1)
      expect(textOf(sent[0])).toBe('# hello')
      expect((sent[0] as { source?: { kind?: string } }).source?.kind).toBe('user')
    } finally {
      await dispose()
    }
  })

  it('substitutes $ARGUMENTS with the invocation raw input', async () => {
    const manifest = parsePluginManifest({
      name: 'p',
      commands: { rescue: { content: 'Fix $ARGUMENTS now' } },
    }, 'p')
    const defs: Array<{ handler(invocation: unknown): Promise<unknown> }> = []
    mountCommands({ pluginRoot: '/tmp', manifest, commands: seamPushing(defs) })
    const { sent, agent } = makeAgent()
    const result = await defs[0]!.handler({ agent, rawInput: 'the flaky test' })
    expect(result).toEqual({ kind: 'success' })
    expect(textOf(sent[0])).toBe('Fix the flaky test now')
  })

  it('strips frontmatter and surfaces description and argument hint from a command file', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'hello.md', '---\ndescription: Say hello\nargument-hint: "[name]"\n---\n\n# hello body\n')
      const manifest = parsePluginManifest({ name: 'p', commands: { hello: { source: './hello.md' } } }, 'p')
      const defs: Array<{
        name: string
        description: string
        input?: { hint: string }
        handler(invocation: unknown): Promise<unknown>
      }> = []
      mountCommands({ pluginRoot: root, manifest, commands: seamPushing(defs) })
      expect(defs[0]!.description).toBe('Say hello')
      expect(defs[0]!.input?.hint).toBe('[name]')
      const { sent, agent } = makeAgent()
      await defs[0]!.handler({ agent, rawInput: '' })
      const text = textOf(sent[0])
      expect(text).not.toContain('---')
      expect(text).toContain('# hello body')
    } finally {
      await dispose()
    }
  })

  it('lets manifest description and argument hint override file frontmatter', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'hello.md', '---\ndescription: File loses\nargument-hint: "[file]"\n---\n\nbody\n')
      const manifest = parsePluginManifest({
        name: 'p',
        commands: { hello: { source: './hello.md', description: 'Manifest wins', argumentHint: '[override]' } },
      }, 'p')
      const defs: Array<{ description: string; input?: { hint: string } }> = []
      mountCommands({ pluginRoot: root, manifest, commands: seamPushing(defs) })
      expect(defs[0]!.description).toBe('Manifest wins')
      expect(defs[0]!.input?.hint).toBe('[override]')
    } finally {
      await dispose()
    }
  })

  it('scans commands/*.md when the manifest omitted commands', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'commands/foo.md', '# foo')
      const defs: Array<{ name: string }> = []
      const { disposers, tally } = mountCommands({
        pluginRoot: root,
        manifest: parsePluginManifest({ name: 'p' }, 'p'),
        commands: seamPushing(defs),
      })
      expect(tally.result().loaded).toBe(1)
      expect(defs.map(d => d.name)).toEqual(['p:foo', 'foo'])
      expect(disposers).toHaveLength(2)
    } finally {
      await dispose()
    }
  })

  it('does not scan commands/ when the manifest declared commands', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'commands/foo.md', '# foo')
      const defs: Array<{ name: string }> = []
      const { tally } = mountCommands({
        pluginRoot: root,
        manifest: parsePluginManifest({ name: 'p', commands: { hello: { content: 'hi' } } }, 'p'),
        commands: seamPushing(defs),
      })
      expect(tally.result().loaded).toBe(1)
      expect(defs.map(d => d.name)).toEqual(['p:hello', 'hello'])
    } finally {
      await dispose()
    }
  })

  it('skips nested command directories with a reason instead of registering them', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'commands/sub/x.md', '# nested')
      await writeFileAt(root, 'commands/bar.md', '# bar')
      const defs: Array<{ name: string }> = []
      const { tally } = mountCommands({
        pluginRoot: root,
        manifest: parsePluginManifest({ name: 'p' }, 'p'),
        commands: seamPushing(defs),
      })
      expect(defs.map(d => d.name)).toEqual(['p:bar', 'bar'])
      expect(tally.result().skipped).toBeGreaterThanOrEqual(1)
      expect(tally.result().reasons.some(reason => /nested commands directory/.test(reason))).toBe(true)
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
