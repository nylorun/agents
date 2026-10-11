---
"@nylorun/harness-conformance": minor
---

**The harness conformance suite on npm.** `@nylorun/harness-conformance` is published for the first time, so a harness author checks a harness without a checkout of this repository.

- **The command.** `npx @nylorun/harness-conformance --runtime <url> --key <app key> --manage-key <management key> --harness <id>` runs checks HC01 to HC19 against a live Runtime through its public Runtime and Management APIs only. It prints a table, or one JSON line per check with `--json`, and exits 1 on a failure and 2 on a usage error.
- **From code.** `runConformance(options)` runs the same checks and returns the report. The package also exports `CHECKS`, `RuntimeClient` and the report helpers.
- It depends on no other Nylorun package: it drives the Runtime over HTTP.
