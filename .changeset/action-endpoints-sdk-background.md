---
"@nylorun/core": minor
"@nylorun/agents": minor
"@nylorun/cli": minor
"@nylorun/studio": minor
---

**Action endpoints: background tools, CLI and Studio.**

- **Background tools (core, agents).** `tool({ …, background: true })` marks a tool that runs longer than an endpoint's timeout. The option is code-only and never serialized into the manifest. `createActionHandler` answers its delivery at once with `202`, runs the tool, heartbeats on the deadline the Runtime returns (each time with the newest delivery token), and posts the outcome. A heartbeat answered `409` (cancelled, lost or sent again) aborts the tool's `ctx.signal`, and nothing is posted. The new `waitUntil` option hands the background work to platforms that end a request's work with its response.
- **CLI.** `nylo tenant endpoints [--json]` lists each agent's Action endpoint and how it is doing, and `nylo tenant endpoints ping <agent>` pings one through the Runtime.
- **Studio.** Shows `action.delivered` ("Action delivered") and `action.delivery_failed` ("Delivery failed", with the endpoint's error and when it retries).
