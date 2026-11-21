---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/admin": minor
"@nylorun/studio": minor
"nylorun": minor
---

No image carries the engine (ADR-161, breaking; see docs/upgrading/migration.md). The Tenant's `engine.images` is retired: `PUT /v1/tenant/sandbox` refuses it, `GET`, the `PUT` answer, the admin SDK and Studio's Compute tab no longer show it, and a value an older Runtime stored is dropped on read. The sandboxes service refuses `entrypoint: "builtin"`, so every pod copies or mounts the Runtime's engine and every computer runs the computer agent. A pod engine no longer reports an engine of its own at join. nylorun/agents no longer publishes `ghcr.io/nylorun/dev` or its `engine-<runtime>` builds (`images/dev`, `images/dev-engine` and their workflows are removed): pin your own computer image, built from the recipe in `docs/self-hosting/computer-images.md`.
