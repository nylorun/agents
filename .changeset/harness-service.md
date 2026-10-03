---
"@nylorun/core": minor
"@nylorun/harness": minor
"@nylorun/runtime": minor
---

**Harness service over WebSocket, with the workspace capability (F6.2).** A Runtime started with `NYLORUN_HARNESS=remote` runs no harness of its own: it opens the Harness API listener (`NYLORUN_HARNESS_LISTEN_HOST`/`_PORT`, default port 4200, `NYLORUN_HARNESS_ALLOWED_HOSTS`), which accepts only the harness credential (`NYLORUN_HARNESS_TOKEN`) on `/nylorun/harness/v1`. The runtime image's `--service harness` connects to it (`NYLORUN_HARNESS_URL`, `NYLORUN_HARNESS_TOKEN`, `NYLORUN_GATES_URL`, `NYLORUN_HARNESS_ROOT`) and runs the Tenant's segments, MCP servers and sandboxes with no store; it refuses to start with a database, the gates' or keys' credential, or Restate settings, and presents only run tokens at the gates. The in-process harness stays the default.

- `@nylorun/core/harness-api`: the `workspace.*` requests core sends to a harness that serves workspaces, `tenantId` in the `hello` answer, a workspace record on `sandbox.state` claims, and `TurnStart.options.holdMs`. Tenant and admin status report the Tenant's harnesses (`harness`).
- `@nylorun/harness/api`: `createHarness` declares capabilities, reports grants (`onGrant`) and the `hello` answer, readies MCP through `executors.prepare` (`session.mcp`), and holds a run while its Action is pending until core sends the outcome (`effect.resolved`).
- `@nylorun/runtime`: the WebSocket listener and client, `--service harness`, the workspace capability (`ctx.sandbox` is a `WorkspacePort`; sandbox tool routes, `save_artifact`, sweep and reset reach the harness's workspaces), the SandboxManager's records port, and held runs (`actionHoldMs`, default 5 minutes). `save_artifact` runs in core. `NYLORUN_HARNESS_API` and the engine run in the advance are removed; tests run with `NYLORUN_TEST_HARNESS=memory|json|ws`.
