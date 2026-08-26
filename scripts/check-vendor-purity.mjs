#!/usr/bin/env node
/**
 * check-vendor-purity.mjs — the vendored pi-tui renderer must stay pure:
 * packages/ui/pi-tui/** imports nothing outside its own tree beyond its two
 * declared npm deps (marked, get-east-asian-width) and node builtins.
 * Exit 0 when clean; lists offending files and exits 1 otherwise.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = join(ROOT, 'packages', 'ui', 'pi-tui')
const SRC = join(PKG, 'src')

if (!existsSync(SRC)) {
  console.log('check:vendor-purity — no packages/ui/pi-tui/src, skipping')
  process.exit(0)
}

const ALLOWED_BARE = new Set(['marked', 'get-east-asian-width'])
const BUILTINS = new Set([...builtinModules, ...builtinModules.map(m => `node:${m.replace(/^node:/, '')}`)])

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) yield p
  }
}

const IMPORT_RE = /(?:\bimport\b[^'";]*?|\bexport\b[^'";]*?\bfrom\s*)\bfrom\s*['"]([^'"]+)['"]|(?:\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g

const problems = []
for (const file of walk(SRC)) {
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2]
    if (spec === undefined) continue
    if (spec.startsWith('.') || spec.startsWith('#')) continue
    if (BUILTINS.has(spec) || BUILTINS.has(spec.split('/')[0])) continue
    const pkgName = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
    if (!ALLOWED_BARE.has(pkgName)) {
      problems.push(`${relative(SRC, file)} imports disallowed specifier "${spec}"`)
    }
  }
}

if (problems.length > 0) {
  console.error('check:vendor-purity — vendored pi-tui must stay pure:\n')
  for (const p of problems) console.error(`  ${p}`)
  process.exit(1)
}
