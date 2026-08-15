#!/usr/bin/env node
/**
 * check-subagent-paste.test.mjs — self-running test harness for the
 * check-subagent-paste Stop hook.
 *
 * Uses node:assert/strict + node:child_process (NOT vitest; the repo
 * vitest config only includes spec files under packages/<category>/<pkg>/tests).
 * Runs the hook as a subprocess with piped stdin for each case.
 */
import { spawnSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, "check-subagent-paste.mjs");

// Force non-strict mode in the subprocess regardless of inherited env
// so the HIT case asserts the systemMessage shape (not a block decision).
const ENV = { ...process.env, SUBAGENT_PASTE_HOOK: "" };

function runHook(stdin) {
  const res = spawnSync("node", [HOOK], {
    input: stdin,
    encoding: "utf-8",
    env: ENV,
  });
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status };
}

let failures = 0;
function pass(name) {
  console.log(`[PASS] ${name}`);
}
function fail(name, detail) {
  console.error(`[FAIL] ${name}: ${detail}`);
  failures++;
}

function quotedBlock(numLines) {
  const lines = [];
  for (let i = 0; i < numLines; i++) lines.push(`> filler line ${i + 1}`);
  return lines;
}

// --- HIT: 45-line '>'-quoted block with fast-worker contract headers. ---
{
  const block = quotedBlock(45);
  block[5] = "> Changed: src/foo.ts (edited), src/bar.ts (edited)";
  block[20] = "> Deviations: none";
  const payload = JSON.stringify({ last_assistant_message: block.join("\n") });
  const { stdout, status } = runHook(payload);
  try {
    assert.equal(status, 0, `expected exit 0, got ${status}`);
    assert.ok(
      stdout.includes("systemMessage"),
      `stdout should contain systemMessage, got: ${JSON.stringify(stdout)}`,
    );
    pass("HIT: 45-line >-quoted block with Changed: + Deviations:");
  } catch (e) {
    fail("HIT: 45-line >-quoted block with Changed: + Deviations:", e.message);
  }
}

// --- PASS 1: short normal message. ---
{
  const payload = JSON.stringify({ last_assistant_message: "Done. Edited 2 files." });
  const { stdout, status } = runHook(payload);
  try {
    assert.equal(status, 0, `expected exit 0, got ${status}`);
    assert.equal(stdout, "", `expected empty stdout, got: ${JSON.stringify(stdout)}`);
    pass("PASS: short normal message");
  } catch (e) {
    fail("PASS: short normal message", e.message);
  }
}

// --- PASS 2: ≥40-line quoted block with only ONE generic header. ---
{
  const block = quotedBlock(45);
  block[10] = "> Recommendation: approve";
  // No Risks/unknowns: line → deep-reasoner pair is incomplete.
  const payload = JSON.stringify({ last_assistant_message: block.join("\n") });
  const { stdout, status } = runHook(payload);
  try {
    assert.equal(status, 0, `expected exit 0, got ${status}`);
    assert.equal(stdout, "", `expected empty stdout, got: ${JSON.stringify(stdout)}`);
    pass("PASS: ≥40-line block with only Recommendation: (no pair)");
  } catch (e) {
    fail("PASS: ≥40-line block with only Recommendation: (no pair)", e.message);
  }
}

// --- FAIL-CLOSED 1: stdin is not JSON. ---
{
  const { stdout, status } = runHook("not json {{{");
  try {
    assert.equal(status, 0, `expected exit 0, got ${status}`);
    assert.equal(stdout, "", `expected empty stdout, got: ${JSON.stringify(stdout)}`);
    pass("FAIL-CLOSED: invalid JSON");
  } catch (e) {
    fail("FAIL-CLOSED: invalid JSON", e.message);
  }
}

// --- FAIL-CLOSED 2: valid JSON, no last_assistant_message field. ---
{
  const payload = JSON.stringify({ session_id: "abc", stop_hook_active: false });
  const { stdout, status } = runHook(payload);
  try {
    assert.equal(status, 0, `expected exit 0, got ${status}`);
    assert.equal(stdout, "", `expected empty stdout, got: ${JSON.stringify(stdout)}`);
    pass("FAIL-CLOSED: valid JSON without last_assistant_message");
  } catch (e) {
    fail("FAIL-CLOSED: valid JSON without last_assistant_message", e.message);
  }
}

if (failures > 0) {
  console.error(`\n${failures} case(s) failed.`);
  process.exit(1);
}
console.log("subagent-paste check passed.");
