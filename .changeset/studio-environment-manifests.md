---
"@nylorun/studio": minor
"@nylorun/create-agent": minor
"@nylorun/agents": patch
---

**Studio and the starter for environment manifests (protocol 14).**

- **Studio, Environments page:** lists the environment manifests (each one's latest version, its kind, how many Environments were made from it, and who saved it). It saves a new version from JSON, with Check showing the plan first, under `If-Match`, so a save over someone else's is refused. It also makes an Environment from a version. Studio is one more client: any credential that may write Environments can do the same from the CLI or the SDK.
- **Studio, Environment page:** shows the manifest version it was made from and whether a newer one exists ("Fork to vN"), the Environment it was forked from, its secret slots set or missing, and its pod's image digest. **Fork** opens the fork with its plan (disk, secrets copied and left behind, slots still missing, changes) before it makes the new Environment.
- **The starter** ships `environments/scratch.json` (a virtual workspace with no network). `src/main.ts` saves each manifest in `environments/` beside the agents.
- `@nylorun/agents` exports the manifest and fork contract types (`EnvironmentManifestView`, `EnvironmentManifestPlan`, `EnvironmentForkPlan`, …).
