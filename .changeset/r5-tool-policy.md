---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/harness": minor
"@nylorun/agents": minor
"@nylorun/admin": minor
"@nylorun/studio": minor
---

**Tool approvals are the Tenant's tool policy (R5 step 2).** An agent's manifest used to say which tool calls wait for a person, and only the Runtime's own harness asked; a harness built from the Harness API could skip it. Now the operator sets one tool policy for every agent and every harness, and the Runtime enforces it before anything is sent.

- **`GET`/`PUT /v1/tenant/tool-policy`** (the Management API; `admin.toolPolicy.get()`/`.put({ rules })`): rules `{ effect: "allow" | "ask" | "deny", tool?, server?, kind?, agent?, when?, reason? }`. A rule matches a call when every selector it sets matches (`tool` and `server` take `*` globs; `when` tests input fields by dotted path with `equals`, `in`, `gt`, `gte`, `lt`, `lte` or `matches`). The strictest matching rule decides; a call no rule matches runs.
- **Enforced for every harness.** Core decides an MCP or HTTP tool call as it journals it. `deny` fails it to the model as `tool.denied`, unsent. `ask` holds the call (`held` at `/calls/tool`) and pauses the turn with one `approval` interaction per held call (`turn.paused`, with the tool, its input and the reason). `approve` sends that exact call, or fails it as `tool.denied`. The Tool Gate runs only calls the journal holds running, so a held or refused call cannot run. Nothing holds a process while it waits: an approval survives a restart. A flow's HTTP stages are decided the same way.
- **`approval` leaves the manifest.** `PUT /v1/agents/:id` and `saveAgent()` refuse a definition that sets `approval` on an HTTP tool, an MCP server or an MCP tool's settings; `http({ approval })` and `.mcp({ … approval })` throw; a turn manifest can no longer add one. The engine never asks for an HTTP or MCP tool's approval itself. A session pinned to a manifest saved with `approval: "always"` keeps it, as an ask.
- `@nylorun/studio`: a paused session shows an approval card for each held call, with its tool, why it is held and its input, and **Approve** / **Deny**.
- Migration: move each `approval: "always"` to an `ask` rule (see MIGRATION.md).
