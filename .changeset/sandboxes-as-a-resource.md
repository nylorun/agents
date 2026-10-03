---
"@nylorun/runtime": minor
"@nylorun/core": minor
"@nylorun/agents": minor
"nylorun": minor
---

**Sandboxes are a resource (F7.1, blueprint D39; Host feature `sandboxes`).** A sandbox has its own id, a kind, a spec and labels, and outlives the sessions attached to it. Additive: protocol 5 is unchanged.

- `PUT /v1/sandboxes/{id}` creates a sandbox or finds the one with that id (get-or-create in one call); `GET /v1/sandboxes/{id}`, `GET /v1/sandboxes?label=key=value` (repeatable), `GET /v1/sandboxes/{id}/events` and `DELETE /v1/sandboxes/{id}`. Ids are `/`-separated segments (`team-a/proj-42`), sent percent-encoded as one path segment. Only kind `virtual` runs; `pod` is refused with `sandbox_unavailable`. The spec is resolved against the Tenant's limits and fixed once the sandbox exists; labels can change.
- A session attaches with `sandbox: { id }` and shares the sandbox's `/workspace` with every other session attached to it. Turns are serial per sandbox: a second session's turn is refused with `409 sandbox_busy` while another runs. Deleting a session (a sessions reset) only detaches it. Deleting a sandbox is refused while a turn runs in it; afterwards an attached session's next turn is refused with `sandbox_unavailable` until a sandbox with that id exists again.
- Subject tokens carry an `sbx` claim: `POST /v1/tokens` takes `sandboxes`, exact ids or prefixes ending in `/*` (at most 16). A token reaches only the sandboxes they match, checked when a session attaches and at every turn start (`403 sandbox_not_granted`); any other sandbox is the 404 of a missing one. The new scope `sandboxes:write` lets a role create and delete the sandboxes its grants reach. Application keys reach every sandbox.
- The Tenant holds at most `limits.sandboxes` sandboxes (`PUT /v1/tenant/sandbox`, default 100); one more is `409 limit_exceeded`.
- Lifecycle events (`sandbox.created`, `sandbox.attached`, `sandbox.detached`, `sandbox.deleted`) go to the sandbox's own stream in the record, through the record module; the session's log records `sandbox.attached`. The sandbox stream is not relayed to S2.
- New error codes `sandbox_not_granted`, `sandbox_busy` and `sandbox_unavailable`; the session view gains `sandboxId` and `sandboxSource: "sandbox"`. Migration `0004_sandbox_resources` adds `sandbox_resources`, `nylorun_streams.sandbox_events` and the sessions' `sandbox_id` column.
- `@nylorun/agents`: `client.sandboxes` with `ensure(id, spec)`, `get`, `list({ labels })`, `delete`, `events`, and `forSession({ session, spec })`, which creates a sandbox for one session, opens the session on it, and deletes it with `release()`. It replaces sharing through another session (`sandbox: { session }` and the view's `sandboxOwnerId`, now deprecated). `client.tokens.create` takes `sandboxes`.
- `nylorun sandbox ls [--label key=value]... [--json]` and `nylorun sandbox rm <id>` list and delete the running local Tenant's sandboxes.
