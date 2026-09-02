#!/usr/bin/env node
/**
 * daily-release-next-version.mjs <lastTag> <bump> — daily auto-release
 * version calculator (CI only; no node_modules in the calling job).
 *
 * Contract:
 *   stdin/args: lastTag = stable baseline tag `v<major>.<minor>.<patch>`
 *     (prerelease suffixes are rejected — the daily auto-release only bumps
 *     off stable baselines); bump = `auto` | `patch` | `minor`.
 *   stdout: the bare next semver (no `v` prefix) and NOTHING else — the
 *     caller captures stdout via `$(...)`. All diagnostics go to stderr.
 *
 * Preconditions (asserted, fail-loud):
 *   - Lockstep invariant: root package.json version === lastTag. The root
 *     manifest is private but kept in lockstep by release.mjs (see its
 *     header + check-release-version.mjs). A mismatch means the previous
 *     release half-completed (tag pushed without a matching manifest
 *     commit, or vice versa) — we refuse to compute on top of that and
 *     print the manual recovery recipe instead.
 *   - `auto`: scans `git log --format=%s <lastTag>..origin/main`; any
 *     conventional-commit `feat(` / `feat!` / `feat:` subject → minor,
 *     otherwise patch. `patch`/`minor` map directly (minor resets patch
 *     to 0). Never produces a major bump — revisit before 1.0.
 *
 * No external dependencies; only node stdlib + git.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function fail(msg) {
  console.error(`daily-release-next-version: ${msg}`);
  process.exit(1);
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf-8", cwd: ROOT }).trim();
}

const [lastTag, bump] = process.argv.slice(2);
const tagMatch = typeof lastTag === "string" && lastTag.match(/^v(\d+)\.(\d+)\.(\d+)$/);
if (!tagMatch) {
  fail(
    `invalid last tag '${lastTag ?? ""}'. Expected a stable v<major>.<minor>.<patch>; ` +
      "daily auto-release 只处理 stable 基线 tag（prerelease 基线请走手动 release.mjs）",
  );
}
if (!["auto", "patch", "minor"].includes(bump)) {
  fail(`invalid bump '${bump ?? ""}'. Expected auto | patch | minor`);
}

/* ---- lockstep assertion: root manifest version must equal lastTag ---- */

const rootJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const rootVersion = rootJson.version;
if (`v${rootVersion}` !== lastTag) {
  fail(
    `lockstep broken: root package.json version (${rootVersion}) != last tag (${lastTag}). ` +
      `疑似上次 tag 推送/发布未完成。手动恢复：git checkout main && git pull && ` +
      `git tag v${rootVersion} && git push origin v${rootVersion} && ` +
      `gh workflow run publish.yml -f tag=v${rootVersion}`,
  );
}

/* ---- bump calculation ---- */

const [M, m, p] = tagMatch.slice(1).map(Number);
let next;
if (bump === "patch") {
  next = `${M}.${m}.${p + 1}`;
} else if (bump === "minor") {
  next = `${M}.${m + 1}.0`;
} else {
  // auto: any conventional `feat(`/`feat!`/`feat:` subject since the last
  // tag → minor, else patch. Relies on PR titles following conventional
  // commits (repo discipline: squash merge, titles are the subjects).
  const subjects = git("log", "--format=%s", `${lastTag}..origin/main`);
  const hasFeat = subjects.split("\n").some((s) => /^feat(?:\(|!|:)/.test(s));
  next = hasFeat ? `${M}.${m + 1}.0` : `${M}.${m}.${p + 1}`;
}

console.log(next);
