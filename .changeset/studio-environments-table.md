---
"@nylorun/studio": minor
---

**Studio's Environments page is laid out like Sessions, grouped by environment manifest.**

- One table of every Environment: its manifest and version (or inline fields), kind, state, owner guard, labels, sessions and last use. It filters to one manifest from the table, the **All manifests** menu or the manifests now listed under Environments in the sidebar with their counts (`/environments?manifest=<name>`, `?manifest=-` for inline fields). A label in the table filters on it (`?label=key=value`).
- Filtered to a manifest, a one-line bar shows its latest version and who saved it, with **View manifest** (its JSON in a side panel, with Copy JSON) and **New version**; **New manifest** is in the menu. **New Environment** makes one from the filtered manifest, or asks which manifest or inline fields.
- Studio's proxy now forwards environment manifest reads and saves (`GET /v1/environment-manifests…`, `PUT /v1/environment-manifests/{name}` with `If-Match`) and Environment forks (`POST /v1/environments/{id}/fork`). Before, the manifests list failed with `404 Unsupported Studio operation` and forking from an Environment's page failed the same way.
