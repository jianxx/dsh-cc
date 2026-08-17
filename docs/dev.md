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

## Pre-commit hook 环境与锁文件护栏

git 会向 hook 环境注入仓库绑定变量,其中 `GIT_INDEX_FILE` 在 pre-commit 中是**相对顶层目录**的 `.git/index`;子孙进程若以其他 cwd 调 git(真仓库测试、临时仓库 fixture,或 `git worktree add` 内部在 linked worktree 重跑 reset——那里 `.git` 是指针文件)会按自己的 cwd 重解析,读写错位的 index 乃至真仓库 index。`.husky/pre-commit` 因此在 gate 前 `unset` 整个 repo-pinning 变量族;脚本自带 `set -e`,直接 `sh .husky/pre-commit` 裸调用时各 gate 同样全部生效(husky 的正式提交路径本就是 `sh -e`)。

**新增任何 spawn 真 git(或其他读环境外部命令)的测试,必须在 spec 模块顶同样 strip 该变量族**(参考 `packages/workspace/tool-git-worktree/tests/integration.spec.ts` 顶部)。

锁文件卫生:pre-commit 在 gate 前后各查一次 `git diff --quiet -- pnpm-lock.yaml`(worktree vs index),任何未暂存漂移立即拦截 —— 改 workspace 依赖须 `pnpm install`(仅限获得显式授权的环境)并把 `pnpm-lock.yaml` 与 package.json 改动放进**同一 commit** stage。正常 `git commit` 不再需要 `--no-verify`:hook 全绿是提交前提而非可选项。

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

- After `bash scripts/sync-local-profile.sh web`, also run
  `bash scripts/sync-cc-preset.sh` — it rsyncs the CC preset combo into
  `~/.dsh/.agent-presets/cc` so the `cc` preset is available in any profile.
- Deps in a fresh worktree: `bash scripts/link-worktree-deps.sh` (idempotent;
  symlinks each package's node_modules from the main checkout).
- The worktree root may additionally need `link:` targets flattened into
  `node_modules/` for resolution of packages whose package node_modules don't
  carry them — symlink them by hand (`ln -sfn <abs target> node_modules/<name>`).
- `node_modules/.bin` is absent in the worktree: call `node
  node_modules/typescript/bin/tsc -b tsconfig.packages.json` and
  `node node_modules/vitest/vitest.mjs run` directly instead of `pnpm`.
