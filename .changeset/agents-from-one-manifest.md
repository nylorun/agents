---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/harness": minor
"@nylorun/agents": minor
"@nylorun/admin": minor
"@nylorun/studio": minor
"nylorun": minor
"@nylorun/create-agent": minor
---

Protocol 16, Agents from one manifest (track T2), a fresh start. An agent manifest (v8) is one versioned document at `/v1/agent-manifests/{name}` with a `harness` section (what runs inside the loop, including the harness's id) and a `runtime` section (what an environment manifest said). The Runtime checks the two against each other when it is saved (`422 manifest_inconsistent` with `details.gaps`), in place of `requires` at session open. Agent definitions and environment manifests are gone.

Environments are Agents: `/v1/agents/{id}` and its sub-routes, made from a saved manifest only (`manifest: "name"` tracks it, `"name@n"` pins a version; either resolves once, into `resolvedVersion`), with a derived `state` (`working`, `sleeping`, `input_required`, `failing`, `paused`) and `attention`. Every session runs on one Agent (`PUT /v1/sessions/{id} { agent, ownerUserId }`) and pins its manifest version. No session is special (D71). Error codes, events (`agent.*`), scopes (`agents:write`, `agent-manifests:write`) and identity-file grants (`agents`) say Agent; model budget scope `agent` is `manifest`. Harness API 5: `turn.start.agent` replaces `turn.start.environment`, with `definition` and `loop`. Migration 0032 closes older sessions (`protocol_16`) and drops Environments with their disks and vaults.

The SDK has `client.agentManifests`, `client.agents` and `composeManifest(dir)` for three-file authoring; the CLI has `nylorun apply`, `nylorun agent-manifests`, `nylorun agents` and `nylorun migrate v8`; Studio has an Agents screen, an Agent page and an Agent manifests screen. See MIGRATION.md.
