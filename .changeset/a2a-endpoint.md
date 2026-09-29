---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/agents": minor
---

**A2A: serve agents to other agents (v1, gateway mode).** The Runtime answers [A2A](https://a2a-protocol.org) 1.0 over JSON-RPC for the Tenant's agents (optional Host feature `a2a-endpoint`), and the app server publishes them with `createA2aHandler`.

- **Runtime.** `POST /v1/a2a/agents/:agent` acts for a subject with `sessions:own`. It serves `SendMessage` (blocking up to 5 minutes, or `returnImmediately`), `GetTask` and `CancelTask`. A context is one session per subject, agent and `contextId`, and a task is one turn. A question pauses the task as `TASK_STATE_INPUT_REQUIRED` until the caller replies on the same task. The `messageId` is the idempotency key. `ListTasks`, streaming, push notifications and the extended card answer with their A2A errors, and approvals cannot be answered over A2A yet. `GET /v1/a2a/agents/:agent/card` returns the card built from the manifest, without interfaces. `observeSession` lets in-process readers join a session's shared event feed.
- **Agents SDK.** `@nylorun/agents/a2a`: `createA2aHandler({ agents, subject, publicUrl, card })` forwards each partner's JSON-RPC request to the Runtime as that partner's subject, and serves the Agent Card with its own URL, provider and security schemes. It loads no A2A package. `Transport.forward` returns the Runtime's raw response.
