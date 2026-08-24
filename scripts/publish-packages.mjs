#!/usr/bin/env node
/**
 * publish-packages.mjs — CI-only sequential publisher.
 *
 * pnpm -r publish fires packages back-to-back. npm rate-limits new-scope
 * first publishes (~20–30 PUTs / few minutes), so a 44-package lockstep
 * release dies mid-set with E429. This script:
 *   - walks workspace packages in pnpm's topological order
 *   - skips private packages
 *   - skips versions already on the registry (idempotent reruns)
 *   - publishes one at a time with a pause between attempts
 *
 * Auth, --tag, --provenance, --no-git-checks are supplied by the caller
 * via argv / the process environment (same as `pnpm publish`).
 *
 * Usage (from repo root):
 *   node scripts/publish-packages.mjs --tag latest --provenance --no-git-checks
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DELAY_MS = Number(process.env.PUBLISH_DELAY_MS ?? 8000);
const extraArgs = process.argv.slice(2);

function fail(msg) {
  console.error(`publish-packages: ${msg}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    encoding: "utf8",
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: process.env,
  });
  if (opts.capture) return r;
  if (r.status !== 0) process.exit(r.status ?? 1);
  return r;
}

function listPublishable() {
  // `pnpm -r list --json --depth -1` is topological (deps before dependents).
  const raw = execFileSync(
    "pnpm",
    ["-r", "list", "--json", "--depth", "-1"],
    { cwd: ROOT, encoding: "utf8" },
  );
  const parsed = JSON.parse(raw);
  const pkgs = Array.isArray(parsed) ? parsed : [parsed];
  return pkgs.filter((p) => p && p.path && p.name).filter((p) => {
    const manifest = JSON.parse(readFileSync(join(p.path, "package.json"), "utf8"));
    return manifest.private !== true;
  });
}

function alreadyPublished(name, version) {
  const r = spawnSync("npm", ["view", `${name}@${version}`, "version", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) return false;
  try {
    const v = JSON.parse(r.stdout.trim() || "null");
    return v === version || (Array.isArray(v) && v.includes(version));
  } catch {
    return r.stdout.trim().replace(/^"|"$/g, "") === version;
  }
}

function sleep(ms) {
  execFileSync("sleep", [String(ms / 1000)]);
}

if (!existsSync(join(ROOT, "pnpm-workspace.yaml"))) {
  fail("must run from the workspace root");
}

const pkgs = listPublishable();
if (pkgs.length === 0) fail("no publishable packages found");

console.log(`publish-packages: ${pkgs.length} packages, ${DELAY_MS}ms between publishes`);

let published = 0;
let skipped = 0;
for (const [i, pkg] of pkgs.entries()) {
  const manifest = JSON.parse(readFileSync(join(pkg.path, "package.json"), "utf8"));
  const { name, version } = manifest;
  process.stdout.write(`[${i + 1}/${pkgs.length}] ${name}@${version} `);

  if (alreadyPublished(name, version)) {
    console.log("— already on registry, skip");
    skipped += 1;
    continue;
  }

  console.log("— publishing");
  run("pnpm", ["publish", "--filter", name, ...extraArgs]);
  published += 1;

  if (i < pkgs.length - 1) sleep(DELAY_MS);
}

console.log(`publish-packages: done (published ${published}, skipped ${skipped})`);
