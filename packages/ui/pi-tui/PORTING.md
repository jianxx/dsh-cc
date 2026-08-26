# PORTING — @jianxx/dsh-cc-pi-tui

Vendored copy of pi-tui from canonical upstream.

- **Upstream**: https://github.com/earendil-works/pi → `packages/tui`
- **Upstream SHA at vendor time**: `8fa7eebd235355522c8104166b4f1f959b4e2f10` (reproducible: these are canonical bytes of that commit)
- **Vendor date**: 2026-08-26
- **npm cross-check**: `@earendil-works/pi-tui@0.84.3` (published dist of the same line)
- **Excluded**: `native/` (darwin CoreGraphics helper; the JS path stands alone — on macOS some modifier disambiguation falls back), `test/`, upstream build (`tsgo`, `tsconfig.build.json`, `scripts.*`) — this package builds via the repo's root `tsc -b` like every sibling
- **Re-vendor protocol**: update SHA + date above; every local edit must append a numbered entry below before commit

## Local divergences

Source is byte-identical to the recorded SHA. Building it under this repo's `tsconfig.base.json` required looser pedantic flags than upstream's own build (`strict: true` only):

- **D1 (build config)**: `packages/ui/pi-tui/tsconfig.json` sets `exactOptionalPropertyTypes: false`, `noUncheckedIndexedAccess: false`, `noImplicitOverride: false`, `noUnusedLocals: false`. Upstream builds with plain `strict: true` (tsgo); the four repo pedantic flags produce only internal type-level errors, none behavioral. Source stays pristine; only the vendored package's own tsconfig differs.
- **D2 (packaging)**: published under the `@jianxx/dsh-cc-pi-tui` name because the TUI surface ships it as a `workspace:^` dependency; MIT attribution travels via LICENSE and this file. Upstream identity (`@earendil-works/pi-tui`) is the provenance record above, not our package name.
