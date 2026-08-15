import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from '../src/manifest.ts'

describe('parsePluginManifest', () => {
  it('parses a minimal manifest with only a name', () => {
    const manifest = parsePluginManifest({ name: 'my-plugin' }, 'my-plugin')
    expect(manifest.name).toBe('my-plugin')
    expect(manifest.commands).toEqual([])
    expect(manifest.agents).toEqual([])
    expect(manifest.skills).toEqual([])
    expect(manifest.mcpServers).toEqual({})
    expect(manifest.settings).toEqual({})
  })

  it('normalizes commands from a string path and an object map', () => {
    const manifest = parsePluginManifest({
      name: 'p',
      commands: {
        about: { source: './about.md', description: 'About this plugin' },
        hello: { content: 'inline hello', allowedTools: ['read'] },
      },
    }, 'p')
    expect(manifest.commands).toHaveLength(2)
    const about = manifest.commands.find(c => c.name === 'about')
    expect(about?.source).toBe('./about.md')
    expect(about?.description).toBe('About this plugin')
    const hello = manifest.commands.find(c => c.name === 'hello')
    expect(hello?.content).toBe('inline hello')
    expect(hello?.allowedTools).toEqual(['read'])
  })

  it('normalizes agents and skills string lists', () => {
    const manifest = parsePluginManifest({ name: 'p', agents: './a.md', skills: ['./one', './two'] }, 'p')
    expect(manifest.agents).toEqual(['./a.md'])
    expect(manifest.skills).toEqual(['./one', './two'])
  })

  it('keeps only top-level fields it understands and ignores unknowns', () => {
    const manifest = parsePluginManifest({ name: 'p', version: '1.2.3', description: 'd', custom: 42 }, 'p')
    expect(manifest.version).toBe('1.2.3')
    expect(manifest.description).toBe('d')
    expect('custom' in manifest).toBe(false)
  })

  it('throws on a manifest that is not an object', () => {
    expect(() => parsePluginManifest('nope', 'src')).toThrow(/must be a JSON object/)
  })

  it('throws when the plugin name is missing', () => {
    expect(() => parsePluginManifest({}, 'path')).toThrow(/plugin path: "name" must be a non-empty string/)
  })

  it('throws when the plugin name contains a space', () => {
    expect(() => parsePluginManifest({ name: 'bad name' }, 'path')).toThrow(/cannot contain spaces/)
  })

  it('throws when a command has both source and content', () => {
    expect(() => parsePluginManifest({
      name: 'p',
      commands: { bad: { source: './a.md', content: 'x' } },
    }, 'p')).toThrow(/exactly one of "source"/)
  })

  it('throws when a command has neither source nor content', () => {
    expect(() => parsePluginManifest({ name: 'p', commands: { bad: {} } }, 'p')).toThrow(/exactly one of "source"/)
  })

  it('throws on an invalid commands shape', () => {
    expect(() => parsePluginManifest({ name: 'p', commands: 42 }, 'p')).toThrow(/must be a path, a list, or an object map/)
  })

  it('carries an mcpServers path when the field is a string', () => {
    const manifest = parsePluginManifest({ name: 'p', mcpServers: './.mcp.json' }, 'p')
    expect(manifest.mcpServersPath).toBe('./.mcp.json')
    expect(manifest.mcpServers).toEqual({})
  })

  it('parses inline mcpServers as a record', () => {
    const manifest = parsePluginManifest({ name: 'p', mcpServers: { server: { command: 'npx' } } }, 'p')
    expect(manifest.mcpServers['server']).toEqual({ command: 'npx' })
  })

  it('carries inline settings verbatim', () => {
    const manifest = parsePluginManifest({ name: 'p', settings: { agent: { model: 'x' } } }, 'p')
    expect(manifest.settings['agent']).toEqual({ model: 'x' })
  })
})
