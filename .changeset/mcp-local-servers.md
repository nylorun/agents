---
"@nylorun/core": minor
"@nylorun/runtime": patch
"@nylorun/agents": patch
"@nylorun/studio": patch
"nylorun": patch
---

**Local MCP servers work on a local Tenant, and a server that does not connect shows.** Additive; the protocol stays at 7.

- `@nylorun/runtime`: remote MCP servers (`streamable-http`, `sse`) are reached under the Host's address policy, as Action endpoints are (`NYLORUN_ENDPOINT_*`, `tenant/outbound.ts`). In the local Docker stack `localhost`, `127.0.0.1` and `[::1]` now mean the machine that runs Docker (`host.docker.internal`), so `.mcp({ x: { type: "streamable-http", url: "http://localhost:3002/x" } })` connects where it used to fail with `fetch failed`. With `NYLORUN_ENDPOINT_PRIVATE=refuse` a server on a private address is refused; with `NYLORUN_ENDPOINT_HTTP=refuse` an `http` server is refused. Redirects are still not followed. A connection failure now names its cause (`connect ECONNREFUSED …`) instead of `fetch failed`. This applies in the gateway, a harness process and an in-process Tenant. `guardedFetch` takes `stream: true`: the answer streams, unbounded, with no timeout but the caller's signal.
- `@nylorun/core`: new session event `mcp.discovered`, recorded once on the session's first turn with the MCP snapshot: one entry per declared server with `outcome` (`connected`, `refused`, `failed`), `message` and the number of `tools` it added (`McpDiscoveredPayloadSchema`, `McpServerOutcomeSchema`). A server that does not connect adds no tools for the session's life; this is where that shows in the event log, beside `mcpDiagnostics`.
- `@nylorun/agents`: `.plugin()` and `plugin()` emit a process warning (`NylorunPluginWarning`, the diagnostic's code) for each part of the package they skip, so building or registering the agent says when a plugin's MCP server was dropped. The `plugin.mcp-server-skipped` message now says why: for example, plain `http` is accepted only for `localhost`, `127.0.0.1` or `[::1]`.
- `@nylorun/studio`: the event list labels `mcp.discovered` and summarizes each server's outcome.
