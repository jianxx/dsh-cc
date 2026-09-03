#!/usr/bin/env node
/**
 * post-edit-diagnostics-nudge.mjs — Phase 3 PostToolUse hook (serena code
 * intelligence plan, docs/plans/2026-09-03-cc-code-intelligence-serena.md).
 *
 * After an edit-like tool touches a code file, inject an additionalContext
 * nudge telling the model to pull diagnostics via
 * mcp__serena__get_diagnostics_for_file before the next edit (Serena's
 * diagnostics are pull-based; hooks cannot call MCP tools).
 *
 * Hook protocol: stdin = JSON payload {session_id, tool_name, tool_input, ...};
 * stdout = {"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":...}}.
 *
 * Exit-0 discipline (plan fact 7): a PostToolUse hook exiting 2 rewrites the
 * tool result to isError — this script must NEVER break an edit, so every
 * failure path (malformed stdin, missing dirs, anything) exits 0 silently.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Edit-like tools: harness edit/write + Serena's symbolic editing tools. */
export const EDIT_TOOLS = new Set([
  "edit",
  "write",
  "mcp__serena__replace_symbol_body",
  "mcp__serena__replace_content",
  "mcp__serena__replace_in_files",
  "mcp__serena__insert_before_symbol",
  "mcp__serena__insert_after_symbol",
  "mcp__serena__rename_symbol",
  "mcp__serena__safe_delete_symbol",
]);

/** Code-file extensions, mirroring serena-hooks v1.7.0 `_CODE_FILE_EXTENSIONS`. */
export const CODE_EXTENSIONS = new Set(
  (
    ".al .bash .c .clj .cljs .cpp .cs .css .dart .elm .ex .exs .fs .fsx .go " +
    ".graphql .gql .groovy .h .hcl .hpp .hs .html .java .jl .js .json .jsonc " +
    ".jsx .kt .kts .lean .lua .m .matlab .nf .php .proto .ps1 .py .r .rb .rs " +
    ".scala .sh .sol .sql .svelte .swift .tf .tfvars .toml .ts .tsx .vue " +
    ".yaml .yml .zig"
  )
    .split(" ")
    .filter(Boolean),
);

export const DEBOUNCE_MS = 60_000;

/** Extract the target path across the three key variants (plan Phase 3). */
export function targetPath(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return undefined;
  return toolInput.file_path || toolInput.path || toolInput.relative_path || undefined;
}

export function isCodePath(p) {
  if (typeof p !== "string" || p.length === 0) return false;
  const i = p.lastIndexOf(".");
  if (i <= 0 || i === p.length - 1) return false;
  return CODE_EXTENSIONS.has(p.slice(i).toLowerCase());
}

/** Sanitize a session id for use in a state filename. */
function safeSession(sessionId) {
  return String(sessionId ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "_");
}

function stateFile(dataDir, sessionId) {
  return join(dataDir, `nudge-${safeSession(sessionId)}.json`);
}

function readState(dataDir, sessionId) {
  const f = stateFile(dataDir, sessionId);
  try {
    const parsed = JSON.parse(readFileSync(f, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(dataDir, sessionId, state) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(stateFile(dataDir, sessionId), JSON.stringify(state));
}

/** The exact additionalContext payload (plan Phase 3). */
export function buildOutput(path) {
  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: `Diagnostics: run mcp__serena__get_diagnostics_for_file on ${path} before the next edit; fix new errors in the same turn.`,
    },
  };
}

/**
 * Pure-ish decision core. Returns the output object to print, or null for a
 * silent no-op. `opts = { dataDir, now?, debounceMs? }`.
 */
export function decide(payload, opts) {
  const { dataDir: dir, now = Date.now(), debounceMs = DEBOUNCE_MS } = opts ?? {};
  if (!payload || typeof payload !== "object") return null;
  if (!EDIT_TOOLS.has(payload.tool_name)) return null;
  const p = targetPath(payload.tool_input);
  if (!isCodePath(p)) return null;
  const sessionId = payload.session_id;
  const state = readState(dir, sessionId);
  const key = String(p);
  if (typeof state[key] === "number" && now - state[key] < debounceMs) return null;
  state[key] = now;
  writeState(dir, sessionId, state);
  return buildOutput(p);
}

function projectDataDir() {
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return join(root, ".serena", "hook_data");
}

function main() {
  try {
    const raw = existsSync("/dev/stdin") ? readFileSync(0, "utf8") : "";
    const payload = JSON.parse(raw);
    const out = decide(payload, { dataDir: projectDataDir() });
    if (out) process.stdout.write(JSON.stringify(out));
  } catch {
    // exit-0 discipline: never break an edit
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
