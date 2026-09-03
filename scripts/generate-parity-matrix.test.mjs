#!/usr/bin/env node
/**
 * generate-parity-matrix.test.mjs — self-running test harness for the
 * parity-matrix generator (spec: docs/plans/2026-09-03-claude-code-capability-manifest.md §5.1).
 *
 * Plain node:assert harness (NOT vitest — see check-file-size.test.mjs). Builds
 * a fixture tree (tiny manifest + README with markers + matrix path) in a temp
 * dir and runs scripts/generate-parity-matrix.mjs as a subprocess with
 * --root/--manifest/--readme/--matrix overrides.
 */
import { spawnSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadManifest, normalizeDimension } from "./lib/capability-manifest.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GEN = join(__dirname, "generate-parity-matrix.mjs");
const TMP = mkdtempSync(join(tmpdir(), "generate-parity-test-"));

const FIXTURE_MANIFEST = `manifest_version: 1

baseline:
  upstream: claude-code
  sources:
    - id: cc-docs
      kind: context7
      ref: /websites/code_claude
      url: https://code.claude.com/docs
      retrieved: 2026-09-03
    - id: cc-repo
      kind: context7
      ref: /anthropics/claude-code
      url: https://github.com/anthropics/claude-code
      retrieved: 2026-08-01
  freshness_threshold_days: 120

categories:
  - { id: engine, title: Engine subsystems }
  - { id: sessions, title: Sessions and context }

upstream_dependencies:
  session-file-snapshot-seam:
    title: Session file-snapshot seam
    problem: >-
      dsh sessions persist a jsonl/sqlite projection; there is no per-prompt
      snapshot store of edited files to anchor a rewind against.
    cc_contract: >-
      Every prompt checkpoints files about to be edited; /rewind restores
      code, conversation, or both.
    refs:
      - https://code.claude.com/docs/en/checkpointing

capabilities:
  engine.ask-user:
    title: AskUserQuestion
    category: engine
    plane: host
    upstream:
      summary: Structured user questions with option lists.
      refs:
        - { source: cc-repo, path: /docs/ask-user, retrieved: 2026-08-01 }
    dimensions:
      recognized: true
      mounted: true
      behavioral: divergent
      ux: missing
    evidence:
      - { type: test, path: packages/hooks/tests/dispatch.spec.ts }
      - { type: source, path: packages/host/settings.json, anchor: "askUserQuestion" }
    deviation:
      kind: non-goal
      summary: "dsh-native ask_user_question modal is the local equivalent."
  engine.hooks:
    title: Hook events
    category: engine
    plane: preset
    upstream:
      summary: Hook event dispatch with command and prompt executors.
      refs:
        - { source: cc-docs, path: /docs/en/hooks, retrieved: 2026-09-03 }
    dimensions:
      recognized: true
      mounted:
        status: true
        notes: "command+http executors always on"
      behavioral: full
      ux:
        status: partial
        notes: "no hook preview in the approval modal"
    evidence:
      - { type: test, path: packages/hooks/tests/dispatch.spec.ts }
      - { type: source, path: packages/preset/cc/agent.cordis.yml, anchor: "-hooks-claude-code" }
      - { type: doc, path: https://code.claude.com/docs/en/hooks }
    deviation:
      kind: downgrade
      summary: "prompt/agent executors sit behind default-off flags."
  engine.legacy-hooks:
    title: Hook events (old name)
    category: engine
    deprecated: true
    replaced_by: engine.hooks
    dimensions:
      recognized: true
      mounted: true
      behavioral: full
      ux: full
    evidence:
      - { type: test, path: packages/hooks/tests/dispatch.spec.ts }
      - { type: source, path: packages/preset/cc/agent.cordis.yml, anchor: "-hooks-claude-code" }
  sessions.checkpointing:
    title: File checkpointing and rewind
    category: sessions
    plane: preset
    upstream:
      summary: >-
        Per-prompt file snapshots before edits; /rewind menu restores code or
        conversation.
      refs:
        - { source: cc-docs, path: /docs/en/checkpointing, retrieved: 2026-09-03 }
    dimensions:
      recognized: false
      mounted: false
      behavioral: missing
      ux: missing
    evidence: []
    deviation:
      kind: upstream-blocked
      summary: "Feature absent; requires a snapshot seam in the session layer."
      upstream_dependency: session-file-snapshot-seam
`;

const FIXTURE_README_BEFORE = `# dsh-cc

Intro prose that must survive.

\`\`\`sh
dsh plugin --profile cc add @x/y
\`\`\`

<!-- parity:matrix:start -->
STALE HAND-WRITTEN TABLE — should be replaced.
<!-- parity:matrix:end -->

## More prose after the block

Trailing content that must survive byte-for-byte.
`;

function makeTree(extra = {}) {
  const root = mkdtempSync(join(TMP, "tree-"));
  for (const [rel, content] of Object.entries({
    "docs/claude-code-capabilities.yaml": FIXTURE_MANIFEST,
    "README.md": FIXTURE_README_BEFORE,
    "docs/cc-parity-matrix.md": "# stale matrix\n",
    "packages/hooks/tests/dispatch.spec.ts": "// fixture test\n",
    "packages/preset/cc/agent.cordis.yml": "rows:\n  -hooks-claude-code\n",
    "packages/host/settings.json": '{ "askUserQuestion": true }\n',
    ...extra,
  })) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

function run(root, args = []) {
  const res = spawnSync(
    "node",
    [GEN, "--root", root, "--manifest", "docs/claude-code-capabilities.yaml",
     "--readme", "README.md", "--matrix", "docs/cc-parity-matrix.md", ...args],
    { encoding: "utf-8" },
  );
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status };
}

let failures = 0;
function pass(name) { console.log(`[PASS] ${name}`); }
function fail(name, detail) { console.error(`[FAIL] ${name}: ${detail}`); failures++; }
function case_(name, fn) {
  try { fn(); pass(name); } catch (e) { fail(name, e.message); }
}

// --- golden output assertions (run once, inspect both documents) ---
let root, res, matrix, readme;

case_("GREEN: generator writes both documents", () => {
  root = makeTree();
  res = run(root);
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}\n${res.stderr}`);
  matrix = readFileSync(join(root, "docs/cc-parity-matrix.md"), "utf8");
  readme = readFileSync(join(root, "README.md"), "utf8");
});

case_("matrix: generated header + title + legend", () => {
  assert.ok(matrix.includes("<!-- GENERATED from docs/claude-code-capabilities.yaml — do not edit; run pnpm docs:parity -->"), matrix.slice(0, 300));
  assert.ok(matrix.includes("# Claude Code parity matrix"));
  for (const line of [
    "- ✅ full parity: behavior matches upstream, mounted by default, complete UX",
    "- 🔶 partial: usable with known differences (see Deviation/Notes)",
    "- ❌ missing: absent today",
    "- 🚫 not a parity port — may exist as a dsh-native equivalent (see Deviations)",
  ]) assert.ok(matrix.includes(line), `missing legend line: ${line}`);
});

case_("matrix: category tables in manifest order with golden rows", () => {
  const iEngine = matrix.indexOf("## Engine subsystems");
  const iSessions = matrix.indexOf("## Sessions and context");
  assert.ok(iEngine !== -1 && iSessions !== -1, "category headings missing");
  assert.ok(iEngine < iSessions, "categories not in manifest order");
  assert.ok(matrix.indexOf("| Status | Capability | Recognized | Mounted | Behavior | UX | Evidence | Deviation | Notes |", iEngine) !== -1, "table header missing");
  const hooksRow = matrix.split("\n").find((l) => l.includes("cap-engine.hooks"));
  assert.ok(hooksRow, "hooks row missing");
  assert.equal(
    hooksRow,
    "| 🔶 | <a id=\"cap-engine.hooks\"></a>Hook events | ✓ | ✓ | Full | Partial | [t1](packages/hooks/tests/dispatch.spec.ts) [s1](packages/preset/cc/agent.cordis.yml) [d1](https://code.claude.com/docs/en/hooks) | downgrade — prompt/agent executors sit behind default-off flags. | mounted: command+http executors always on; ux: no hook preview in the approval modal |",
    `hooks row mismatch:\n${hooksRow}`,
  );
  const cpRow = matrix.split("\n").find((l) => l.includes("cap-sessions.checkpointing"));
  assert.ok(cpRow, "checkpointing row missing");
  assert.equal(
    cpRow,
    "| ❌ | <a id=\"cap-sessions.checkpointing\"></a>File checkpointing and rewind | — | — | Missing | Missing | — | upstream-blocked — Feature absent; requires a snapshot seam in the session layer. | — |",
    `checkpointing row mismatch:\n${cpRow}`,
  );
  const askRow = matrix.split("\n").find((l) => l.includes("cap-engine.ask-user"));
  assert.ok(askRow && askRow.startsWith("| 🚫 | "), `non-goal rollup wrong: ${askRow}`);
});

case_("matrix: deviations section lists every non-none deviation, anchored", () => {
  const i = matrix.indexOf("## Deviations and known limits");
  assert.ok(i !== -1, "deviations section missing");
  const section = matrix.slice(i, matrix.indexOf("## Upstream dependencies"));
  for (const id of ["engine.hooks", "engine.ask-user", "sessions.checkpointing"]) {
    assert.ok(section.includes(`<a id="dev-${id}"></a>`), `missing dev anchor for ${id}`);
  }
  assert.ok(!section.includes("engine.legacy-hooks"), "deprecated stub leaked into deviations");
  assert.ok(section.includes("upstream_dependency: session-file-snapshot-seam"), "blocked dependency not named");
});

case_("matrix: upstream dependencies registry dump", () => {
  const i = matrix.indexOf("## Upstream dependencies");
  assert.ok(i !== -1, "registry section missing");
  const section = matrix.slice(i, matrix.indexOf("## Renamed capabilities"));
  assert.ok(section.includes("session-file-snapshot-seam"), "dep id missing");
  assert.ok(section.includes("Session file-snapshot seam"), "dep title missing");
  assert.ok(section.includes("dsh sessions persist a jsonl/sqlite projection"), "problem missing");
  assert.ok(section.includes("https://code.claude.com/docs/en/checkpointing"), "dep ref missing");
});

case_("matrix: renamed capabilities section lists deprecated stubs", () => {
  const i = matrix.indexOf("## Renamed capabilities");
  assert.ok(i !== -1, "renamed section missing");
  const section = matrix.slice(i);
  assert.ok(section.includes("engine.legacy-hooks"), "stub id missing");
  assert.ok(section.includes("engine.hooks"), "replaced_by target missing");
  const rows = matrix.split("\n").filter((l) => l.includes("cap-engine.legacy-hooks"));
  assert.equal(rows.length, 0, "stub must not appear in category tables");
});

case_("matrix: footer with baseline source ids + newest retrieved date", () => {
  assert.ok(matrix.includes("cc-docs") && matrix.includes("cc-repo"), "source ids missing from footer");
  assert.ok(matrix.includes("2026-09-03"), "newest retrieved date missing");
  assert.ok(matrix.includes("120"), "freshness threshold missing from footer");
});

case_("byte stability: two consecutive runs produce identical bytes", () => {
  const m1 = readFileSync(join(root, "docs/cc-parity-matrix.md"), "utf8");
  const r1 = readFileSync(join(root, "README.md"), "utf8");
  const res2 = run(root);
  assert.equal(res2.status, 0, res2.stderr);
  assert.equal(readFileSync(join(root, "docs/cc-parity-matrix.md"), "utf8"), m1);
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), r1);
});

case_("readme: marked region replaced, outside untouched, rollup counts + deviations + freshness + link", () => {
  const start = "<!-- parity:matrix:start -->";
  const end = "<!-- parity:matrix:end -->";
  const before = FIXTURE_README_BEFORE;
  const s = before.indexOf(start);
  const e = before.indexOf(end) + end.length;
  const beforePrefix = before.slice(0, s + start.length);
  const beforeSuffix = before.slice(e);
  assert.ok(readme.startsWith(beforePrefix), "content before start marker changed");
  assert.ok(readme.endsWith(beforeSuffix), "content after end marker changed");
  const region = readme.slice(beforePrefix.length, readme.length - beforeSuffix.length);
  assert.ok(!region.includes("STALE HAND-WRITTEN TABLE"), "stale content survived");
  // rollup counts: engine = 🔶1 (hooks: ux partial; legacy stub excluded), 🚫1 (ask-user); sessions = ❌1
  assert.ok(region.includes("| Engine subsystems | 0 | 1 | 0 | 1 |"), `engine rollup row missing:\n${region}`);
  assert.ok(region.includes("| Sessions and context | 0 | 0 | 1 | 0 |"), `sessions rollup row missing:\n${region}`);
  assert.ok(region.includes("### Known deviations"), "deviations heading missing");
  assert.ok(region.includes("- `engine.hooks` — downgrade: prompt/agent executors sit behind default-off flags."), "deviation bullet format");
  assert.ok(region.includes("- `engine.ask-user` — non-goal: dsh-native ask_user_question modal is the local equivalent."), "non-goal bullet");
  assert.ok(region.includes("2026-09-03") && region.includes("120"), "freshness note missing");
  assert.ok(region.includes("[Claude Code parity matrix](docs/cc-parity-matrix.md)"), "matrix link missing");
});

case_("anchor emission: every live capability row carries its anchor", () => {
  for (const id of ["engine.hooks", "engine.ask-user", "sessions.checkpointing"]) {
    assert.ok(matrix.includes(`<a id="cap-${id}"></a>`), `no anchor for ${id}`);
  }
});

// --- --check semantics ---
case_("check: exit 0 right after write", () => {
  const r = run(root, ["--check"]);
  assert.equal(r.status, 0, `expected 0, got ${r.status}\n${r.stderr}\n${r.stdout}`);
});

case_("check: stale matrix → exit 1 naming the file", () => {
  writeFileSync(join(root, "docs/cc-parity-matrix.md"), "# hand edited\n");
  const r = run(root, ["--check"]);
  assert.equal(r.status, 1, `expected 1, got ${r.status}`);
  assert.ok(r.stderr.includes("docs/cc-parity-matrix.md"), r.stderr);
  assert.ok(r.stderr.includes("run pnpm docs:parity"), r.stderr);
  // --check must not have fixed the file
  assert.equal(readFileSync(join(root, "docs/cc-parity-matrix.md"), "utf8"), "# hand edited\n");
});

case_("check: stale README region → exit 1 naming the file", () => {
  const p = join(root, "README.md");
  const cur = readFileSync(p, "utf8");
  writeFileSync(p, cur.replace("- `engine.hooks` — downgrade", "- `engine.hooks` — hand-edited"));
  const r = run(root, ["--check"]);
  assert.equal(r.status, 1, `expected 1, got ${r.status}`);
  assert.ok(r.stderr.includes("README.md"), r.stderr);
  // a plain write repairs both
  const w = run(root);
  assert.equal(w.status, 0, w.stderr);
  assert.equal(run(root, ["--check"]).status, 0, "check after repair should pass");
});

// --- Unit B: JSON render (docs/claude-code-capabilities.json) ---
const JSON_REL = "docs/claude-code-capabilities.json";

case_("json: write mode also emits the normalized manifest, byte-stable across runs", () => {
  const j1 = readFileSync(join(root, JSON_REL), "utf8"); // written by the run above
  assert.ok(j1.endsWith("}\n"), "missing trailing newline");
  assert.equal(JSON.parse(j1).manifest_version, 1, "not a manifest render");
  // normalized: dimensions in object form everywhere
  const parsed = JSON.parse(j1);
  const hooks = parsed.capabilities["engine.hooks"];
  // JSON.stringify drops keys whose value is undefined, so `notes` vanishes
  // when unset — the object form is still the normalized shape.
  assert.deepEqual(hooks.dimensions, {
    recognized: { status: true },
    mounted: { status: true, notes: "command+http executors always on" },
    behavioral: { status: "full" },
    ux: { status: "partial", notes: "no hook preview in the approval modal" },
  }, "dimensions not normalized to object form");
  const w = run(root);
  assert.equal(w.status, 0, w.stderr);
  assert.equal(readFileSync(join(root, JSON_REL), "utf8"), j1, "JSON not byte-identical across two runs");
});

case_("json: --check covers it (stale/missing → exit 1 naming the file, fresh → exit 0)", () => {
  const p = join(root, JSON_REL);
  const fresh = readFileSync(p, "utf8");
  writeFileSync(p, fresh.replace('"manifest_version": 1', '"manifest_version": 999'));
  const r = run(root, ["--check"]);
  assert.equal(r.status, 1, `stale JSON must fail check, got ${r.status}`);
  assert.ok(r.stderr.includes(JSON_REL), `file not named: ${r.stderr}`);
  rmSync(p);
  const r2 = run(root, ["--check"]);
  assert.equal(r2.status, 1, `missing JSON must fail check, got ${r2.status}`);
  assert.ok(r2.stderr.includes(JSON_REL), `missing file not named: ${r2.stderr}`);
  assert.equal(run(root).status, 0, "repair run failed");
  assert.equal(run(root, ["--check"]).status, 0, "check after repair should pass");
});

case_("json: key order deterministic; deep-equals the lib-normalized fixture manifest", () => {
  const j1 = readFileSync(join(root, JSON_REL), "utf8");
  assert.ok(j1.includes('"manifest_version"'), "sanity");
  // JSON render must deep-equal the fixture YAML re-loaded through the lib
  // with dimensions normalized via normalizeDimension (object form everywhere).
  const manifest = loadManifest(root, "docs/claude-code-capabilities.yaml");
  const expected = JSON.parse(JSON.stringify(manifest));
  for (const cap of Object.values(expected.capabilities)) {
    cap.dimensions = {
      recognized: normalizeDimension(cap.dimensions?.recognized),
      mounted: normalizeDimension(cap.dimensions?.mounted),
      behavioral: normalizeDimension(cap.dimensions?.behavioral),
      ux: normalizeDimension(cap.dimensions?.ux),
    };
  }
  assert.deepEqual(JSON.parse(j1), JSON.parse(JSON.stringify(expected)),
    "JSON render diverges from normalized manifest");
  // deterministic key order: serialization of two loads is byte-identical
  assert.equal(JSON.stringify(JSON.parse(j1), null, 2) + "\n", j1, "key order not deterministic");
});

// --- failure modes ---
case_("missing README markers → exit 1 with actionable message", () => {
  const r2 = makeTree({ "README.md": "# no markers here\n" });
  const r = run(r2);
  assert.equal(r.status, 1, `expected 1, got ${r.status}`);
  assert.ok(r.stderr.includes("parity:matrix:start"), r.stderr);
  assert.ok(r.stderr.includes("parity:matrix:end"), r.stderr);
  rmSync(r2, { recursive: true, force: true });
});

case_("missing manifest → exit 1 with clear message", () => {
  const r2 = makeTree();
  rmSync(join(r2, "docs/claude-code-capabilities.yaml"));
  const r = run(r2);
  assert.equal(r.status, 1, `expected 1, got ${r.status}`);
  assert.ok(r.stderr.includes("manifest not found"), r.stderr);
  rmSync(r2, { recursive: true, force: true });
});

console.log(failures === 0 ? "\nAll generator tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
