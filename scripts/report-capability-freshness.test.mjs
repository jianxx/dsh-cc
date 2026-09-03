#!/usr/bin/env node
/**
 * report-capability-freshness.test.mjs — self-running test harness for the
 * freshness report CLI (spec: docs/plans/2026-09-03-claude-code-capability-manifest.md
 * Phase 2 Unit A).
 *
 * Plain node:assert harness (same style as generate-parity-matrix.test.mjs).
 * Builds fixture manifests in temp dirs — retrieved dates are computed
 * RELATIVE TO NOW (e.g. threshold+30 days ago) so the fixtures never rot —
 * and runs scripts/report-capability-freshness.mjs as a subprocess.
 */
import { spawnSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORT = join(__dirname, "report-capability-freshness.mjs");
const TMP = mkdtempSync(join(tmpdir(), "freshness-test-"));

const DAY = 86_400_000;
const THRESHOLD = 120;
/** ISO date `days` days in the past (relative to today — no time bombs). */
const daysAgo = (days) => new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
/** ISO date `days` days in the future. */
const daysAhead = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

function manifestYaml({ threshold = THRESHOLD } = {}) {
  return `manifest_version: 1

baseline:
  upstream: claude-code
  sources:
    - id: cc-docs
      kind: context7
      ref: /websites/code_claude
      url: https://code.claude.com/docs
      retrieved: "${daysAgo(1)}"
  freshness_threshold_days: ${threshold}

categories:
  - { id: engine, title: Engine subsystems }

capabilities:
  engine.fresh:
    title: Fresh capability
    category: engine
    upstream:
      refs:
        - { source: cc-docs, path: /docs/fresh, retrieved: "${daysAgo(10)}" }
    dimensions:
      recognized: true
      mounted: true
      behavioral: full
      ux: full
    evidence: []
  engine.stale:
    title: Stale capability
    category: engine
    upstream:
      refs:
        - { source: cc-docs, path: /docs/stale, retrieved: "${daysAgo(THRESHOLD + 30)}" }
    dimensions:
      recognized: true
      mounted: true
      behavioral: full
      ux: full
    evidence: []
  engine.no-refs:
    title: Backfill candidate
    category: engine
    upstream:
      refs: []
    dimensions:
      recognized: false
      mounted: false
      behavioral: missing
      ux: missing
    evidence: []
`;
}

function makeTree(yaml = manifestYaml(), manifestRel = "docs/claude-code-capabilities.yaml") {
  const root = mkdtempSync(join(TMP, "tree-"));
  const p = join(root, manifestRel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, yaml);
  return root;
}

function run(root, args = []) {
  const res = spawnSync("node", [REPORT, "--root", root, ...args], { encoding: "utf-8" });
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status };
}

let failures = 0;
function pass(name) { console.log(`[PASS] ${name}`); }
function fail(name, detail) { console.error(`[FAIL] ${name}: ${detail}`); failures++; }
function case_(name, fn) {
  try { fn(); pass(name); } catch (e) { fail(name, e.message); }
}

case_("all-fresh manifest → exit 0, no stale section content", () => {
  const allFresh = manifestYaml().replace(
    new RegExp(`retrieved: "${daysAgo(THRESHOLD + 30)}"`),
    `retrieved: "${daysAgo(1)}"`,
  );
  const root = makeTree(allFresh);
  const r = run(root);
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  assert.ok(!r.stdout.includes("Stale baselines (1)"), `stale section listed items:\n${r.stdout}`);
  assert.ok(r.stdout.includes("Stale baselines (0)"), `stale section header missing:\n${r.stdout}`);
  assert.ok(!r.stdout.includes("engine.stale"), "stale id listed on an all-fresh manifest");
  rmSync(root, { recursive: true, force: true });
});

let root, r;
case_("one stale capability → listed with id, dates, age in days; default exit 0", () => {
  root = makeTree();
  r = run(root);
  assert.equal(r.status, 0, `default (report mode) must exit 0, got ${r.status}`);
  assert.ok(r.stdout.includes("Stale baselines (1)"), `stale header missing:\n${r.stdout}`);
  const line = r.stdout.split("\n").find((l) => l.includes("engine.stale"));
  assert.ok(line, `engine.stale not listed:\n${r.stdout}`);
  assert.ok(line.includes(daysAgo(THRESHOLD + 30)), `retrieved date missing: ${line}`);
  assert.ok(/\b150\b/.test(line), `age in days missing: ${line}`);
  assert.ok(line.includes(String(THRESHOLD)) || r.stdout.includes(String(THRESHOLD)), "threshold not mentioned");
});

case_("--fail-on-stale with a stale entry → exit 1 and the entry listed", () => {
  const r2 = run(root, ["--fail-on-stale"]);
  assert.equal(r2.status, 1, `expected exit 1, got ${r2.status}`);
  assert.ok(r2.stdout.includes("engine.stale"), "stale entry not listed under --fail-on-stale");
});

case_("capabilities with empty refs → backfill queue, never failing", () => {
  assert.ok(r.stdout.includes("Backfill queue"), `backfill section missing:\n${r.stdout}`);
  const line = r.stdout.split("\n").find((l) => l.includes("engine.no-refs"));
  assert.ok(line, "engine.no-refs not in backfill queue");
  assert.equal(r.status, 0, "empty refs must not fail the report");
  // empty refs are never counted stale
  const staleSection = r.stdout.slice(r.stdout.indexOf("Stale baselines"), r.stdout.indexOf("Backfill queue"));
  assert.ok(!staleSection.includes("engine.no-refs"), "empty-refs capability leaked into stale section");
});

case_("--manifest override honored; missing manifest → exit 1 with clear message", () => {
  const root2 = makeTree(manifestYaml(), "other/caps.yaml");
  const r2 = run(root2, ["--manifest", "other/caps.yaml"]);
  assert.equal(r2.status, 0, `override not honored: ${r2.stderr}`);
  assert.ok(r2.stdout.includes("Backfill queue"), "override manifest not rendered");
  rmSync(root2, { recursive: true, force: true });

  const r3 = run(root, ["--manifest", "docs/does-not-exist.yaml"]);
  assert.equal(r3.status, 1, `expected exit 1, got ${r3.status}`);
  assert.ok(/not found|does-not-exist/i.test(r3.stdout + r3.stderr), `unclear error: ${r3.stderr}${r3.stdout}`);
});

case_("multiple refs: only the NEWEST retrieved decides staleness", () => {
  const yaml = `manifest_version: 1

baseline:
  upstream: claude-code
  sources:
    - id: cc-docs
      kind: context7
      ref: /websites/code_claude
      retrieved: "${daysAgo(1)}"
  freshness_threshold_days: ${THRESHOLD}

categories:
  - { id: engine, title: Engine subsystems }

capabilities:
  engine.multi:
    title: Mixed-age refs
    category: engine
    upstream:
      refs:
        - { source: cc-docs, path: /docs/old, retrieved: "${daysAgo(THRESHOLD + 90)}" }
        - { source: cc-docs, path: /docs/new, retrieved: "${daysAgo(5)}" }
    dimensions:
      recognized: true
      mounted: true
      behavioral: full
      ux: full
    evidence: []
`;
  const root2 = makeTree(yaml);
  const r2 = run(root2);
  assert.equal(r2.status, 0, `newest ref must keep it fresh: ${r2.stdout}${r2.stderr}`);
  assert.ok(!r2.stdout.includes("engine.multi"), "oldest ref wrongly decided staleness");
  rmSync(root2, { recursive: true, force: true });
});

rmSync(TMP, { recursive: true, force: true });
console.log(failures === 0 ? "\nAll freshness-report tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
