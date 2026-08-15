import { describe, expect, it } from 'vitest'
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'
import { parsePluginManifest } from '../src/manifest.ts'
import { mountSkills } from '../src/skills.ts'
import { registerSkillPathActivator, activationFor } from '../src/skill-semantics.ts'
import { tempPluginRoot, writeSkill, writeFileAt, makeContext } from './helpers.ts'

function manifest(extra: Record<string, unknown> = {}): ReturnType<typeof parsePluginManifest> {
  return parsePluginManifest({ name: 'p', ...extra }, 'p')
}

describe('mountSkills', () => {
  it('skips skills when the skill registry seam is absent', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeSkill(root, 'do-thing', { name: 'do-thing', description: 'Does a thing' })
      const ctx = makeContext()
      const { tally } = await mountSkills({ ctx, pluginRoot: root, manifest: manifest(), skills: undefined, subagentsPresent: true })
      expect(tally.result().skipped).toBe(1)
    } finally {
      await dispose()
    }
  })

  it('discovers and registers skills from the standard skills/ directory', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeSkill(root, 'do-thing', {
        name: 'do-thing',
        description: 'Does a thing',
        'allowed-tools': 'read',
        paths: ['src/**/*.ts'],
      })
      const defs: SkillDefinition[] = []
      const ctx = makeContext()
      const { tally } = await mountSkills({
        ctx,
        pluginRoot: root,
        manifest: manifest(),
        skills: { register: (d) => { defs.push(d as unknown as SkillDefinition); return () => {} } },
        subagentsPresent: true,
      })
      expect(tally.result().loaded).toBe(1)
      expect(defs[0]?.name).toBe('do-thing')
      expect(defs[0]?.description).toBe('Does a thing')
      const metadata = defs[0]?.metadata as Record<string, unknown> | undefined
      expect(metadata?.['allowedTools']).toEqual(['read'])
      expect(metadata?.['paths']).toEqual(['src/**/*.ts'])
    } finally {
      await dispose()
    }
  })

  it('reports a skill with an invalid registry name as failed', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeSkill(root, 'Bad Name', { name: 'Bad Name', description: 'x' })
      const ctx = makeContext()
      const { tally } = await mountSkills({
        ctx,
        pluginRoot: root,
        manifest: manifest(),
        skills: { register: () => () => {} },
        subagentsPresent: true,
      })
      expect(tally.result().failed).toBe(1)
    } finally {
      await dispose()
    }
  })

  it('reports no skills when the plugin ships none', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      const ctx = makeContext()
      const { tally } = await mountSkills({
        ctx,
        pluginRoot: root,
        manifest: manifest(),
        skills: { register: () => () => {} },
        subagentsPresent: true,
      })
      expect(tally.result().skipped).toBe(1)
    } finally {
      await dispose()
    }
  })

  it('discovers skills declared in manifest skills paths', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, '.claude/skills/inline-skill/SKILL.md', '---\nname: inline-skill\ndescription: Inline skill\n---')
      const ctx = makeContext()
      const defs: SkillDefinition[] = []
      const { tally } = await mountSkills({
        ctx,
        pluginRoot: root,
        manifest: manifest({ skills: ['./.claude/skills'] }),
        skills: { register: (d) => { defs.push(d as unknown as SkillDefinition); return () => {} } },
        subagentsPresent: true,
      })
      expect(tally.result().loaded).toBe(1)
      expect(defs[0]?.name).toBe('inline-skill')
    } finally {
      await dispose()
    }
  })
})

describe('registerSkillPathActivator', () => {
  it('registers a path activator that returns a disposer', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeFileAt(root, 'src/a.ts', 'let x = 1')
      const ctx = makeContext()
      const definition = {
        name: 'do-thing',
        content: 'body',
        metadata: { paths: ['src/**/*.ts'] },
      } as never
      const disposer = registerSkillPathActivator(ctx, definition as never, root)
      expect(typeof disposer).toBe('function')
      disposer()
    } finally {
      await dispose()
    }
  })

  it('returns a no-op disposer for a skill with no paths', () => {
    const ctx = makeContext()
    const definition = { name: 'p', content: 'body', metadata: {} } as never
    const disposer = registerSkillPathActivator(ctx, definition as never, '/tmp')
    disposer()
    expect(true).toBe(true)
  })
})

describe('mountSkills wiring', () => {
  it('wires activation descriptors for discovered skills', async () => {
    const { root, dispose } = await tempPluginRoot()
    try {
      await writeSkill(root, 'forky', { name: 'forky', description: 'fork', context: 'fork' })
      const ctx = makeContext()
      const defs: SkillDefinition[] = []
      await mountSkills({
        ctx,
        pluginRoot: root,
        manifest: manifest(),
        skills: { register: (d) => { defs.push(d as unknown as SkillDefinition); return () => {} } },
        subagentsPresent: true,
      })
      const metadata = defs[0]?.metadata as Record<string, unknown> | undefined
      const activation = activationFor(metadata as never, true)
      expect(activation.execution).toBe('fork')
    } finally {
      await dispose()
    }
  })
})
