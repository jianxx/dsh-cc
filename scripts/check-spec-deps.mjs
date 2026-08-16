#!/usr/bin/env node
/**
 * check-spec-deps.mjs — presubmit gate: every bare import in a package's
 * tests/ must be resolvable on CI, where pnpm installs each package's
 * node_modules strictly from its own dependency declarations.
 *
 * Why this gate exists: a spec can import a harness package
 * (`@deepseek-ai/*`) or a workspace package and pass locally (developer
 * trees tend to have a flattened/extra node_modules around), then fail on
 * CI with ERR_MODULE_NOT_FOUND because that name was never declared.
 *
 * Resolution model (mirrors CI exactly):
 *   1. the importing package's own package.json (dependencies,
 *      devDependencies, optionalDependencies, peerDependencies) — full
 *      specifier or its package-name prefix (covers subpath imports like
 *      `@deepseek-ai/dsh-llm/brand`);
 *   2. tsconfig.base.json `paths` (vite-tsconfig-paths applies them in
 *      tests), exact key or `<prefix>/*` wildcard;
 *   3. the root package.json (vitest and friends);
 *   4. the package importing itself by its own name.
 * Skipped: relative/absolute paths, `node:*` builtins.
 *
 * Exit 0 when clean; exit 1 with one diagnostic per offending import.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const IMPORT_RE =
  /(?:\bfrom\s*|\bimport\s*\(?\s*|\bexport\b[^'"]*?\bfrom\s*)['"]([^'"]+)['"]/g;

function* walkTs(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* walkTs(p);
    else if (entry.endsWith(".ts")) yield p;
  }
}

function packageNameOf(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function readJsonLoose(path) {
  // tolerate the comments/trailing commas tsconfig files tend to carry;
  // strip ONLY full-line comments so URLs like "git+https://…" inside
  // strings stay intact (pnpm package.json files are strict JSON)
  const text = readFileSync(path, "utf8")
    .replace(/^﻿/, "")
    .replace(/^\s*\/\/[^\n]*$/gm, "")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(text);
}

function declaredKeys(pkgJson) {
  return Object.keys({
    ...pkgJson.dependencies,
    ...pkgJson.devDependencies,
    ...pkgJson.optionalDependencies,
    ...pkgJson.peerDependencies,
  });
}

function matchesDeclared(specifier, keys) {
  const pkgName = packageNameOf(specifier);
  return keys.includes(specifier) || keys.includes(pkgName);
}

function matchesPaths(specifier, pathsKeys) {
  for (const key of pathsKeys) {
    if (key === specifier) return true;
    if (key.endsWith("/*") && specifier.startsWith(key.slice(0, -1)))
      return true;
  }
  return false;
}

/**
 * Scans `packages/<group>/<pkg>/tests/**.ts` under `root`.
 * Returns [{ file, pkgDir, specifier, reason }] — empty when clean.
 */
export function findSpecImportProblems(root) {
  const problems = [];
  const rootPkg = readJsonLoose(join(root, "package.json"));
  const rootKeys = declaredKeys(rootPkg);
  let pathsKeys = [];
  try {
    pathsKeys = Object.keys(
      readJsonLoose(join(root, "tsconfig.base.json"))?.compilerOptions
        ?.paths ?? {},
    );
  } catch {
    /* no tsconfig.base.json paths on this root */
  }

  const packagesDir = join(root, "packages");
  if (!existsSync(packagesDir)) return problems;
  for (const group of readdirSync(packagesDir)) {
    const groupDir = join(packagesDir, group);
    if (!statSync(groupDir).isDirectory()) continue;
    for (const pkgName of readdirSync(groupDir)) {
      const pkgDir = join(groupDir, pkgName);
      const pkgJsonPath = join(pkgDir, "package.json");
      const testsDir = join(pkgDir, "tests");
      if (!existsSync(pkgJsonPath) || !existsSync(testsDir)) continue;
      const pkgJson = readJsonLoose(pkgJsonPath);
      const ownName = pkgJson.name;
      const pkgKeys = declaredKeys(pkgJson);

      for (const file of walkTs(testsDir)) {
        const text = readFileSync(file, "utf8");
        for (const match of text.matchAll(IMPORT_RE)) {
          const specifier = match[1];
          if (
            specifier.startsWith(".") ||
            specifier.startsWith("/") ||
            specifier.startsWith("node:") ||
            specifier === ownName ||
            (ownName && specifier.startsWith(ownName + "/"))
          )
            continue;
          if (matchesDeclared(specifier, pkgKeys)) continue;
          if (matchesPaths(specifier, pathsKeys)) continue;
          if (matchesDeclared(specifier, rootKeys)) continue;
          problems.push({
            file,
            pkgDir,
            specifier,
            reason:
              `not declared in ${join("packages", group, pkgName)}/package.json ` +
              `(dependencies/devDependencies/peerDependencies), not covered by ` +
              `tsconfig.base.json paths, not a root dependency`,
          });
        }
      }
    }
  }
  return problems;
}

/* c8 ignores below: CLI entry */
const isDirectRun =
  process.argv[1] && process.argv[1].endsWith("check-spec-deps.mjs");
if (isDirectRun) {
  const root = process.argv[2] ?? process.cwd();
  const problems = findSpecImportProblems(root);
  if (problems.length) {
    console.error("check:spec-deps — unresolvable test imports found:\n");
    for (const p of problems) {
      console.error(
        `  ${relativeJoined(root, p.file)}\n    imports '${p.specifier}' — ${p.reason}`,
      );
    }
    console.error(
      `\nOn CI, pnpm installs a package's link:/workspace deps only from its own declarations;` +
        `\ndeclare the dependency in that package's devDependencies (and pnpm-lock.yaml).`,
    );
    process.exit(1);
  }
  console.log("check:spec-deps OK — all test imports are declared/resolvable");
}

function relativeJoined(root, file) {
  return file.startsWith(root) ? file.slice(root.length + 1) : file;
}
