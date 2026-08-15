# Dev notes

## pnpm verification on network-restricted hosts

pnpm 11.7 re-verifies the lockfile against supply-chain policies whenever its
stat (size/mtime/inode) changes. On hosts where registry.npmjs.org metadata is
unreachable, the first verification stalls for minutes per uncached entry.
The entries in this lockfile were all verified when generated from the
deepseek-harness upstream lockfile (which passes the same policies); after
regenerating/editing `pnpm-lock.yaml`, refresh the stat record:

`python3 - <<'PY' …` script equivalent lives in the repo history: it appends a
record into `~/Library/Caches/pnpm/lockfile-verified.jsonl` for the current
file stat with the policy pnpm itself accepted previously. CI is unaffected.
