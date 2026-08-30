#!/usr/bin/env node
/**
 * Benchmark bin: boot the composition, run a cache trajectory, print the
 * console table, and optionally write the JSON report.
 *
 *   pnpm exec tsx packages/test-support/cache-trajectory/src/bin.ts [flags]
 *
 * Flags:
 *   --trajectory <path>   trajectory JSON (default: built-in standard.json)
 *   --out <path>          write the report JSON to <path>
 *   --report-only <path>  validate + render an existing report JSON, no run
 *   --base-url <url>      point the DeepSeek adapter at an OpenAI-compatible
 *                         mock server (keyless benchmarking)
 *   --provider <id>       override the trajectory's provider route
 *   --model <id>          override the trajectory's model id
 *   --api-key <key>       seed DEEPSEEK_API_KEY (mock runs); a real key also
 *                         comes from the ambient env or a .env in cwd
 *   --no-cc-plugins       skip the dsh-cc agent-plane plugins
 *   --no-cache-expected   shape-only verdict (mock usage carries no cache
 *                         buckets)
 *
 * Calibration tool, not a gate: ALWAYS exits 0. The verdict lives in the
 * report (`verdict`/`failures`); collect distributions with --out before
 * tightening the formal thresholds.
 * @module @jianxx/dsh-cc-cache-trajectory/bin
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { loadEnv } from '@deepseek-ai/dsh-app-boot'
import { Context } from '@deepseek-ai/cordis'
import {
  CACHE_E2E_MIN_HIT_RATE_ENV,
  cacheTrajectoryReportSchema,
  loadStandardTrajectory,
  parseTrajectory,
  renderReportTable,
  runCacheTrajectory,
  thresholdsFromEnv,
} from './index.ts'
import { mountTrajectoryTestStack } from './testing.ts'

const NAME = 'cache-trajectory-bin'

interface BinOptions {
  trajectoryPath?: string
  outPath?: string
  reportOnlyPath?: string
  baseURL?: string
  provider?: string
  model?: string
  apiKey?: string
  ccPlugins: boolean
  cacheHitsExpected: boolean
}

function parseArgs(argv: readonly string[]): BinOptions {
  const options: BinOptions = { ccPlugins: true, cacheHitsExpected: true }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = (): string => {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`${NAME}: flag ${flag} expects a value`)
      }
      i += 1
      return next
    }
    switch (flag) {
      case '--trajectory': options.trajectoryPath = value(); break
      case '--out': options.outPath = value(); break
      case '--report-only': options.reportOnlyPath = value(); break
      case '--base-url': options.baseURL = value(); break
      case '--provider': options.provider = value(); break
      case '--model': options.model = value(); break
      case '--api-key': options.apiKey = value(); break
      case '--no-cc-plugins': options.ccPlugins = false; break
      case '--no-cache-expected': options.cacheHitsExpected = false; break
      default: throw new Error(`${NAME}: unknown flag ${flag}`)
    }
  }
  return options
}

function loadTrajectory(path: string | undefined) {
  if (path === undefined) return loadStandardTrajectory()
  return parseTrajectory(JSON.parse(readFileSync(path, 'utf8')))
}

/** Validate + render an existing report; no run. */
function reportOnly(path: string): void {
  const report = cacheTrajectoryReportSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  process.stdout.write(`${renderReportTable(report)}\n`)
}

async function run(options: BinOptions): Promise<string> {
  const trajectory = loadTrajectory(options.trajectoryPath)
  if (options.apiKey !== undefined) process.env.DEEPSEEK_API_KEY ??= options.apiKey
  loadEnv(NAME)

  const ctx = new Context()
  let output = ''
  try {
    await mountTrajectoryTestStack(ctx, {
      persona: trajectory.persona,
      ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
      ccPlugins: options.ccPlugins,
    })
    const result = await runCacheTrajectory(ctx, trajectory, {
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      cacheHitsExpected: options.cacheHitsExpected,
      thresholds: thresholdsFromEnv(trajectory.thresholds, process.env[CACHE_E2E_MIN_HIT_RATE_ENV]),
    })
    output = renderReportTable(result.report)
    if (options.outPath !== undefined) {
      writeFileSync(options.outPath, `${JSON.stringify(result.report, null, 2)}\n`)
      output += `\nreport written to ${options.outPath}`
    }
  } finally {
    await ctx.fiber.dispose()
  }
  return output
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (options.reportOnlyPath !== undefined) {
    reportOnly(options.reportOnlyPath)
    return
  }
  process.stdout.write(`${await run(options)}\n`)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${NAME}: ${message}\n`)
  // Deliberate: the bin is a measurement tool — a failed run is still a
  // successful measurement (the report/table carries the verdict).
  process.exitCode = 0
})
