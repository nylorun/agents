---
"@nylorun/agents": minor
---

**`@nylorun/agents/ag-ui`: serve agents to AG-UI clients from your own server.** `createAgUiHandler({ basePath, agents, subject })` returns a web-standard `fetch` handler (plus `run`, `history`, `reattach` and `cancel`), and `toNodeListener` adapts it to `node:http` and Express.

- One session per person, agent and thread; the AG-UI message id is the idempotency key, so a retried run replays the same turn.
- Approvals become AG-UI interrupts and resume through `runAgent({ resume })`.
- History returns a plain AG-UI `Message[]` with the ids the live run used; reattach continues a run from `Last-Event-ID`.
- Needs a Runtime with `transcript-events`. Adds the `@ag-ui/core` dependency (`~1.0.0`), loaded only by this subpath.

`AgentsClient.hostFeatures()` returns the Runtime's protocol features, including optional ones.
