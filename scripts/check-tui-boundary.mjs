#!/usr/bin/env node
/**
 * Only packages/ui/tui/src/harness/* and the cordis plugin surface
 * (index.ts, invariant.ts) may import @deepseek-ai/*. UI/store modules stay
 * harness-free so the Ink tree does not pull a second cordis copy.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'packages', 'ui', 'tui', 'src')
const ALLOW = new Set([
  'index.ts',
  'invariant.ts',
  'plugin.ts',
])

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) yield p
  }
}

const problems = []
for (const file of walk(SRC)) {
  const rel = relative(SRC, file)
  if (rel.startsWith(`harness/`) || ALLOW.has(rel)) continue
  const text = readFileSync(file, 'utf8')
  if (text.includes('@deepseek-ai/')) {
    problems.push(rel)
  }
}

if (problems.length > 0) {
  console.error('check:tui-boundary — @deepseek-ai imports outside harness/:\n')
  for (const p of problems) console.error(`  ${p}`)
  process.exit(1)
}
