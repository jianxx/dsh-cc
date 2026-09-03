#!/usr/bin/env node
/**
 * post-edit-diagnostics-nudge.test.mjs — node:test suite for the Phase 3
 * PostToolUse diagnostics-nudge hook script.
 *
 * Runs both via `node scripts/hooks/post-edit-diagnostics-nudge.test.mjs`
 * and `node --test scripts/hooks/`. Subprocess cases exercise the real
 * stdin→stdout hook protocol; in-process cases exercise the exported logic.
 */
import { spawnSync } from "node:child_process";
import { strict as assert } from "node:assert";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, "post-edit-diagnostics-nudge.mjs");
const MOD = new URL("file://" + HOOK).href;

const { EDIT_TOOLS, targetPath, isCodePath, decide, buildOutput } = await import(MOD);

const BASE = { session_id: "sess-1", tool_input: {} };
function tmpDir() {
  const d = mkdtempSync(join(tmpdir(), "nudge-test-"));
  return d;
}

function runHook(stdin, env = {}) {
  const res = spawnSync("node", [HOOK], {
    input: stdin,
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: env.projectDir ?? tmpDir(), ...env.extra },
  });
  return { stdout: res.stdout ?? "", status: res.status };
}

test("tool-name filter: only edit-like tools act", () => {
  for (const t of [
    "edit", "write",
    "mcp__serena__replace_symbol_body", "mcp__serena__replace_content",
    "mcp__serena__replace_in_files", "mcp__serena__insert_before_symbol",
    "mcp__serena__insert_after_symbol", "mcp__serena__rename_symbol",
    "mcp__serena__safe_delete_symbol",
  ]) {
    assert.ok(EDIT_TOOLS.has(t), `expected ${t} to be an edit tool`);
  }
  for (const t of ["read", "grep", "bash", "mcp__serena__find_symbol", "mcp__serena__get_diagnostics_for_file"]) {
    assert.ok(!EDIT_TOOLS.has(t), `expected ${t} NOT to be an edit tool`);
  }
});

test("path extraction: file_path, then path, then relative_path", () => {
  assert.equal(targetPath({ file_path: "/a/b.ts" }), "/a/b.ts");
  assert.equal(targetPath({ path: "/a/c.go" }), "/a/c.go");
  assert.equal(targetPath({ relative_path: "src/d.py" }), "src/d.py");
  assert.equal(targetPath({ file_path: "", path: "/a/c.go" }), "/a/c.go");
  assert.equal(targetPath({}), undefined);
});

test("extension filter: code files pass, others are skipped", () => {
  assert.ok(isCodePath("/x/a.ts"));
  assert.ok(isCodePath("src/main.py"));
  assert.ok(!isCodePath("/x/notes.md"));
  assert.ok(!isCodePath("/x/a.txt"));
  assert.ok(!isCodePath("/x/noext"));
});

test("decide emits the exact additionalContext JSON shape", () => {
  const d = tmpDir();
  const out = decide(
    { ...BASE, tool_name: "edit", tool_input: { file_path: "/p/app.ts" } },
    { dataDir: d, now: 1_000_000 },
  );
  assert.deepEqual(out, {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext:
        "Diagnostics: run mcp__serena__get_diagnostics_for_file on /p/app.ts before the next edit; fix new errors in the same turn.",
    },
  });
  assert.deepEqual(buildOutput("/p/app.ts"), out);
});

test("debounce: second nudge for the same file+session inside 60 s is silent", () => {
  const d = tmpDir();
  const payload = { ...BASE, tool_name: "write", tool_input: { file_path: "/p/b.ts" } };
  const now = 5_000_000;
  assert.ok(decide(payload, { dataDir: d, now }));
  assert.equal(decide(payload, { dataDir: d, now: now + 30_000 }), null, "within 60 s must be silent");
  assert.ok(decide(payload, { dataDir: d, now: now + 61_000 }), "after 60 s fires again");
  // different file is not debounced by the first file's entry
  assert.ok(decide({ ...payload, tool_input: { file_path: "/p/c.ts" } }, { dataDir: d, now: now + 61_000 }));
});

test("non-edit tool emits nothing (decide returns null)", () => {
  const d = tmpDir();
  assert.equal(
    decide({ ...BASE, tool_name: "grep", tool_input: { file_path: "/p/a.ts" } }, { dataDir: d, now: 1 }),
    null,
  );
});

test("edit of a non-code file emits nothing", () => {
  const d = tmpDir();
  assert.equal(
    decide({ ...BASE, tool_name: "edit", tool_input: { file_path: "/p/README.md" } }, { dataDir: d, now: 1 }),
    null,
  );
});

test("exit-0-on-garbage: malformed stdin and bad payloads exit 0 silently", () => {
  for (const stdin of ["not json", "", "{}", '{"tool_name":123}', "[]", "null"]) {
    const { stdout, status } = runHook(stdin);
    assert.equal(status, 0, `garbage ${JSON.stringify(stdin)} must exit 0, got ${status}`);
    assert.equal(stdout, "", `garbage ${JSON.stringify(stdin)} must print nothing`);
  }
});

test("subprocess: real payload on a .ts edit prints the nudge JSON and exits 0", () => {
  const project = tmpDir();
  const payload = {
    session_id: "sub-1",
    tool_name: "edit",
    tool_input: { file_path: "/repo/src/index.ts" },
  };
  const { stdout, status } = runHook(JSON.stringify(payload), { projectDir: project });
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.ok(parsed.hookSpecificOutput.additionalContext.includes("/repo/src/index.ts"));
  // debounce state materialized under the project dir
  assert.ok(existsSync(join(project, ".serena", "hook_data")), "state dir created under project");
});
