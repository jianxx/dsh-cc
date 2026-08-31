#!/usr/bin/env node
/**
 * check-file-size.mjs — presubmit gate: line-budget ratchet over
 * implementation source.
 *
 * Scope decision: implementation source only, and .ts-only on purpose
 * (no tracked non-.ts file in this repo approaches the budget). Tests are
 * intentionally NOT gated: spec files legitimately grow with behavioral
 * matrices, and the repo splits them on describe axes at its own cadence.
 * Test-like = any .ts under a `tests/` path segment, or named
 * *.spec.ts / *.test.ts / *.e2e.ts; *.d.ts counts as source.
 *
 * Vendored exemption: packages/ui/pi-tui is vendored byte-identical from
 * upstream (provenance + re-vendor protocol: packages/ui/pi-tui/PORTING.md).
 * Re-vendoring replaces src/ wholesale, so any local file split would be
 * destroyed and redone on every upstream SHA bump — the subtree is exempt
 * from this gate instead of being split. Keep VENDOR_EXEMPT in sync with
 * PKG in check-vendor-purity.mjs.
 *
 * Ratchet: scripts/check-file-size.baseline.json maps over-budget source
 * files to their admitted line count. Default mode fails on: new
 * over-budget files, baselined growth, obsolete (now ≤ limit) entries and
 * stale (deleted) entries. A baselined file that shrank passes with a
 * warning until `pnpm check:size --ratchet` rewrites the baseline. An empty
 * baseline is equivalent to a plain ≤500 hard limit.
 *
 * Exit 0 when clean (shrink warnings allowed); exit 1 on any failure.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_LIMIT = 500;
// keep in sync with PKG in scripts/check-vendor-purity.mjs
const VENDOR_EXEMPT = "packages/ui/pi-tui";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(SCRIPT_DIR, "..");
const DEFAULT_BASELINE = join(SCRIPT_DIR, "check-file-size.baseline.json");
const SKIP_DIRS = new Set(["node_modules", "dist", "lib"]);

function* walkTs(dir, root) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (relative(root, p).split(sep).includes(".claude")) continue;
    if (statSync(p).isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      yield* walkTs(p, root);
    } else if (entry.endsWith(".ts")) {
      yield p;
    }
  }
}

function countLines(file) {
  const text = readFileSync(file, "utf8");
  const newlines = text.split("\n").length - 1;
  return text.length > 0 && !text.endsWith("\n") ? newlines + 1 : newlines;
}

function isTestLike(relPosix, base) {
  if (base.endsWith(".d.ts")) return false; // declaration files count as source
  return (
    relPosix.split("/").includes("tests") ||
    base.endsWith(".spec.ts") ||
    base.endsWith(".test.ts") ||
    base.endsWith(".e2e.ts")
  );
}

function isExempt(relPosix) {
  return relPosix === VENDOR_EXEMPT || relPosix.startsWith(VENDOR_EXEMPT + "/");
}

/** Gated source files under `<root>/packages`: [{ relPosix, lines }]. */
export function scanSourceFiles(root) {
  const packagesDir = join(root, "packages");
  if (!existsSync(packagesDir)) return [];
  const files = [];
  for (const file of walkTs(packagesDir, root)) {
    const relPosix = relative(root, file).split(sep).join("/");
    if (isTestLike(relPosix, file.split(sep).pop()) || isExempt(relPosix)) continue;
    files.push({ relPosix, lines: countLines(file) });
  }
  return files;
}

/**
 * Ratchet evaluation. Returns { failures, warnings, scanned, baselined } —
 * failures block (exit 1); warnings are advisory (file shrank but the
 * baseline has not been tightened yet).
 */
export function evaluateRatchet(files, baseline) {
  const failures = [];
  const warnings = [];
  const onDisk = new Set(files.map((f) => f.relPosix));
  let baselined = 0;
  for (const { relPosix, lines } of files) {
    const admitted = baseline[relPosix];
    if (admitted === undefined) {
      if (lines > SOURCE_LIMIT) {
        failures.push(
          `${relPosix}: new file over budget: ${lines} lines (limit ${SOURCE_LIMIT})` +
            ` — split it or get explicit exemption`,
        );
      }
      continue;
    }
    baselined++;
    if (lines > admitted) {
      failures.push(
        `${relPosix}: grew from ${admitted} to ${lines} lines (limit ${SOURCE_LIMIT})` +
          ` — reduce below ${admitted} or split the file`,
      );
    } else if (lines <= SOURCE_LIMIT) {
      failures.push(
        `${relPosix}: obsolete baseline entry (${lines} ≤ ${SOURCE_LIMIT})` +
          ` — run pnpm check:size --ratchet`,
      );
    } else if (lines < admitted) {
      warnings.push(
        `${relPosix}: shrank ${admitted}→${lines}` +
          ` — run pnpm check:size --ratchet to tighten`,
      );
    }
  }
  for (const relPosix of Object.keys(baseline)) {
    if (!onDisk.has(relPosix)) {
      failures.push(`${relPosix}: stale entry (file no longer exists) — run pnpm check:size --ratchet`);
    }
  }
  return { failures, warnings, scanned: files.length, baselined };
}

/** Next baseline: every currently over-budget source file, keys sorted. */
export function buildBaseline(files) {
  const next = {};
  for (const { relPosix, lines } of files) {
    if (lines > SOURCE_LIMIT) next[relPosix] = lines;
  }
  return Object.fromEntries(Object.entries(next).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export function parseArgs(argv) {
  const opts = { root: DEFAULT_ROOT, baseline: DEFAULT_BASELINE, ratchet: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") opts.root = argv[++i];
    else if (argv[i] === "--baseline") opts.baseline = argv[++i];
    else if (argv[i] === "--ratchet") opts.ratchet = true;
  }
  return opts;
}

function runCli(opts) {
  const files = scanSourceFiles(opts.root);
  if (opts.ratchet) {
    const previous = existsSync(opts.baseline)
      ? JSON.parse(readFileSync(opts.baseline, "utf8"))
      : {};
    const next = buildBaseline(files);
    mkdirSync(dirname(opts.baseline), { recursive: true });
    writeFileSync(opts.baseline, JSON.stringify(next, null, 2) + "\n");
    const removed = Object.keys(previous).filter((k) => !(k in next));
    const added = Object.keys(next).filter((k) => !(k in previous));
    const tightened = Object.keys(next).filter((k) => k in previous && next[k] < previous[k]);
    const count = Object.keys(next).length;
    console.log(`check:size --ratchet — baseline written: ${count} entr${count === 1 ? "y" : "ies"}`);
    if (removed.length) console.log(`  removed: ${removed.join(", ")}`);
    if (added.length) console.log(`  added: ${added.join(", ")}`);
    for (const k of tightened) console.log(`  tightened: ${k} ${previous[k]}→${next[k]}`);
    return 0;
  }
  const baseline = existsSync(opts.baseline)
    ? JSON.parse(readFileSync(opts.baseline, "utf8"))
    : {};
  const { failures, warnings, scanned, baselined } = evaluateRatchet(files, baseline);
  if (warnings.length) {
    console.error("check:size — warnings:");
    for (const w of warnings) console.error(`  ${w}`);
  }
  if (failures.length) {
    console.error(`check:size — ${failures.length} violation(s):`);
    for (const f of failures) console.error(`  ${f}`);
    return 1;
  }
  console.log(`check:size OK — ${scanned} gated files scanned, ${baselined} baselined`);
  return 0;
}

/* c8 ignore below: CLI entry (same pattern as check-spec-deps.mjs) */
const isDirectRun =
  process.argv[1] && process.argv[1].endsWith("check-file-size.mjs");
if (isDirectRun) process.exit(runCli(parseArgs(process.argv.slice(2))));
