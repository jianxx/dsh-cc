#!/usr/bin/env node
/**
 * release.mjs <version> [--dry-run] — local release assistant (run by the
 * user manually, never in CI).
 *
 * Validates: semver-shaped arg; on branch `main`; working tree clean;
 * local HEAD === origin/main after `git fetch origin main`; tag `v<version>`
 * exists neither locally nor on the remote.
 *
 * Then writes the version into the root package.json and every non-private
 * package manifest (packages/<group>/<pkg>/package.json) with 2-space JSON
 * + trailing newline at stable key order, commits
 * `chore(release): v<version>`, and tags `v<version>`. It NEVER pushes —
 * it prints the exact manual push command to run.
 *
 * --dry-run prints validations + planned version writes with NO mutation,
 * commit, or tag.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function fail(msg) {
  console.error(`release: ${msg}`);
  process.exit(1);
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf-8", cwd: ROOT }).trim();
}

function isValidVersionShape(str) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(str);
}

/* ---- validation ---- */

const argVersion = process.argv[2];
const dryRun = process.argv.includes("--dry-run");
const label = dryRun ? "DRY-RUN" : "release";

if (!argVersion || !isValidVersionShape(argVersion)) {
  fail(`invalid version '${argVersion ?? ""}'. Expected a semver shape like 0.1.0 or 0.1.0-rc.1`);
}

const branch = git("branch", "--show-current");
console.log(`  [${label}] branch: ${branch}`);
if (branch !== "main") fail(`must run on 'main' (currently on '${branch}')`);

const status = git("status", "--porcelain");
console.log(`  [${label}] working tree clean: ${status === ""}`);
if (status !== "") fail("working tree is not clean; commit or stash first");

git("fetch", "origin", "main", "--quiet");
const head = git("rev-parse", "HEAD");
const originMain = git("rev-parse", "origin/main");
console.log(`  [${label}] HEAD === origin/main: ${head === originMain}`);
if (head !== originMain) fail("local HEAD is behind origin/main; sync first");

const tag = `v${argVersion}`;
let tagExistsLocal = false;
try {
  git("rev-parse", "-q", "--verify", `refs/tags/${tag}`);
  tagExistsLocal = true;
} catch {
  tagExistsLocal = false;
}
console.log(`  [${label}] tag ${tag} exists locally: ${tagExistsLocal}`);
if (tagExistsLocal) fail(`tag '${tag}' already exists locally`);

let tagExistsRemote = false;
try {
  const ls = git("ls-remote", "--tags", "origin", tag);
  tagExistsRemote = ls.length > 0;
} catch {
  tagExistsRemote = false;
}
console.log(`  [${label}] tag ${tag} exists on remote: ${tagExistsRemote}`);
if (tagExistsRemote) fail(`tag '${tag}' already exists on origin`);

/* ---- planned writes ---- */

function walkPkgJsonPaths(dir) {
  const out = [];
  const packagesDir = join(dir, "packages");
  if (!existsSync(packagesDir)) return out;
  for (const group of readdirSync(packagesDir)) {
    const groupDir = join(packagesDir, group);
    if (!statSync(groupDir).isDirectory()) continue;
    for (const pkg of readdirSync(groupDir)) {
      const pkgDir = join(groupDir, pkg);
      if (!statSync(pkgDir).isDirectory()) continue;
      const path = join(pkgDir, "package.json");
      if (existsSync(path)) out.push(path);
    }
  }
  return out;
}

const toUpdate = [join(ROOT, "package.json"), ...walkPkgJsonPaths(ROOT)];
const planned = [];
for (const path of toUpdate) {
  const json = JSON.parse(readFileSync(path, "utf8"));
  if (json.private === true) continue;
  if (json.version === argVersion) continue;
  planned.push({ path, name: json.name, from: json.version, to: argVersion });
}

console.log(`  [${label}] planned version writes (${planned.length}):`);
for (const p of planned) {
  console.log(`    ${p.name}: ${p.from} -> ${p.to}  (${join("..", p.path).replace(join("..", ROOT), ".")})`);
}
console.log(`  [${label}] commit message: chore(release): ${tag}`);

if (dryRun) {
  console.log(`\n  [DRY-RUN] no files changed, no commit, no tag.`);
  process.exit(0);
}

/* ---- commit + tag (NO push) ---- */

for (const p of planned) {
  const json = JSON.parse(readFileSync(p.path, "utf8"));
  json.version = argVersion;
  writeFileSync(p.path, `${JSON.stringify(json, null, 2)}\n`, "utf8");
}

git("add", "-A");
git("commit", "-m", `chore(release): ${tag}`);
git("tag", tag);

console.log(
  `\n下一步(需手动执行): git push origin main ${tag} —— 推送后 tag 触发 publish.yml 自动发布`,
);
