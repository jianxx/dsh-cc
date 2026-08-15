#!/usr/bin/env bash
# Make a git worktree usable for pnpm without a full reinstall.
#
# `claude --worktree` (and `git worktree add`) produce a clean checkout that
# contains only git-tracked files — node_modules/, dist/, coverage/ are all
# gitignored and therefore absent, so every pnpm command in the worktree
# (typecheck, test, build) fails with "Cannot find module". None of them need
# dist: tsconfig.base.json `paths` maps @jianxx/dsh-cc-* specifiers to source,
# and vitest.config.ts (vite-tsconfig-paths) resolves the same specifiers.
#
# What's missing is node_modules — plural. pnpm's workspace layout installs each
# package's direct deps into that package's own node_modules (nested under
# packages/<category>/<package>/node_modules here), so
# symlinking only the root node_modules leaves per-package deps unresolvable.
# This script discovers every node_modules in the main checkout and symlinks
# each one at the same relative path in the worktree. pnpm's node_modules are
# themselves forests of symlinks into a global content-addressable store, so
# this is instant, zero extra disk, and zero install wait.
set -euo pipefail

wt_dir="$(pwd)"
# --git-common-dir resolves to the MAIN repo's .git when inside a worktree,
# and to the current .git otherwise; appending /.. yields the main checkout root.
main_dir="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"

if [ "$wt_dir" = "$main_dir" ]; then
  echo "Not in a worktree (cwd == main checkout at $main_dir); nothing to do." >&2
  exit 0
fi

# Discover every node_modules in the main checkout (relative paths, excluding
# nested ones inside other node_modules). -mindepth avoids matching the root.
# Written portably (no mapfile) so it runs under macOS /bin/bash 3.2.
found=()
while IFS= read -r line; do
  [ -n "$line" ] && found+=("$line")
done < <(
  cd "$main_dir" && \
  find . -mindepth 1 -name node_modules -not -path '*/node_modules/*' -print \
    | sed 's|^\./||'
)

if [ "${#found[@]}" -eq 0 ]; then
  echo "No node_modules found in $main_dir — run 'pnpm install' there first." >&2
  exit 1
fi

linked=0
skipped=0
for rel in "${found[@]}"; do
  src="$main_dir/$rel"
  dst="$wt_dir/$rel"
  mkdir -p "$(dirname "$dst")"
  if [ -e "$dst" ] && [ ! -L "$dst" ]; then
    echo "  skip   $rel (real file/dir already exists in worktree)" >&2
    skipped=$((skipped + 1))
    continue
  fi
  ln -sfn "$src" "$dst"
  echo "  linked $rel -> $src"
  linked=$((linked + 1))
done

echo "Done: $linked linked, $skipped skipped."
echo "pnpm typecheck / test / build should now run in this worktree."
