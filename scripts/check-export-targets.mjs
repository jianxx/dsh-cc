#!/usr/bin/env node
/**
 * check-export-targets.mjs — presubmit gate: every `./lib/*` leaf target in a
 * package's `exports` field must resolve to a file that the build actually
 * emits. Guards against `exports` entries pointing at paths the tsc emit does
 * not produce (e.g. `./lib/types/types.{d.ts,js}` when the build emits a flat
 * `./lib/types.{d.ts,js}`), which would be a runtime 404 even when published.
 *
 * Model: for each `packages/<group>/<pkg>/package.json`, recursively collect
 * every string VALUE in the `exports` object (condition objects like
 * `{ types, default }` and deeper nested conditions are all traversed). A
 * leaf that starts with `./lib/` is asserted to exist as a file relative to
 * the package directory. Leaves under other roots (`./src/*`, `./package.json`)
 * are the package's own source trees or meta files and are not checked.
 *
 * Exit 0 when clean; exit 1 with one diagnostic per offending leaf.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Recursively collect every string leaf value in an `exports` entry.
 * @param node - a string, or a nested object of conditions/values.
 * @param out - accumulator for the string leaves.
 */
function collectStringLeaves(node, out) {
  if (typeof node === "string") {
    out.push(node);
    return;
  }
  if (node && typeof node === "object") {
    for (const value of Object.values(node)) collectStringLeaves(value, out);
  }
}

/**
 * Scans `packages/<group>/<pkg>/package.json` under `root` for `./lib/*` export
 * leaf targets that point at a non-existent file. Returns
 * `[{ pkgDir, exportKey, leaf, resolved }]` — empty when clean.
 */
export function findExportTargetProblems(root) {
  const problems = [];
  const packagesDir = join(root, "packages");
  if (!existsSync(packagesDir)) return problems;
  for (const group of readdirSync(packagesDir)) {
    const groupDir = join(packagesDir, group);
    if (!statSync(groupDir).isDirectory()) continue;
    for (const pkgName of readdirSync(groupDir)) {
      const pkgDir = join(groupDir, pkgName);
      const manifestPath = join(pkgDir, "package.json");
      if (!existsSync(manifestPath)) continue;
      const exports_ = JSON.parse(readFileSync(manifestPath, "utf8")).exports;
      if (!exports_ || typeof exports_ !== "object") continue;
      for (const [exportKey, entry] of Object.entries(exports_)) {
        const leaves = [];
        collectStringLeaves(entry, leaves);
        for (const leaf of leaves) {
          if (!leaf.startsWith("./lib/")) continue;
          const resolved = join(pkgDir, leaf);
          if (!existsSync(resolved)) {
            problems.push({ pkgDir, exportKey, leaf, resolved });
          }
        }
      }
    }
  }
  return problems;
}

/* c8 ignores below: CLI entry */
const isDirectRun =
  process.argv[1] && process.argv[1].endsWith("check-export-targets.mjs");
if (isDirectRun) {
  const root = process.argv[2] ?? process.cwd();
  const problems = findExportTargetProblems(root);
  if (problems.length) {
    console.error("check:exports — export targets that do not resolve to a file:\n");
    for (const p of problems) {
      console.error(
        `  ${p.pkgDir.replace(`${root}/`, "")}\n    exports["${p.exportKey}"] -> ${p.leaf}\n    missing: ${p.resolved}`,
      );
    }
    console.error(
      `\nA ./lib/* export leaf must point at a file the build emits (run the build, then` +
        `\nconfirm the path exists). A flat lib/ emit usually needs a flat ./lib/<name>.{d.ts,js} target.`,
    );
    process.exit(1);
  }
  console.log("check:exports OK — every ./lib/* export target resolves to a file");
}
