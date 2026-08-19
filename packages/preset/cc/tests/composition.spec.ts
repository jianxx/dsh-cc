import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

const req = createRequire(import.meta.url)
const includePkg = req.resolve('@deepseek-ai/cordis-plugin-include/package.json')
const yaml = createRequire(includePkg)('js-yaml') as typeof import('js-yaml')

const agentCordisPath = new URL('../agent.cordis.yml', import.meta.url).pathname
const presetYmlPath = new URL('../preset.yml', import.meta.url).pathname
const pkgJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const yamlText = readFileSync(agentCordisPath, 'utf8')
const doc = yaml.load(yamlText, { schema: entryListSchema }) as any[]

const BASE_IDS = [
  'persona', 'agent-instructions', 'tool-bash', 'tool-pwsh', 'tool-fs',
  'tool-fs-search', 'tool-jobs', 'skill-filesystem', 'tool-skill', 'tool-goal',
  'planning', 'compaction', 'delegation', 'tool-ask-user', 'tool-todo', 'tool-web',
]

// Locate a version-0.1.0-rc.6 dsh install, mirroring the drift-gate contract:
// newest-mtime-first across the `~/.npm/_npx` npx-install dirs (each holding a
// `node_modules/@deepseek-ai/dsh/package.json`) and the `~/.dsh/profiles`
// install. Returns undefined when none matches.
function findRc6Install(): string | undefined {
  const candidates: string[] = []
  const npxRoot = join(process.env.HOME ?? '', '.npm', '_npx')
  for (const entry of safeReaddir(npxRoot)) {
    const p = join(npxRoot, entry, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    if (existsSync(p)) candidates.push(p)
  }
  const profilePkg = join(
    process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh'),
    'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'package.json',
  )
  if (existsSync(profilePkg)) candidates.push(profilePkg)

  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return candidates.find((p) => {
    try {
      return JSON.parse(readFileSync(p, 'utf8')).version === '0.1.0-rc.6'
    } catch {
      return false
    }
  })
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir).filter((e) => statSync(join(dir, e)).isDirectory())
  } catch {
    return []
  }
}

const rc6Install = findRc6Install()

describe('agent.cordis.yml composition', () => {
  it('parses with the entryListSchema and carries string ids/names', () => {
    expect(Array.isArray(doc)).toBe(true)
    expect(doc.length).toBeGreaterThan(0)
    for (const row of doc) {
      expect(typeof row.id).toBe('string')
      expect(typeof row.name).toBe('string')
    }
    for (const row of doc) {
      if (row.name === 'cordis:group') {
        expect(row.group).toBe(true)
        expect(Array.isArray(row.config)).toBe(true)
      }
    }
  })

  it('has no duplicate top-level ids and keeps the 16 baseline rows', () => {
    const ids = doc.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const baseId of BASE_IDS) {
      expect(ids).toContain(baseId)
    }
  })

  it('isolates exactly the four cc-services services, hosting the two commands', () => {
    const group = doc.find((r) => r.id === 'cc-services')!
    expect(group.name).toBe('cordis:group')
    expect(group.isolate).toEqual({
      toolSearch: true,
      microcompactor: true,
      ccPlugins: true,
      mcpConnections: true,
    })
    const configIds = (group.config as any[]).map((r) => r.id)
    const topIds = doc.map((r) => r.id)
    expect(configIds).toContain('command-plugin')
    expect(configIds).toContain('command-mcp')
    // The two commands live inside the group, not duplicated at top level.
    expect(topIds).not.toContain('command-plugin')
    expect(topIds).not.toContain('command-mcp')
  })

  it('declares every @jianxx row name as a dependency', () => {
    const deps = Object.keys(pkgJson.dependencies ?? {})
    const rows = doc.filter((r) => r.name && r.name.startsWith('@jianxx/'))
    for (const row of rows) {
      expect(deps, `${row.id} -> ${row.name}`).toContain(row.name)
    }
  })

  it('resolves every @deepseek-ai row name against an installed deployment', () => {
    const rows = doc.filter((r) => r.name && r.name.startsWith('@deepseek-ai/'))
    const seen = new Set<string>()
    const names: string[] = []
    for (const row of rows) {
      const name = row.name.startsWith('@deepseek-ai/dsh-tool-subagent-control')
        ? '@deepseek-ai/dsh-tool-subagent-control'
        : row.name
      if (seen.has(name)) continue
      seen.add(name)
      names.push(name)
    }

    // Anchor to installed deployments (where @deepseek-ai/* actually lives at
    // runtime) — NOT the repo, which never installs upstream packages. Order:
    // profile install, then npx-cache installs (newest mtime first).
    const anchors: string[] = []
    const profileRoot = join(
      process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh'),
      'profiles', 'node_modules', '@deepseek-ai',
    )
    if (existsSync(join(profileRoot, 'dsh', 'package.json'))) anchors.push(profileRoot)
    const npxRoot = join(process.env.HOME ?? '', '.npm', '_npx')
    const npxDirs = safeReaddir(npxRoot)
      .map((d) => join(npxRoot, d, 'node_modules', '@deepseek-ai'))
      .filter((d) => existsSync(join(d, 'dsh', 'package.json')))
    npxDirs.sort(
      (a, b) =>
        statSync(join(b, 'dsh', 'package.json')).mtimeMs -
        statSync(join(a, 'dsh', 'package.json')).mtimeMs,
    )
    anchors.push(...npxDirs)

    if (anchors.length === 0) {
      // No dsh install on this machine — nothing to resolve against.
      console.warn(
        '[composition] no dsh deployment found; skipping @deepseek-ai resolution check',
      )
      return
    }

    const missing: string[] = []
    for (const name of names) {
      const ok = anchors.some((a) => existsSync(join(a, name.slice('@deepseek-ai/'.length), 'package.json')))
      if (!ok) missing.push(name)
    }
    expect(
      missing,
      `@deepseek-ai rows missing from every installed deployment:\n${missing.join('\n')}`,
    ).toEqual([])
  })

  it.runIf(!!rc6Install)(
    'curated baseline matches the vendored standard preset (drift gate)',
    () => {
      const vendoredBase = readFileSync(
        join(dirname(rc6Install!), 'config', 'agent-presets', 'standard', 'agent.cordis.yml'),
        'utf8',
      )
      const endToken = '# END dsh-cc header'
      const ccToken = '# ── cc rows ──'
      const start = yamlText.indexOf(endToken) + endToken.length + 1
      const end = yamlText.indexOf(ccToken)
      const myBase = yamlText.slice(start, end).trimEnd()

      const a = myBase.split('\n')
      const b = vendoredBase.trimEnd().split('\n')
      // LCS diff so inserted comment lines (above tool-web) are reported as
      // additions instead of shifting every later line out of alignment.
      const ops = lcsOps(a, b)
      const diffs: string[] = []
      for (const op of ops) {
        if (op.type === 'equal') continue
        const mine = op.a === -1 ? '' : a[op.a]
        const vend = op.b === -1 ? '' : b[op.b]
        // Whitelist: the tool-web config change (fetch/searchTimeoutMs lines,
        // any shape), comment-only lines added to document that change, and
        // the `disabled: true` additions on the harness subagent tool rows
        // (tool-subagent / tool-subagent-fork), whose Task is replaced by the
        // cc-services `tool-task` row. Only my-side additions are whitelisted —
        // an upstream `disabled: true` we drop would still be flagged.
        const isConfigChange =
          (op.a !== -1 && a[op.a].includes('fetch:')) ||
          (op.a !== -1 && a[op.a].includes('searchTimeoutMs:')) ||
          (op.b !== -1 && b[op.b].includes('fetch:')) ||
          (op.b !== -1 && b[op.b].includes('searchTimeoutMs:')) ||
          (op.a !== -1 && a[op.a].trim() === 'disabled: true')
        const isComment = mine.trimStart().startsWith('#') || vend.trimStart().startsWith('#')
        if (isConfigChange || isComment) continue
        diffs.push(
          `${op.type === 'add' ? '+' : '-'}  mine: ${mine}\n` +
            `${op.type === 'del' ? '-' : '+'}  vendored: ${vend}`,
        )
      }
      expect(
        diffs,
        `baseline drifted from the vendored standard preset (${rc6Install}); ` +
          `${diffs.length} diff line(s) outside the whitelist`,
      ).toEqual([])
    },
  )
})

/** Minimal LCS line-diff. Yields add/del/equal ops against both inputs. */
function lcsOps(a: string[], b: string[]): { type: 'add' | 'del' | 'equal'; a: number; b: number }[] {
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops: { type: 'add' | 'del' | 'equal'; a: number; b: number }[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ type: 'equal', a: i, b: j })
      i++
      j++
    } else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) {
      ops.push({ type: 'add', a: -1, b: j })
      j++
    } else {
      ops.push({ type: 'del', a: i, b: -1 })
      i++
    }
  }
  return ops
}

describe('preset.yml metadata', () => {
  it('has non-empty name/description and order 5', () => {
    const preset = yaml.load(readFileSync(presetYmlPath, 'utf8'), {
      schema: entryListSchema,
    }) as any
    expect(typeof preset.name).toBe('string')
    expect(preset.name.trim().length).toBeGreaterThan(0)
    expect(typeof preset.description).toBe('string')
    expect(preset.description.trim().length).toBeGreaterThan(0)
    expect(typeof preset.order).toBe('number')
    expect(Number.isFinite(preset.order)).toBe(true)
    expect(preset.order).toBe(5)
  })
})
