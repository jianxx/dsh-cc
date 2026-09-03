#!/usr/bin/env node
/**
 * report-capability-freshness.mjs — Phase 2 freshness report for
 * docs/claude-code-capabilities.yaml (spec: docs/plans/2026-09-03-
 * claude-code-capability-manifest.md Phase 2 Unit A, §8 freshness semantics).
 *
 *   node scripts/report-capability-freshness.mjs                  # report, exit 0
 *   node scripts/report-capability-freshness.mjs --fail-on-stale  # CI gate
 *   node scripts/report-capability-freshness.mjs --manifest <path>
 *
 * Sections: header, "Stale baselines (N)" — capabilities whose NEWEST valid
 * upstream.refs retrieved date is older than baseline.freshness_threshold_days
 * (same math as the shared lib's I8 warnings) — and "Backfill queue:
 * capabilities with empty refs (M)" for upstream.refs: [] entries. One line
 * per item, sorted by id. The report never fails on stale/backfill entries by
 * default; --fail-on-stale exits 1 when the stale section is non-empty.
 * Zero deps beyond js-yaml via the shared lib.
 */
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { loadManifest, capabilityFreshness } from "./lib/capability-manifest.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { failOnStale: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fail-on-stale") args.failOnStale = true;
    else if (a === "--root") args.root = argv[++i];
    else if (a === "--manifest") args.manifest = argv[++i];
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(args.root ?? join(__dirname, ".."));
  const manifestRel = args.manifest ?? "docs/claude-code-capabilities.yaml";
  const absManifest = isAbsolute(manifestRel) ? manifestRel : join(root, manifestRel);

  let manifest;
  try {
    manifest = loadManifest(root, manifestRel);
  } catch (e) {
    console.error(`capability freshness report failed: ${e.message}`);
    process.exit(1);
  }

  const threshold = manifest.baseline?.freshness_threshold_days;
  const stale = [];
  const backfill = [];
  for (const [id, cap] of Object.entries(manifest.capabilities ?? {})) {
    const f = capabilityFreshness(manifest, id, cap ?? {});
    if (f.newest === null) backfill.push({ id, refs: f.refs.length });
    else if (f.stale) stale.push({ id, newest: f.newest, ageDays: f.ageDays });
  }
  // Stable order by capability id.
  stale.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  backfill.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  console.log(
    `Capability freshness report — ${absManifest} (threshold: ${typeof threshold === "number" ? `${threshold} days` : "unset"})`,
  );
  console.log("");
  console.log(`Stale baselines (${stale.length})`);
  if (stale.length === 0) console.log("  (none)");
  for (const s of stale) {
    console.log(`  - ${s.id}: newest retrieved ${iso(s.newest)} is ${s.ageDays} days old (threshold: ${threshold} days)`);
  }
  console.log("");
  console.log(`Backfill queue: capabilities with empty refs (${backfill.length})`);
  if (backfill.length === 0) console.log("  (none)");
  for (const b of backfill) console.log(`  - ${b.id}: upstream.refs is empty — add a ref with a retrieved date`);
  console.log("");
  console.log(
    `Summary: ${Object.keys(manifest.capabilities ?? {}).length} capabilities, ` +
      `${stale.length} stale, ${backfill.length} awaiting backfill.`,
  );

  if (args.failOnStale && stale.length > 0) {
    console.error(`\n--fail-on-stale: ${stale.length} stale baseline(s) — re-verify upstream refs (see docs/dev.md, "Capability freshness ritual").`);
    process.exit(1);
  }
  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
