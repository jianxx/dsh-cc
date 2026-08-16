import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { FsObservation, FsTarget, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillCc from '../src/index.ts'

async function tempDir(name: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), `dsh-ccprov-${name}-`))
}

async function writeSkill(root: string, name: string, frontmatter: string, body = 'Body.\n'): Promise<string> {
  await mkdir(join(root, name), { recursive: true })
  const path = join(root, name, 'SKILL.md')
  await writeFile(path, `---\n${frontmatter}\n---\n\n${body}`, 'utf8')
  return path
}

async function setup(config: SkillCc.Config = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(SkillCc, config)
  return ctx
}

function target(path: string): FsTarget {
  return { targetKey: FsTargetKey(path), displayPath: path }
}

function observation(): FsObservation {
  return { kind: 'present', version: FsVersion('1') }
}

function actor(name: string): object {
  return { name }
}

async function projectRoot(name: string): Promise<string> {
  const project = await tempDir(name)
  await mkdir(join(project, '.git'), { recursive: true })
  return project
}

describe('paths-gated conditional activation', () => {
  it('excludes an inactive paths-gated skill, then activates it on a matching touch', async () => {
    const project = await projectRoot('cond')
    await writeSkill(
      join(project, '.claude', 'skills'),
      'src-skill',
      'name: src-skill\ndescription: Conditional\npaths:\n  - "src/**"',
    )
    const ctx = await setup({ dshHome: join(project, 'nohome') })

    const before = (await ctx.skills.list({ cwd: project })).map(s => s.name)
    expect(before).not.toContain('src-skill')

    ctx.emit('fs/observed', target(join(project, 'src', 'a.ts')), observation(), actor('read'))

    const after = (await ctx.skills.list({ cwd: project })).map(s => s.name)
    expect(after).toContain('src-skill')

    const loaded = await ctx.skills.get('src-skill', { cwd: project })
    expect(loaded?.content).toBe('Body.\n')
    expect(loaded?.metadata?.paths).toEqual(['src'])
  })

  it('does not activate when the touched path does not match', async () => {
    const project = await projectRoot('cond-neg')
    await writeSkill(
      join(project, '.claude', 'skills'),
      'src-skill',
      'name: src-skill\ndescription: Conditional\npaths:\n  - "src/**"',
    )
    const ctx = await setup({ dshHome: join(project, 'nohome') })
    await ctx.skills.list({ cwd: project })

    ctx.emit('fs/observed', target(join(project, 'lib', 'other.ts')), observation(), actor('read'))

    const after = (await ctx.skills.list({ cwd: project })).map(s => s.name)
    expect(after).not.toContain('src-skill')
  })

  it('is idempotent: a matching touch activates once and only notifies once', async () => {
    const project = await projectRoot('cond-dup')
    await writeSkill(
      join(project, '.claude', 'skills'),
      'src-skill',
      'name: src-skill\ndescription: Conditional\npaths:\n  - "src/**"',
    )
    const ctx = await setup({ dshHome: join(project, 'nohome') })
    await ctx.skills.list({ cwd: project })

    let changes = 0
    ctx.on('skills/change', () => {
      changes += 1
    })

    ctx.emit('fs/observed', target(join(project, 'src', 'a.ts')), observation(), actor('read'))
    expect(changes).toBe(1)

    ctx.emit('fs/observed', target(join(project, 'src', 'a.ts')), observation(), actor('read'))
    ctx.emit('fs/observed', target(join(project, 'src', 'b.ts')), observation(), actor('write'))
    expect(changes).toBe(1)
  })

  it('is not triggered by tool actors other than read/write/edit', async () => {
    const project = await projectRoot('cond-ignored')
    await writeSkill(
      join(project, '.claude', 'skills'),
      'src-skill',
      'name: src-skill\ndescription: Conditional\npaths:\n  - "src/**"',
    )
    const ctx = await setup({ dshHome: join(project, 'nohome') })
    await ctx.skills.list({ cwd: project })

    ctx.emit('fs/observed', target(join(project, 'src', 'a.ts')), observation(), actor('bash'))

    const after = (await ctx.skills.list({ cwd: project })).map(s => s.name)
    expect(after).not.toContain('src-skill')
  })
})

describe('bundled skills subset', () => {
  it('serves the bundled skills with source=bundled', async () => {
    const project = await projectRoot('bundled')
    const ctx = await setup({ dshHome: join(project, 'nohome') })
    const skills = await ctx.skills.list({ cwd: project })
    const names = skills.map(s => s.name)
    expect(names).toContain('simplify')
    expect(names).toContain('debug')
    expect(names).toContain('batch')

    const simplify = skills.find(s => s.name === 'simplify')
    expect(simplify?.source).toBe('bundled')
    expect(simplify?.provider).toBe('claude-code')
    const batch = skills.find(s => s.name === 'batch')
    expect(batch?.invocation.modelInvocable).toBe(false)
    expect(batch?.invocation.userInvocable).toBe(true)
  })

  it('renders the bundled skill body through get()', async () => {
    const project = await projectRoot('bundled-body')
    const ctx = await setup({ dshHome: join(project, 'nohome') })
    const loaded = await ctx.skills.get('simplify', { cwd: project })
    expect(loaded?.source).toBe('bundled')
    expect(loaded?.content).toContain('Simplify: Code Review and Cleanup')
    expect(loaded?.metadata?.deprecated).toBe(false)
  })

  it('lets a project skill of the same name win over the bundled one', async () => {
    const project = await projectRoot('bundled-override')
    await writeSkill(
      join(project, '.claude', 'skills'),
      'simplify',
      'name: simplify\ndescription: Project-local simplify',
    )
    const ctx = await setup({ dshHome: join(project, 'nohome') })
    const loaded = await ctx.skills.get('simplify', { cwd: project })
    expect(loaded?.source).toBe('project-dsh')
    expect(loaded?.content).toBe('Body.\n')
  })

  it('exposes the bundled set through the module', () => {
    const bundled = SkillCc.discoverBundledSkills()
    expect(bundled.map(b => b.name).sort()).toEqual(['batch', 'debug', 'simplify'])
  })
})
