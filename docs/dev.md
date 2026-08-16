# Dev notes

## pnpm verification on network-restricted hosts

pnpm 11.7.0 verifies package integrity against registry attestations and
re-verifies the lockfile against supply-chain policies whenever its stat
(size/mtime/inode) changes. Crucially, pnpm fetches these per-package
attestations **even under `--offline`** — each one retrying ~10s against
registry.npmjs.org — so on a host where the registry is unreachable, any
install-resolution (`pnpm install`, `pnpm install --lockfile-only`) stalls
~10s per uncached package and is effectively unavailable here. Recovery: run
`pnpm install --frozen-lockfile` once on a host with registry access (or let
CI be the authority), then the resolved tree is usable here.

(An earlier revision of this note claimed a `lockfile-verified.jsonl` refresh
script "lives in the repo history" — it does not; nothing usable was ever
committed, and the cache records' hash field is not reconstructible from the
lockfile text. Do not hand-write cache entries.)

What to do instead when a branch adds packages or changes dependency
declarations:

- **Preferred**: run `pnpm install --lockfile-only` on a host with registry
  access, or let CI's `pnpm install --frozen-lockfile` be the authority.
- **On this host**: edit `pnpm-lock.yaml` textually, then verify with the
  invariants below (they are exactly what the frozen check reads).

### Lockfile invariants (what `pnpm install --frozen-lockfile` checks)

For every workspace `packages/<group>/<pkg>/package.json`:

- Every name in `dependencies` / `devDependencies` / `optionalDependencies`
  appears in the package's `importers:` entry with `specifier:` equal to the
  package.json text:
  `workspace:^` keeps that specifier and gets `version: link:<relative path>`;
  `link:` deps keep the same `link:` text for both fields. `link:` and
  `workspace:` entries need no `packages:`/`snapshots:` rows.
- **Section purity**: the lockfile importer's `devDependencies` must NOT
  repeat a name that also appears in `dependencies` or `optionalDependencies`
  of the same package.json (pnpm de-dups; listing it twice fails with a count
  mismatch). The same rule applies to `dependencies` vs `optionalDependencies`.
- Entry order and quoting style are cosmetic; the comparison is
  order-insensitive.

## Dependency declaration contract for tests

On CI, each package's `node_modules` is populated strictly from its own
declared `dependencies` / `devDependencies` / `optionalDependencies` /
`peerDependencies` (link: targets symlinked in). A test importing a harness
package (`@deepseek-ai/*`) that the package never declares fails at test time
with `ERR_MODULE_NOT_FOUND` — even when it passes locally behind a flattened
or hand-linked root `node_modules`.

`pnpm check:spec-deps` (scripts/check-spec-deps.mjs) enforces this in
presubmit and the pre-commit gate, scanning `packages/*/tests` without needing
node_modules. When it flags an import, declare the package in the importing
package's `package.json` **and** add the matching lockfile entry (see above).

## Worktree local setup

- Deps in a fresh worktree: `bash scripts/link-worktree-deps.sh` (idempotent;
  symlinks each package's node_modules from the main checkout).
- The worktree root may additionally need `link:` targets flattened into
  `node_modules/` for resolution of packages whose package node_modules don't
  carry them — symlink them by hand (`ln -sfn <abs target> node_modules/<name>`).
- `node_modules/.bin` is absent in the worktree: call `node
  node_modules/typescript/bin/tsc -b tsconfig.packages.json` and
  `node node_modules/vitest/vitest.mjs run` directly instead of `pnpm`.
