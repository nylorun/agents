---
"@nylorun/runtime": minor
---

**OpenAPI 3.2 documents for the Runtime's APIs.** Both documents are generated from the routes as declared for serving, so they can't drift from what the Runtime answers. Load either into any OpenAPI 3.2 tool, for example Scalar, to render API docs.

- **Tenant API:** `@nylorun/runtime/openapi.json`, also served at `GET /openapi.json`. The document route needs no key and refuses a browser `Origin`, as `/health` does.
- **Admin API:** `@nylorun/runtime/admin-openapi.json`, also served at `GET /v1/admin/openapi.json` with the admin key, on the operator listener when there is one.
- **Who may call each operation:** its `security` (application key, subject token, publishable key, executor key, admin key), plus `x-nylorun-credentials`, `x-nylorun-scopes` and `x-nylorun-browser`.
- **Event streams** are documented as `text/event-stream` with an `itemSchema`.
- **Deprecation:** the executor routes are marked deprecated.
- **Drift check:** committed snapshots in `runtime/openapi/` make every API change a reviewable diff, and `check-package` fails when the routes and the snapshots disagree.
