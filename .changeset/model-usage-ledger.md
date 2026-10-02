---
"@nylorun/runtime": minor
"@nylorun/core": minor
---

**Every model call is recorded in the Tenant's usage ledger.** The model gate writes one row per call that answers: the session, turn and agent, the provider and model, the tokens (input, output, cached, cache write, reasoning) and pi-ai's price in USD. Custom endpoints count as $0. A call the gateway ran twice after a restart is recorded twice and flagged as a duplicate, since the provider billed both.

- `GET /v1/tenant/usage?scope=tenant|agent|turn&id=&period=day|month|total` totals the ledger. It needs the application key or `tenant:settings`, like the other Tenant settings.
- `@nylorun/core/contracts` adds `ModelUsageScopeSchema`, `ModelUsageQuerySchema` and `ModelUsageTotalsSchema`.
- The ledger survives a `sessions` reset. A reset of scope `all` clears it.
- Tenant schema migration 10 adds the `model_usage` table. The gateway and the runtime must run the same build, as before.
