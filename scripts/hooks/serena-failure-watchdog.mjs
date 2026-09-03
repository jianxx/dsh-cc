#!/usr/bin/env node
/**
 * serena-failure-watchdog.mjs — Phase 4 Item 3 Serena failure watchdog
 * (docs/plans/2026-09-03-cc-code-intelligence-serena.md).
 *
 * Two halves, deliberately asymmetric, selected by argv[2]:
 *   record — PostToolUseFailure hook: append {ts, tool, errorHead} to
 *            .serena/hook_data/failures-<session_id>.jsonl (mkdir -p first;
 *            fresh worktrees lack .serena/).
 *   advise — PostToolUse hook: if the session's failure file shows ≥2 entries
 *            within the last 5 minutes AND no advisory in the last 10 minutes,
 *            emit exactly one additionalContext advising built-in fallback.
 *
 * GC: the recorder truncates its own session file at 100 lines; stale
 * failures-*.jsonl / advisories-*.jsonl older than 7 days are swept on write.
 *
 * Exit-0 discipline (plan fact 7): this script must never break a tool call —
 * every failure path exits 0 silently.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

export const FAILURE_WINDOW_MS = 5 * 60_000;
export const ADVISORY_COOLDOWN_MS = 10 * 60_000;
export const FAILURE_THRESHOLD = 2;
export const MAX_LINES = 100;
export const GC_AGE_MS = 7 * 24 * 3600_000;
const ERROR_HEAD_MAX = 200;

/** State dir: $CLAUDE_PROJECT_DIR/.serena/hook_data/. */
export function dataDir() {
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return join(root, ".serena", "hook_data");
}

function safeSession(sessionId) {
  return String(sessionId ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "_");
}

export function fileFor(sessionId) {
  return `failures-${safeSession(sessionId)}.jsonl`;
}

function advisoryFileFor(sessionId) {
  return `advisories-${safeSession(sessionId)}.jsonl`;
}

function readJsonl(f) {
  try {
    const text = readFileSync(f, "utf8");
    return text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function errorHead(payload) {
  // PostToolUseFailure payloads flatten the failed result into `error`
  // (src/payloads.ts:80); `tool_response` is kept as a defensive fallback.
  const r = payload?.error ?? payload?.tool_response;
  const text = typeof r === "string" ? r : r && typeof r === "object" ? JSON.stringify(r) : "";
  return text.replace(/\s+/g, " ").trim().slice(0, ERROR_HEAD_MAX) || "unknown";
}

/** Sweep stale failures-*.jsonl / advisories-*.jsonl files older than 7 days. */
function sweep(dir, now) {
  try {
    for (const name of readdirSync(dir)) {
      if (!/^failures-.*\.jsonl$/.test(name) && !/^advisories-.*\.jsonl$/.test(name)) continue;
      const f = join(dir, name);
      try {
        if (now - statSync(f).mtimeMs > GC_AGE_MS) rmSync(f);
      } catch {
        // ignore unreadable entries
      }
    }
  } catch {
    // missing dir — nothing to sweep
  }
}

/**
 * Recorder half. Appends one entry per Serena tool failure and applies GC.
 * `opts = { dataDir, now? }`.
 */
export async function record(payload, opts) {
  const { dataDir: dir = dataDir(), now = Date.now() } = opts ?? {};
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.tool_name !== "string" || !payload.tool_name.startsWith("mcp__serena__")) return null;
  const sessionId = payload.session_id;
  mkdirSync(dir, { recursive: true });
  const entry = { ts: now, tool: payload.tool_name, errorHead: errorHead(payload) };
  const f = join(dir, fileFor(sessionId));
  try {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(f, JSON.stringify(entry) + "\n");
  } catch {
    // exit-0 discipline
  }
  // GC 1: truncate own session file at 100 lines (keep the LAST 100).
  try {
    const lines = readFileSync(f, "utf8").split("\n").filter((l) => l.trim());
    if (lines.length > MAX_LINES) {
      writeFileSync(f, lines.slice(-MAX_LINES).join("\n") + "\n");
    }
  } catch {
    // ignore
  }
  // GC 2: sweep stale session files of dead sessions (real clock, not payload ts).
  sweep(dir, Date.now());
  return f;
}

/** The advisory additionalContext payload. */
export function buildAdvisory(recentCount, lastTool) {
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: `Serena MCP has failed ${recentCount} times recently (last: ${lastTool}). Use built-in Read/Grep/Edit for now; \`mcp__serena__restart_language_server\` may recover it if the server is still connected.`,
    },
  };
}

/**
 * Advisory half. `payload` is the PostToolUse payload of the Read/Grep/Glob
 * call; `opts = { dataDir, now? }`. Returns the output object or null.
 */
export async function advise(payload, opts) {
  const { dataDir: dir = dataDir(), now = Date.now() } = opts ?? {};
  if (!payload || typeof payload !== "object") return null;
  const sessionId = payload.session_id;
  const failures = readJsonl(join(dir, fileFor(sessionId)));
  const recent = failures.filter(
    (e) => typeof e?.ts === "number" && now - e.ts <= FAILURE_WINDOW_MS,
  );
  if (recent.length < FAILURE_THRESHOLD) return null;
  const advisories = readJsonl(join(dir, advisoryFileFor(sessionId)));
  const lastAdvisory = advisories.reduce((m, e) => Math.max(m, typeof e?.ts === "number" ? e.ts : 0), 0);
  if (now - lastAdvisory < ADVISORY_COOLDOWN_MS) return null;
  try {
    mkdirSync(dir, { recursive: true });
    const { appendFileSync } = await import("node:fs");
    appendFileSync(join(dir, advisoryFileFor(sessionId)), JSON.stringify({ ts: now }) + "\n");
  } catch {
    // exit-0 discipline — still emit the advisory below
  }
  const last = recent[recent.length - 1];
  return buildAdvisory(recent.length, last?.tool ?? "unknown");
}

function projectDataDir() {
  return dataDir();
}

async function main() {
  const mode = process.argv[2];
  try {
    const raw = existsSync("/dev/stdin") ? readFileSync(0, "utf8") : "";
    const payload = JSON.parse(raw);
    if (mode === "record") {
      await record(payload, { dataDir: projectDataDir() });
    } else if (mode === "advise") {
      const out = await advise(payload, { dataDir: projectDataDir() });
      if (out) process.stdout.write(JSON.stringify(out));
    }
  } catch {
    // exit-0 discipline: never break a tool call
  }
  process.exit(0);
}

function invokedAsMain() {
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (invokedAsMain()) {
  main();
}
