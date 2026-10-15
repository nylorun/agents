---
"@nylorun/core": patch
"@nylorun/agents": patch
"@nylorun/runtime": patch
---

**An `environment_secret` reads `nylorun_managed` in the sandbox instead of `nylorun-managed`, so CLIs that check a token's format send their requests.**

- The Vercel CLI refuses a `VERCEL_TOKEN` with any character outside letters, digits and `_` (`Must not contain: "-"`) and exits before egress-gate can set the header. `ENVIRONMENT_SECRET_SENTINEL` is now `nylorun_managed`.
- egress-gate never compares the value: it replaces the credential's header whatever the CLI sent, so nothing else changes. A script that checks for the literal `nylorun-managed` should check for `nylorun_managed`.
