#!/usr/bin/env node
/**
 * serena-failure-watchdog.test.mjs — node:test suite for the Phase 4 Item 3
 * Serena failure watchdog (recorder + advisory halves).
 */
import { spawnSync } from "node:child_process";
import { strict as assert } from "node:assert";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, "serena-failure-watchdog.mjs");
const MOD = new URL("file://" + HOOK).href;
const { record, advise, dataDir, fileFor } = await import(MOD);

const MIN = 60_000;
function tmp() {
  return mkdtempSync(join(tmpdir(), "watchdog-test-"));
}
function runHook(mode, stdin, projectDir) {
  const res = spawnSync("node", [HOOK, mode], {
    input: stdin,
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir ?? tmp() },
  });
  return { stdout: res.stdout ?? "", status: res.status };
}
const serenaFail = (over = {}) => ({
  session_id: "s1",
  tool_name: "mcp__serena__find_symbol",
  error: "Error: language server crashed (symbol_not_found loop)",
  ...over,
});

test("dataDir: under CLAUDE_PROJECT_DIR, .serena/hook_data", () => {
  const d = tmp();
  process.env.CLAUDE_PROJECT_DIR = d;
  try {
    assert.equal(dataDir(), join(d, ".serena", "hook_data"));
  } finally {
    delete process.env.CLAUDE_PROJECT_DIR;
  }
});

test("recorder: appends {ts, tool, errorHead} and mkdir -p in a fresh dir", async () => {
  const d = tmp();
  const now = 1_000_000;
  await record(serenaFail(), { dataDir: d, now });
  const f = join(d, "failures-s1.jsonl");
  assert.ok(existsSync(f), "failure file created (with parents)");
  const lines = readFileSync(f, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(entry).sort(), ["errorHead", "tool", "ts"]);
  assert.equal(entry.ts, now);
  assert.equal(entry.tool, "mcp__serena__find_symbol");
  assert.ok(entry.errorHead.includes("language server crashed"));
  // second append
  await record(serenaFail({ tool_name: "mcp__serena__find_referencing_symbols" }), { dataDir: d, now: now + 1 });
  assert.equal(readFileSync(f, "utf8").trim().split("\n").length, 2);
});

test("recorder truncates own session file at 100 lines", async () => {
  const d = tmp();
  const f = join(d, "failures-s2.jsonl");
  const base = 1_000_000;
  for (let i = 0; i < 105; i++) {
    await record(serenaFail({ session_id: "s2" }), { dataDir: d, now: base + i });
  }
  const lines = readFileSync(f, "utf8").trim().split("\n");
  assert.equal(lines.length, 100);
  // keeps the LAST 100 entries
  assert.equal(JSON.parse(lines[0]).ts, base + 5);
  assert.equal(JSON.parse(lines[99]).ts, base + 104);
});

test("recorder sweeps failures-*.jsonl older than 7 days on write", async () => {
  const d = tmp();
  const stale = join(d, "failures-old.jsonl");
  const fresh = join(d, "failures-new.jsonl");
  writeFileSync(stale, "{}\n");
  writeFileSync(fresh, "{}\n");
  const old = new Date(Date.now() - 8 * 24 * 3600_000);
  utimesSync(stale, old, old);
  await record(serenaFail(), { dataDir: d, now: 1 });
  assert.ok(!existsSync(stale), "stale file swept");
  assert.ok(existsSync(fresh), "fresh file kept");
});

test("advisory: silent when fewer than 2 failures in the last 5 minutes", async () => {
  const d = tmp();
  const now = 10 * MIN;
  await record(serenaFail(), { dataDir: d, now: now - 4 * MIN });
  const out = await advise({ session_id: "s1", tool_name: "Read" }, { dataDir: d, now });
  assert.equal(out, null, "1 recent failure → silent");
});

test("advisory: silent when 2 failures are outside the 5-minute window", async () => {
  const d = tmp();
  const now = 10 * MIN;
  await record(serenaFail(), { dataDir: d, now: now - 6 * MIN });
  await record(serenaFail(), { dataDir: d, now: now - 5.5 * MIN });
  const out = await advise({ session_id: "s1", tool_name: "Read" }, { dataDir: d, now });
  assert.equal(out, null, "old failures outside window → silent");
});

test("advisory: fires exactly once with the plan's text after 2 recent failures", async () => {
  const d = tmp();
  const now = 10 * MIN;
  await record(serenaFail(), { dataDir: d, now: now - 2 * MIN });
  await record(serenaFail({ tool_name: "mcp__serena__get_symbols_overview" }), { dataDir: d, now: now - MIN });
  const out = await advise({ session_id: "s1", tool_name: "Read" }, { dataDir: d, now });
  assert.ok(out, "advisory expected");
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.equal(
    out.hookSpecificOutput.additionalContext,
    "Serena MCP has failed 2 times recently (last: mcp__serena__get_symbols_overview). Use built-in Read/Grep/Edit for now; `mcp__serena__restart_language_server` may recover it if the server is still connected.",
  );
  // one-shot: immediately again → silent (cooldown)
  const again = await advise({ session_id: "s1", tool_name: "Grep" }, { dataDir: d, now: now });
  assert.equal(again, null, "cooldown must suppress a second advisory");
  // after the 10-minute cooldown AND two fresh failures it can fire again
  await record(serenaFail(), { dataDir: d, now: now + 11 * MIN });
  await record(serenaFail(), { dataDir: d, now: now + 11.5 * MIN });
  const later = await advise({ session_id: "s1", tool_name: "Grep" }, { dataDir: d, now: now + 12 * MIN });
  assert.ok(later, "after cooldown the advisory may fire again");
});

test("advisory: silent-when-clean (no failure file at all)", async () => {
  const d = tmp();
  const out = await advise({ session_id: "s3", tool_name: "Read" }, { dataDir: d, now: 1 });
  assert.equal(out, null);
});

test("sessions are isolated by session_id", async () => {
  const d = tmp();
  const now = 10 * MIN;
  await record(serenaFail({ session_id: "other" }), { dataDir: d, now: now - MIN });
  await record(serenaFail({ session_id: "other" }), { dataDir: d, now: now - 2 * MIN });
  const out = await advise({ session_id: "mine", tool_name: "Read" }, { dataDir: d, now });
  assert.equal(out, null, "another session's failures must not trigger mine");
});

test("exit-0-on-garbage: both halves exit 0 silently on malformed stdin", () => {
  for (const mode of ["record", "advise"]) {
    for (const stdin of ["garbage", "", "[]", "null", "{}"]) {
      const { stdout, status } = runHook(mode, stdin);
      assert.equal(status, 0, `${mode} garbage ${JSON.stringify(stdin)} must exit 0`);
      assert.equal(stdout, "", `${mode} garbage must print nothing`);
    }
  }
});

test("subprocess end-to-end: two failures then a Read produces the advisory JSON", () => {
  const project = tmp();
  const payload = (tool, name) =>
    JSON.stringify({ session_id: "e2e", tool_name: tool, tool_response: "boom", tool_input: {} });
  const f = fileFor("e2e");
  for (let i = 0; i < 2; i++) {
    const { status } = runHook("record", payload("mcp__serena__find_symbol"), project);
    assert.equal(status, 0);
  }
  assert.ok(existsSync(join(project, ".serena", "hook_data", f)), "failure file at project path");
  const { stdout, status } = runHook("advise", JSON.stringify({ session_id: "e2e", tool_name: "Read", tool_input: {} }), project);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout);
  assert.ok(parsed.hookSpecificOutput.additionalContext.includes("Serena MCP has failed 2 times"));
});
