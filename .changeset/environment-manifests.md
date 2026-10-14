---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/agents": minor
"@nylorun/studio": minor
"nylorun": minor
---

**Environment manifests, and Environments that never change (protocol 14, D63 to D65).** An Environment's definition can now be saved like an agent: a named, versioned environment manifest, written as a JSON file with a published schema and checked with a plan before it is saved. An Environment is made from one version and keeps it for life; a save changes no Environment. The Runtime speaks protocol 14 only; sessions, Environments and vaults carry over. See MIGRATION.md.

- **Environment manifests.** `PUT /v1/environment-manifests/{name}` saves the next version, or answers the latest `unchanged`; `If-Match: <version>` refuses a save over a newer one (`412 manifest_changed`), and `?dryRun=true` answers the plan (changes, errors, warnings, the Environments behind) and saves nothing. Each version records `savedBy`. `GET` (latest), `GET /v1/environment-manifests`, `.../versions`, `.../versions/{n}` and `DELETE` (refused while an Environment names it, `409 manifest_in_use`). Migration 0025.
- **Pinned Environments.** `PUT /v1/environments/{id}` takes `manifest: "name"` (the latest at creation) or `"name@n"`. On an existing Environment only `labels` and `ownerUserId` may change; fields that match are accepted, and anything else is `409 environment_immutable` with `details.fields`. The view's `recipe` is now `manifest`, with `manifestName`, `manifestVersion`, `manifestHash` and `slots`; `version` and `appliedVersion` no longer move. `environment.created` names the manifest.
- **Secret slots.** A manifest's (or inline) `secrets` declares each secret's name, type, binding, `required` and `description`, never a value. On such an Environment a secret write sends only `{ value }` (or `{ headers }`), the binding comes from the slot, and an undeclared name is `409 secret_not_in_manifest`.
- **`requires`.** Agent manifest v7 takes `requires: { sandbox?: "none" | "any" | "pod", secrets? }` (`.requires()` in `@nylorun/core/define`), checked when a session opens (`409 environment_unsuitable`, `details.missing`). Turn variants keep it.
- **Dry runs.** `PUT /v1/agents/{id}?dryRun=true` checks a definition and saves nothing (`dryRun: true` in the answer).
- `@nylorun/core`: `PROTOCOL_VERSION` 14, `HOST_PROTOCOL` `{ min: 14, max: 14 }`, required feature `environment-manifests`; `EnvironmentManifestSchema`, `EnvironmentSecretSlotSchema`, `parseEnvironmentManifestRef` and the view, plan and save schemas; JSON Schemas at `@nylorun/core/schemas/environment-manifest.json` and `@nylorun/core/schemas/agent-manifest.json` (`$id` `https://docs.nylorun.com/schemas/environment-manifest/v1.json` and `.../agent-manifest/v7.json`).
- `@nylorun/agents`: `client.environments.manifests` (`save`, `plan`, `get`, `list`, `versions`, `delete`), `environmentManifest()`, `EnvironmentInput` (was `EnvironmentRecipeInput`), value-only `secrets.put`, and `saveAgent(agent, { dryRun })`.
- **Studio** edits only an Environment's labels and owner guard, shows the manifest it was made from, and its setup and files are read-only.
- `nylorun environments put` help says what it runs never changes.
