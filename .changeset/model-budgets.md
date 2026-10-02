---
"@nylorun/runtime": minor
"@nylorun/core": minor
---

**Hard caps on model spend.** A Tenant can cap what its model calls use, per turn, per agent per UTC day or month, or for the whole Tenant per day or month, in USD, tokens or both. Before each call the model gate checks the scope's recorded spend, plus its calls in flight, against the cap. Once a cap is reached the call fails with the new `budget_exhausted` code, which is never retried, and the turn fails with `model.budget_exhausted`. A runaway loop stops there, at most one call over its cap.

- `PUT /v1/tenant/budgets` replaces the budgets and `GET /v1/tenant/budgets` reads them. Both need the application key or `tenant:settings`.
- `@nylorun/core` adds `budget_exhausted` to `ModelFailureCode` and `MODEL_FAILURE_CODES`, plus `ModelBudgetSchema`, `PutModelBudgetsRequestSchema` and `ModelBudgetsSchema`. Code that switches over failure codes exhaustively needs the new case.
- Custom endpoints are priced at $0, so only a token limit stops them.
- Budgets survive a `sessions` reset. A reset of scope `all` clears them.
