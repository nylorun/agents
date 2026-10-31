---
"@nylorun/core": minor
"@nylorun/harness": minor
---

An agent asks for an app to be connected (A2A profile v2, `interactions/v1` kind `connection`).

- **`request_connection`**, a built-in tool of our engine, off by default. A version opts in with `harness.loop.connections: true` (in an agent folder, `loop: { connections: true }` in `AGENT.md`); the session's root agent then gets the tool, unless it declares its own tool of that name.
- A call takes `{ app, reason }` (app cut at 80 characters, reason at 280, never refused for length) and pauses the turn on an interaction: kind `response`, prompt `Connect <app>: <reason>`, `metadata: { kind: "connection", app, reason }`, which the session's `waits` carry. Answered with `respond`, `true` or `{ connected: true }` gives the model `Connected: <app>`; any other value `Not connected: <app>`.
- The agent folder compiler takes `loop.connections` (true or false).
