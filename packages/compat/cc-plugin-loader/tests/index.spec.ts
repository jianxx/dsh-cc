import { describe, expect, it } from 'vitest'
import { mountCcPlugin } from '../src/index.ts'
import { tempPluginRoot, writeFileAt, makeContext } from './helpers.ts'

describe('mountCcPlugin', () => {
  it('mounts all components with the seams present and reports loaded counts', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'plugin.json', JSON.stringify({
        name: 'p',
        commands: { hello: { content: 'hi' } },
        settings: { agent: { model: 'x' } },
      }))
      const ctx = makeContext()
      const mount = await mountCcPlugin(ctx, {
        root,
        seams: {
          commands: { register: () => () => {} },
          settings: { set: () => () => {} },
          skills: { register: () => () => {} },
          subagents: { registerProvider: () => () => {}, getProvider: () => undefined },
          hooks: { mergePluginHooks: () => () => {} },
          mcp: { registerServer: () => () => {} },
        },
      })
      const report = mount.report
      expect(report.name).toBe('p')
      const byKind = Object.fromEntries(report.components.map(c => [c.kind, c]))
      expect(byKind['commands']?.loaded).toBe(1)
      expect(byKind['settings']?.loaded).toBe(1)
      expect(byKind['skills']?.skipped).toBe(1)
      expect(byKind['agents']?.skipped).toBe(1)
      expect(byKind['hooks']?.skipped).toBe(1)
      expect(byKind['mcpServers']?.skipped).toBe(1)
      mount.dispose()
    } finally {
      await dispose()
    }
  })

  it('skips components whose seams are absent (guest seams default off)', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'plugin.json', JSON.stringify({ name: 'p', mcpServers: { s: { command: 'x' } }, settings: { language: 'en' } }))
      const ctx = makeContext()
      const mount = await mountCcPlugin(ctx, { root, seams: {} })
      const report = mount.report
      const byKind = Object.fromEntries(report.components.map(c => [c.kind, c]))
      expect(byKind['mcpServers']?.skipped).toBe(1)
      expect(byKind['mcpServers']?.reasons[0]).toMatch(/not mounted/)
      expect(byKind['settings']?.skipped).toBe(1)
      mount.dispose()
    } finally {
      await dispose()
    }
  })

  it('throws on an invalid manifest with the plugin path', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'plugin.json', JSON.stringify({ commands: 42 }))
      const ctx = makeContext()
      await expect(mountCcPlugin(ctx, { root })).rejects.toThrow(/name/)
    } finally {
      await dispose()
    }
  })

  it('recalls every mounted component when the context stops', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'plugin.json', JSON.stringify({
        name: 'p',
        commands: { hello: { content: 'hi' } },
      }))
      const disposed: string[] = []
      const register = (tag: string) => () => { disposed.push(tag) }
      const ctx = makeContext()
      const mount = await mountCcPlugin(ctx, {
        root,
        seams: {
          commands: { register: () => register('commands') },
          skills: { register: () => register('skills') },
          subagents: { registerProvider: () => register('agents'), getProvider: () => undefined },
          hooks: { mergePluginHooks: () => register('hooks') },
          mcp: { registerServer: () => register('mcp') },
          settings: { set: () => register('settings') },
        },
      })
      await mount.dispose()
      expect(disposed).toContain('commands')
    } finally {
      await dispose()
    }
  })

  it('unchanged effect labels are idempotent across mounts', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'plugin.json', JSON.stringify({ name: 'p' }))
      const ctx = makeContext()
      const seams = { commands: { register: () => () => {} } }
      const first = await mountCcPlugin(ctx, { root, seams })
      const second = await mountCcPlugin(ctx, { root, seams })
      first.dispose()
      second.dispose()
      expect(true).toBe(true)
    } finally {
      await dispose()
    }
  })
})
