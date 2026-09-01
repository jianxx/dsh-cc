/**
 * Tests for the cc-shell plugin-mount registry (`CcPluginsService`): every
 * mount is tracked in `list()`, `rescan()` re-runs discovery and picks up newly
 * added plugins, and dispose is symmetric (a rescan fully recalls the prior
 * mount's component disposers before re-mounting). Uses a real Context with a
 * minimal hand-written Claude Code plugin in a temp dir, mirroring the harness
 * style of command-status.spec.ts.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply, Config as GlueConfig, type Config } from '@jianxx/dsh-cc-bundle-shell/src/index.ts'
import { CcPluginsService } from '@jianxx/dsh-cc-bundle-shell/src/ccPlugins.ts'

/** A commands seam that tracks live (undisposed) command names. */
function createCommandsSeam(): { register: (d: { name: string }) => () => void; live: () => string[] } {
  const active = new Set<string>()
  return {
    register: (definition) => {
      active.add(definition.name)
      return () => { active.delete(definition.name) }
    },
    live: () => Array.from(active),
  }
}

/** Write a minimal CC plugin root (plugin.json + one inline command). */
function writePlugin(root: string, name: string, commandName: string): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({
    name,
    version: '0.1.0',
    commands: {
      [commandName]: { description: `command from ${name}`, content: `# ${name}\n\nhello` },
    },
  }, null, 2))
}

let ctx: Context
let tmpRoot: string
let commands: ReturnType<typeof createCommandsSeam>

function configFor(dirs: string[]): Config {
  return { pluginDirs: dirs }
}

beforeEach(() => {
  ctx = new Context()
  commands = createCommandsSeam()
  ctx.provide('commands', commands)
  tmpRoot = mkdtempSync(join(tmpdir(), 'cc-shell-plugins-'))
})

afterEach(async () => {
  await ctx.fiber.dispose()
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('@jianxx/dsh-cc-bundle-shell ccPlugins registry', () => {
  it('tracks the initially mounted plugin in list()', async () => {
    const dir = join(tmpRoot, 'alpha')
    writePlugin(dir, 'alpha', 'alpha-command')

    await apply(ctx, configFor([tmpRoot]))

    expect(ctx.ccPlugins.list()).toHaveLength(1)
    expect(ctx.ccPlugins.list()[0]).toMatchObject({ name: 'alpha', root: dir })
    // The commands seam received the plugin's command.
    expect(commands.live()).toContain('alpha-command')
  })

  it('rescan picks up a newly added plugin dir', async () => {
    const alpha = join(tmpRoot, 'alpha')
    writePlugin(alpha, 'alpha', 'alpha-command')

    await apply(ctx, configFor([tmpRoot]))
    expect(ctx.ccPlugins.list()).toHaveLength(1)

    // Add a second plugin on disk, then rescan.
    const beta = join(tmpRoot, 'beta')
    writePlugin(beta, 'beta', 'beta-command')
    const errors = await ctx.ccPlugins.rescan()

    expect(errors).toEqual([])
    const names = ctx.ccPlugins.list().map(entry => entry.name).sort()
    expect(names).toEqual(['alpha', 'beta'])
    expect(commands.live()).toContain('alpha-command')
    expect(commands.live()).toContain('beta-command')
  })

  it('dispose is symmetric: rescan recalls the prior mount before re-mounting', async () => {
    writePlugin(join(tmpRoot, 'alpha'), 'alpha', 'alpha-command')

    await apply(ctx, configFor([tmpRoot]))
    expect(ctx.ccPlugins.list()).toHaveLength(1)
    expect(commands.live()).toContain('alpha-command')

    // Rescan with the same plugin still on disk: the old mount's disposer ran,
    // then the plugin was re-mounted exactly once (no leaked registrations).
    const errors = await ctx.ccPlugins.rescan()
    expect(errors).toEqual([])
    expect(ctx.ccPlugins.list()).toHaveLength(1)
    expect(commands.live().filter(name => name === 'alpha-command')).toHaveLength(1)
  })

  it('default discovery (absent pluginDirs) mounts installed ∩ enabled plugins', async () => {
    const home = join(tmpRoot, 'claude-home')
    const cwd = join(tmpRoot, 'workspace')
    const install = join(home, 'plugins', 'cache', 'official', 'alpha', '1.0.0')
    writePlugin(install, 'alpha', 'alpha-command')
    mkdirSync(join(home), { recursive: true })
    mkdirSync(join(cwd, '.claude'), { recursive: true })
    writeFileSync(join(home, 'settings.json'), JSON.stringify({
      enabledPlugins: { 'alpha@official': true },
    }))
    writeFileSync(join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: { 'alpha@official': [{ scope: 'user', installPath: install }] },
    }))

    const service = new CcPluginsService(ctx, { claudeHome: home, cwd })
    const errors = await service.mountAll()
    expect(errors).toEqual([])
    expect(service.list()).toHaveLength(1)
    expect(service.list()[0]).toMatchObject({ name: 'alpha', root: install })
    expect(commands.live()).toContain('alpha-command')
  })

  it('rescan re-reads the enabled/installed cascade', async () => {
    const home = join(tmpRoot, 'claude-home')
    const cwd = join(tmpRoot, 'workspace')
    const alpha = join(home, 'plugins', 'cache', 'official', 'alpha', '1.0.0')
    const beta = join(home, 'plugins', 'cache', 'official', 'beta', '1.0.0')
    writePlugin(alpha, 'alpha', 'alpha-command')
    mkdirSync(join(home, 'plugins'), { recursive: true })
    writeFileSync(join(home, 'settings.json'), JSON.stringify({
      enabledPlugins: { 'alpha@official': true },
    }))
    writeFileSync(join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: { 'alpha@official': [{ scope: 'user', installPath: alpha }] },
    }))

    const service = new CcPluginsService(ctx, { claudeHome: home, cwd })
    await service.mountAll()
    expect(service.list().map(entry => entry.name)).toEqual(['alpha'])

    writePlugin(beta, 'beta', 'beta-command')
    writeFileSync(join(home, 'settings.json'), JSON.stringify({
      enabledPlugins: { 'alpha@official': true, 'beta@official': true },
    }))
    writeFileSync(join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: {
        'alpha@official': [{ scope: 'user', installPath: alpha }],
        'beta@official': [{ scope: 'user', installPath: beta }],
      },
    }))
    const errors = await service.rescan()
    expect(errors).toEqual([])
    expect(service.list().map(entry => entry.name).sort()).toEqual(['alpha', 'beta'])
  })

  it('keeps pluginDirs undefined when Config is empty so default discovery fires', () => {
    expect(GlueConfig({}).pluginDirs).toBeUndefined()
  })
})
