# The package's release checks

Two Node scripts the package's `check` runs after the build: they fail the package when its published shape or its source breaks a rule the package keeps. Neither is shipped in the tarball.

## Interface

- `checkPackedConsumer(cache)` (`check-consumer.mjs`): packs the package into a cache directory with `npm pack --ignore-scripts`, then checks what a consumer installs from that tarball without reaching the registry.
- `check-package.mjs`: the script `npm run check` calls: the manifest, the source and the tarball's contents and exports.

## Rules

- The package's description, keywords, author, homepage, bugs and LICENSE must match the canonical ones, and its production dependencies may not include `@nylorun/runtime`, `@nylorun/agent`, `@nylorun/studio` or `@nylorun/create-harness` (`check-package.mjs`).
- No file under `src/` may name a forbidden package, even in a comment (`check-package.mjs`).
- The tarball holds only allowed paths and holds every required file (`check-package.mjs`).
- A removed export may not come back, an internal subpath may not be importable, and a named public export must be present (`check-package.mjs`).
- An obsolete session export is refused (`check-package.mjs`).

## Side effects

- Runs `npm pack` and installs nothing into the package (`check-consumer.mjs`).
- Writes into the cache directory and a temporary directory it creates (`check-package.mjs`).

## Verification

- Run: `npm test` from `runtime/harness/`; `node scripts/check-package.mjs` runs this folder's own checks after a build.
