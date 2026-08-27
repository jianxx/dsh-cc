#!/usr/bin/env bash
# Mirror this repo's @jianxx/* packages into a dsh profile's node_modules so
# an unpublished local build boots exactly like the published bundles would.
#
# Why copies, not symlinks: Node resolves modules from a package's realpath.
# A symlinked package would realpath back into this repo, where every
# `import '@deepseek-ai/...'` resolves through our devDep link: into the
# sibling deepseek-harness checkout — a second cordis instance per process.
# Flat copies under the profile instead resolve @deepseek-ai/* through the
# installer-maintained ~/.dsh/profiles/node_modules symlink fallback, which is
# precisely how published bundles share the installation's single cordis
# (README "How the loading works", point 4).
#
# Usage:
#   pnpm run build                       # emit lib/ first
#   bash scripts/sync-local-profile.sh [profile]     # default: web
# then register the two bundles in <profile>/package.json
# dsh.profile.bundles (after the in-box bundles; do NOT add dependencies
# entries — the dsh plugin reconciler never touches bundles that aren't
# dependencies, so hand-registered entries survive).
#
# Re-run after every `pnpm run build` and restart dsh to pick up code changes.
# (Only patch layers are hot-reloaded; plugin code is read at boot.)
set -euo pipefail

profile="${1:-web}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dsh_home="${DSH_HOME:-$HOME/.dsh}"
profile_dir="$dsh_home/profiles/$profile"
dest="$profile_dir/node_modules/@jianxx"

if [ ! -d "$profile_dir" ]; then
  echo "profile $profile not found at $profile_dir — boot it once (dsh --profile $profile) or pass another name" >&2
  exit 1
fi

mkdir -p "$dest"
synced=()
missing_lib=0
for pkg_dir in "$repo_root"/packages/*/*/; do
  manifest="$pkg_dir/package.json"
  [ -f "$manifest" ] || continue
  name="$(node -p "require('$manifest').name")"
  case "$name" in @jianxx/*) ;; *) continue ;; esac
  # A package whose entry point lives under lib/ must have been built, or the
  # profile will fail to mount it at boot.
  if node -e "
    const p = require('$manifest');
    const fs = require('fs');
    process.exit(p.main?.startsWith('lib/') && !fs.existsSync('$pkg_dir/lib') ? 0 : 1);
  "; then
    echo "warning: $name has no lib/ — run pnpm run build first" >&2
    missing_lib=1
  fi
  rsync -a --delete --exclude=node_modules "$pkg_dir" "$dest/${name#@jianxx/}/"
  synced+=("${name#@jianxx/}")
done

# Prune copies of packages that no longer exist in the repo (renames/removals),
# otherwise a stale copy keeps resolving under its old name at boot.
for dest_dir in "$dest"/*/; do
  short="$(basename "$dest_dir")"
  found=false
  for kept in "${synced[@]}"; do
    [ "$kept" = "$short" ] && { found=true; break; }
  done
  [ "$found" = false ] && { rm -rf "$dest_dir"; echo "pruned stale $short"; }
done

# The vendored pi-tui renderer has RUNTIME npm deps (marked,
# get-east-asian-width) that must resolve inside the profile copy. The main
# loop above excluded node_modules for every package (other packages' nm
# symlink into the sibling deepseek-harness via link: devDeps — materializing
# those would duplicate cordis). pi-tui's deps are plain npm tarballs, so
# re-copy it once WITH dereferenced node_modules, then drop nested junk.
pi_tui_src="$repo_root/packages/ui/pi-tui"
if [ -d "$pi_tui_src" ]; then
  rsync -aL --delete "$pi_tui_src/" "$dest/dsh-cc-pi-tui/"
  rm -rf "$dest/dsh-cc-pi-tui/node_modules/.bin" "$dest/dsh-cc-pi-tui/node_modules/@deepseek-ai"
  echo "synced dsh-cc-pi-tui runtime deps (dereferenced)"
fi

# The tui package also has plain-npm RUNTIME deps (highlight.js) that must
# resolve from the synced profile copy. Unlike pi-tui, tui's devDependencies
# are link: refs into the sibling deepseek-harness — re-copying tui WITH
# dereferenced node_modules would materialize a second cordis. So instead sync
# only each plain-npm `dependencies` entry (dereferenced) into the profile
# root node_modules, where Node's upward resolution finds it for every @jianxx
# package. Workspace/link/@deepseek-ai entries are skipped (they resolve via
# the installer-maintained ~/.dsh fallback like the published bundles do).
tui_src="$repo_root/packages/ui/tui"
profile_nm="$(dirname "$dest")"  # .../$profile/node_modules
if [ -f "$tui_src/package.json" ] && [ -d "$tui_src/node_modules" ]; then
  node -e "
    const fs = require('fs');
    const cp = require('child_process');
    const deps = Object.entries(require('$tui_src/package.json').dependencies || {});
    let synced = 0;
    for (const [name, range] of deps) {
      if (range.startsWith('workspace:') || range.startsWith('link:')) continue;
      const src = '$tui_src/node_modules/' + name;
      if (!fs.existsSync(src)) { console.error('tui runtime dep ' + name + ' missing from node_modules'); process.exit(1); }
      const dest = '$profile_nm/' + name;
      fs.rmSync(dest, { recursive: true, force: true });
      cp.execFileSync('rsync', ['-aL', '--delete', src + '/', dest + '/']);
      fs.rmSync(dest + '/.bin', { recursive: true, force: true });
      synced++;
    }
    if (synced) console.log('synced @jianxx/dsh-cc-tui runtime deps (dereferenced): ' + synced);
  "
fi

echo "synced ${#synced[@]} packages into $dest"
[ "$missing_lib" -eq 0 ] || exit 1

# The runtime reads the cc preset composition from the per-user
# .agent-presets copy, NOT from the synced package — keep the two in lockstep
# so a package-only sync can never boot a stale composition.
bash "$repo_root/scripts/sync-cc-preset.sh"
