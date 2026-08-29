import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULTS as MICROCOMPACT_DEFAULTS } from '../../../compaction/compaction-micro/src/config.ts'

const req = createRequire(import.meta.url)
const includePkg = req.resolve('@deepseek-ai/cordis-plugin-include/package.json')

interface CompactionAnchor {
  readonly source: string
  readonly file: string
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir).filter((entry) => statSync(join(dir, entry)).isDirectory())
  } catch {
    return []
  }
}

/**
 * Prefer the linked deepseek-harness checkout used by dsh-cc development.
 * Falling back to the deployed package catches the important case where the
 * repo is tested against a newer checkout than the user's actual dsh install.
 */
function resolveCompactionAnchor(): CompactionAnchor | undefined {
  try {
    const real = realpathSync(includePkg)
    let cur = dirname(real)
    for (let i = 0; i < 5; i++) {
      const source = join(cur, 'packages', 'compaction', 'compaction-basic', 'src', 'region.ts')
      if (existsSync(source)) {
        return { file: source, source: `linked upstream checkout (${cur})` }
      }
      cur = dirname(cur)
    }
  } catch {
    // no linked checkout; fall through to deployed-package inspection
  }

  const candidates: string[] = []
  const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  candidates.push(join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-compaction-basic', 'lib', 'index.js'))

  const npxRoot = join(process.env.HOME ?? '', '.npm', '_npx')
  for (const entry of safeReaddir(npxRoot)) {
    candidates.push(join(
      npxRoot,
      entry,
      'node_modules',
      '@deepseek-ai',
      'dsh-compaction-basic',
      'lib',
      'index.js',
    ))
  }

  const existing = candidates
    .filter(existsSync)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  const file = existing[0]
  return file === undefined ? undefined : { file, source: `deployment install (${file})` }
}

const anchor = resolveCompactionAnchor()
if (!anchor) {
  console.warn('[compaction-cache] no linked or deployed compaction-basic found; semantic gate skipped')
}

/**
 * The upstream cache-aware summarizer must reconstruct the routed request
 * header and replay the selected region's derived messages before appending the
 * compaction instruction. These are semantic markers, not a version check: a
 * backport is accepted and a newer version that regresses the contract fails.
 */
describe('compaction prefix-cache contract', () => {
  it.runIf(!!anchor)(
    'reuses system, tool schemas, and routed region messages for summarization',
    () => {
      const source = readFileSync(anchor!.file, 'utf8')
      expect(source, `missing requestHeader() in ${anchor!.source}`).toContain('requestHeader()')
      expect(source, `missing deriveEventMessage() in ${anchor!.source}`).toContain('deriveEventMessage')

      // Source TS and the published JS preserve these identifiers today. Keep
      // the assertions intentionally structural so formatting/minor refactors do
      // not turn this into a byte-for-byte upstream source pin.
      expect(source, `system prompt is not forwarded by ${anchor!.source}`)
        .toMatch(/system[^\n]{0,160}header\.system|header\.system[^\n]{0,160}system/s)
      expect(source, `tool schemas are not forwarded by ${anchor!.source}`)
        .toMatch(/tools[^\n]{0,160}header\.tools|header\.tools[^\n]{0,160}tools/s)
      expect(source, `region messages are not replayed by ${anchor!.source}`)
        .toMatch(/messages[^\n]{0,160}regionMessages|regionMessages[^\n]{0,160}messages/s)
    },
  )

  it('keeps dsh-cc microcompaction opt-in so it cannot rewrite a warm prefix every turn by default', () => {
    expect(MICROCOMPACT_DEFAULTS.auto).toBe(false)
  })
})
