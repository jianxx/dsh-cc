#!/usr/bin/env node
/**
 * check-capability-evidence.mjs — presubmit gate: validates
 * docs/claude-code-capabilities.yaml against the manifest spec
 * (docs/plans/2026-09-03-claude-code-capability-manifest.md §4, §5.2):
 * schema shape, consistency invariants I1–I11, evidence path existence,
 * anchor enforcement, registry integrity and id ordering.
 *
 * One diagnostic per violation, printed as `E|W <rule> [<capability>] message`.
 * Exit 1 on any error-level diagnostic; warnings keep the run green.
 * Does not read README or the generated matrix, does not fetch URLs.
 *
 * Optional argv[2] overrides the manifest path (used by the paired test);
 * all evidence paths resolve relative to the repo root derived from this
 * file's location, independent of the caller's cwd.
 */
import { join, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCapabilityManifest } from "./lib/capability-manifest.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const relPath = process.argv[2]
  ? (isAbsolute(process.argv[2]) ? process.argv[2] : resolve(process.argv[2]))
  : "docs/claude-code-capabilities.yaml";

let diags;
try {
  diags = await checkCapabilityManifest(repoRoot, relPath);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

for (const d of diags) {
  const scope = d.capability ? ` [${d.capability}]` : "";
  console.log(`${d.level === "error" ? "E" : "W"} ${d.rule}${scope} ${d.message}`);
}

const errors = diags.filter((d) => d.level === "error").length;
const warnings = diags.length - errors;
if (diags.length === 0) {
  console.log(`capability manifest OK: ${relPath === relPath ? "docs/claude-code-capabilities.yaml" : relPath}`);
} else {
  console.log(
    `\n${errors} error(s), ${warnings} warning(s) in ${join(repoRoot, "docs/claude-code-capabilities.yaml")}`,
  );
}
process.exit(errors > 0 ? 1 : 0);
