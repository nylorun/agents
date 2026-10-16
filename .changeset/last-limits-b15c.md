---
"@nylorun/core": minor
"@nylorun/harness": minor
"@nylorun/runtime": minor
"@nylorun/admin": patch
"@nylorun/agents": patch
"nylorun": patch
"@nylorun/studio": patch
---

**The last hard-coded limits are configuration (harness boundary B15c).** Still protocol 15 and Harness API 4. Every default is the value before. See MIGRATION.md, and DEPLOYMENT.md's Runtime limits and Host tuning.

- **21 more Runtime limits** (`GET`/`PUT /v1/tenant/limits`): a message's parts (`messageParts`), page sizes (`pageItems`, `exportPageItems`, `environmentEventItems`; a page asked larger holds that many), labels (`artifactLabels`, `labelKeyChars`, `labelValueChars`), a manifest's setup command, descriptions and secret hosts (`setupCommandChars`, `manifestDescriptionChars`, `secretDescriptionChars`, `secretHosts`), a failed pod's reason (`setupReasonChars`, `setupCommandExcerptChars`), secret values (`secretValueChars`), the tool policy and budgets (`toolRules`, `toolRuleFieldChars`, `toolRuleTextChars`, `modelBudgets`) and flows (`flowConcurrency`, `flowMapItems`, `flowLoopIterations`, replacing the `NYLORUN_FLOW_*` variables no Host read). Request schemas lose these maxima; the Runtime checks the Tenant's.
- **More Host tuning** (`NYLORUN_TUNING`): token lifetimes and clock tolerance (`keys.*`), the advance deadline and grace (`execution.*`), `nylorun-operate`'s waits, the credential store's lock, sweep arming, Postgres batches and the replication pool, a basin repair's log cadence, egress sockets, the engine poll and sandbox memory floor, MCP listing pages and diagnostics, sandbox helper commands, the scrub threshold, exec event and local stream sizes; and in the engine, `flowValueChars` and `toolResults.minPreviewBytes`.
- **The CLI's own waits are `NYLORUN_CLI_TUNING`**: `nylorun start`'s waits and polls, the Compose healthchecks and WAL cap, and `nylorun local sandbox`'s waits.
- **Studio follows the Runtime's limits**: no upload cap of its own, the Tenant's `requestBodyBytes` read for a write it parses past the default (`@nylorun/agents` exports `RUNTIME_LIMIT_DEFAULTS`), no CPU cap in its form.
- **Kept, each justified where it is defined**: Linux's `MAX_ARG_STRLEN` (a setup command's ceiling) and `PATH_MAX` (a link target), a model-facing tool name's 64 characters, RFC 6838's media type length, Postgres's 65,535 bind parameters, a tmpfs page, and identifier grammars (the protocol's).
