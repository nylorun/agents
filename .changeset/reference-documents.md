---
"@nylorun/runtime": minor
---

**Two reference documents (Runtime and Management APIs, step A6).** The Runtime serves the Runtime API's OpenAPI document at `/openapi/runtime.json` (`/openapi.json` stays as its alias) and the Management API's at `/openapi/management.json`, both without a key. The package ships them as `@nylorun/runtime/openapi.json` and the new `@nylorun/runtime/management-openapi.json`, and both are attached to each release. Each document has described tags, every operation in one of them, in the order a developer uses them, and only the schemas it uses. The Runtime API's tags are grouped (`x-tagGroups`): Get started (Runtime), Agents (Agents, Action endpoints, Deliveries), Sessions (Sessions API, AG-UI, A2A), Sandboxes & artifacts. The Management API's tags are Tenant, Application keys, Models, Vaults, Signing keys and Settings.
