#!/usr/bin/env bash
# Mirror this repo's CC preset combo into a dsh installation's per-user
# .agent-presets so the "cc" preset is available across every profile, just as
# the published package would deliver it.
#
# What gets copied (and what does not):
#   - packages/preset/cc/agent.cordis.yml  -> ${DSH_HOME}/.agent-presets/cc/
#   - packages/preset/cc/preset.yml        -> ${DSH_HOME}/.agent-presets/cc/
#
# We only guarantee these two files match the repo. The destination preset
# directory is NOT rsynced with --delete: a future user may drop its own
# settings-unrelated artifacts there, and wiping them would be an overreach.
# New files added to packages/preset/cc/ later are picked up only when they are
# added to the explicit list below.
#
# Usage:
#   bash scripts/sync-cc-preset.sh   # DSH_HOME defaults to $HOME/.dsh
#
# Re-run after the preset files change, then restart dsh. The preset list is
# re-scanned at the next boot, so no other action is required.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dsh_home="${DSH_HOME:-$HOME/.dsh}"
dest="$dsh_home/.agent-presets/cc"

src_dir="$repo_root/packages/preset/cc"
src_files=(
  "$src_dir/agent.cordis.yml"
  "$src_dir/preset.yml"
)

for f in "${src_files[@]}"; do
  if [ ! -f "$f" ]; then
    echo "missing source preset file: $f — run from the dsh-cc-plugins checkout (packages/preset/cc must be populated)" >&2
    exit 1
  fi
done

mkdir -p "$dest"
rsync -a "${src_files[@]}" "$dest/"

echo "synced CC preset into $dest"
echo "restart dsh to take effect; the preset list is re-scanned at next boot"
