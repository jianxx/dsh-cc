#!/usr/bin/env node
/**
 * check-file-size.test.mjs — self-running test harness for the
 * check-file-size ratchet gate.
 *
 * Uses node:assert/strict + node:child_process (NOT vitest; the repo
 * vitest config only includes spec files under packages/<category>/<pkg>/tests).
 * Builds throwaway package trees in a temp dir and runs the gate as a
 * subprocess with --root/--baseline overrides.
 */
import { spawnSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GATE = join(__dirname, "check-file-size.mjs");
const TMP = mkdtempSync(join(tmpdir(), "check-file-size-test-"));

function linesOf(n) {
  const arr = [];
  for (let i = 0; i < n; i++) arr.push(`line ${i + 1}`);
  return arr.join("\n") + "\n";
}

function makeTree(files) {
  const root = mkdtempSync(join(TMP, "tree-"));
  mkdirSync(join(root, "packages"), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

function spawnGate(root, baselinePath, args) {
  const res = spawnSync(
    "node",
    [GATE, "--root", root, "--baseline", baselinePath, ...args],
    { encoding: "utf-8" },
  );
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status };
}

function runGate(root, baselineObj, args = []) {
  const baselinePath = join(root, "baseline.json");
  writeFileSync(baselinePath, JSON.stringify(baselineObj ?? {}, null, 2) + "\n");
  return { ...spawnGate(root, baselinePath, args), baselinePath };
}

let failures = 0;
function pass(name) {
  console.log(`[PASS] ${name}`);
}
function fail(name, detail) {
  console.error(`[FAIL] ${name}: ${detail}`);
  failures++;
}

function case_(name, fn) {
  try {
    fn();
    pass(name);
  } catch (e) {
    fail(name, e.message);
  }
}

// --- (a) new >500 source file fails. ---
case_("FAIL: new source file over budget", () => {
  const root = makeTree({ "packages/g/p/src/big.ts": linesOf(501) });
  const { stderr, status } = runGate(root, {});
  assert.equal(status, 1, `expected exit 1, got ${status}\n${stderr}`);
  assert.ok(stderr.includes("new file over budget"), stderr);
  assert.ok(stderr.includes("split it or get explicit exemption"), stderr);
});

// --- (b) baselined growth fails. ---
case_("FAIL: baselined file grew", () => {
  const rel = "packages/g/p/src/big.ts";
  const root = makeTree({ [rel]: linesOf(601) });
  const { stderr, status } = runGate(root, { [rel]: 600 });
  assert.equal(status, 1, `expected exit 1, got ${status}\n${stderr}`);
  assert.ok(stderr.includes(`grew from 600 to 601`), stderr);
});

// --- (c) shrink passes with warning. ---
case_("WARN+PASS: baselined file shrank", () => {
  const rel = "packages/g/p/src/big.ts";
  const root = makeTree({ [rel]: linesOf(550) });
  const { stdout, stderr, status } = runGate(root, { [rel]: 600 });
  assert.equal(status, 0, `expected exit 0, got ${status}\n${stderr}`);
  assert.ok(stderr.includes(`shrank 600→550`), stderr);
  assert.ok(stderr.includes("run pnpm check:size --ratchet to tighten"), stderr);
  assert.ok(stdout.includes("check:size OK"), stdout);
});

// --- (d) obsolete entry (now ≤500) fails with instruction. ---
case_("FAIL: obsolete baseline entry", () => {
  const rel = "packages/g/p/src/big.ts";
  const root = makeTree({ [rel]: linesOf(400) });
  const { stderr, status } = runGate(root, { [rel]: 600 });
  assert.equal(status, 1, `expected exit 1, got ${status}\n${stderr}`);
  assert.ok(stderr.includes("obsolete baseline entry"), stderr);
  assert.ok(stderr.includes("run pnpm check:size --ratchet"), stderr);
});

// --- (e) missing baselined path fails stale. ---
case_("FAIL: stale baseline entry", () => {
  const root = makeTree({ "packages/g/p/src/ok.ts": linesOf(10) });
  const { stderr, status } = runGate(root, { "packages/g/p/src/gone.ts": 600 });
  assert.equal(status, 1, `expected exit 1, got ${status}\n${stderr}`);
  assert.ok(stderr.includes("stale entry"), stderr);
});

// --- (f) tests/ dir, .spec.ts, .e2e.ts ignored. ---
case_("PASS: test-like files are not gated", () => {
  const root = makeTree({
    "packages/g/p/tests/huge.spec.ts": linesOf(900),
    "packages/g/p/src/plain.spec.ts": linesOf(800),
    "packages/g/p/src/flow.e2e.ts": linesOf(700),
    "packages/g/p/tests/case.test.ts": linesOf(600),
  });
  const { stdout, stderr, status } = runGate(root, {});
  assert.equal(status, 0, `expected exit 0, got ${status}\n${stderr}`);
  assert.ok(stdout.includes("0 gated files scanned"), stdout);
});

// --- (g) node_modules/lib/dist skipped. ---
case_("PASS: node_modules/lib/dist skipped", () => {
  const root = makeTree({
    "packages/g/p/node_modules/dep.ts": linesOf(600),
    "packages/g/p/lib/bundle.ts": linesOf(600),
    "packages/g/p/dist/out.ts": linesOf(600),
  });
  const { stdout, stderr, status } = runGate(root, {});
  assert.equal(status, 0, `expected exit 0, got ${status}\n${stderr}`);
  assert.ok(stdout.includes("0 gated files scanned"), stdout);
});

// --- (h) pi-tui path exempt. ---
case_("PASS: vendored pi-tui exempt", () => {
  const root = makeTree({
    "packages/ui/pi-tui/src/components/editor.ts": linesOf(2363),
    "packages/ui/pi-tui/src/keys.ts": linesOf(1401),
  });
  const { stdout, stderr, status } = runGate(root, {});
  assert.equal(status, 0, `expected exit 0, got ${status}\n${stderr}`);
  assert.ok(stdout.includes("0 gated files scanned"), stdout);
});

// --- (i) --ratchet writes sorted deterministic JSON; re-run idempotent. ---
case_("RATCHET: sorted deterministic JSON, idempotent re-run", () => {
  const root = makeTree({
    "packages/b/src/a.ts": linesOf(700),
    "packages/a/src/z.ts": linesOf(600),
    "packages/a/src/small.ts": linesOf(20),
  });
  const first = runGate(root, {}, ["--ratchet"]);
  assert.equal(first.status, 0, `expected exit 0, got ${first.status}\n${first.stderr}`);
  const text1 = readFileSync(first.baselinePath, "utf8");
  const parsed = JSON.parse(text1);
  assert.deepEqual(parsed, {
    "packages/a/src/z.ts": 600,
    "packages/b/src/a.ts": 700,
  });
  assert.equal(text1, JSON.stringify(parsed, null, 2) + "\n", "raw format must be 2-space + trailing newline");
  assert.ok(text1.endsWith("\n"), "file must end with a newline");

  const second = spawnGate(root, first.baselinePath, ["--ratchet"]);
  assert.equal(second.status, 0, `expected exit 0, got ${second.status}\n${second.stderr}`);
  const text2 = readFileSync(first.baselinePath, "utf8");
  assert.equal(text2, text1, "re-ratchet must be idempotent");
  assert.ok(!second.stdout.includes("added:"), `expected no diff on re-run: ${second.stdout}`);
});

// --- (j) clean tree passes. ---
case_("PASS: clean tree", () => {
  const root = makeTree({
    "packages/g/p/src/ok.ts": linesOf(10),
    "packages/g/p/tests/ok.spec.ts": linesOf(10),
  });
  const { stdout, stderr, status } = runGate(root, {});
  assert.equal(status, 0, `expected exit 0, got ${status}\n${stderr}`);
  assert.ok(stdout.includes("1 gated files scanned, 0 baselined"), stdout);
});

// --- (k) *.d.ts counts as source, not test-like. ---
case_("FAIL: .d.ts counts as source", () => {
  const root = makeTree({ "packages/g/p/src/types.d.ts": linesOf(600) });
  const { stderr, status } = runGate(root, {});
  assert.equal(status, 1, `expected exit 1, got ${status}\n${stderr}`);
  assert.ok(stderr.includes("types.d.ts"), stderr);
});

rmSync(TMP, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} case(s) failed.`);
  process.exit(1);
}
console.log("check-file-size: all cases passed.");
