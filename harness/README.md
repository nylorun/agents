# `@nylorun/harness`

Execution engine, checkpoints and durable host effects. Shared authoring and wire
contracts live in `@nylorun/core`; applications use `@nylorun/agents`.
OSS publishes harness for local Runtime; Cloud installs published packages from
npm independently.

Use `/run` for explicit execution, `/model/adapters` for provider format adapters,
and `/compatibility` for checkpoint compatibility. Definitions and protocol
schemas are no longer harness exports.

> **DX v5.6:** definition ⊥ engine. `model` is not on `Agent({})` — Runtime injects `onModelCall`. Host data stays `info` (not `user`); session memory is `state`.

## Compose an agent

```ts
import { Agent, tool, ToolError, capability } from "@nylorun/agents/define";
import { z } from "zod";

const lookup = tool({
  name: "lookup_order",
  input: z.object({ orderId: z.string() }),
  effects: "read",
  async run({ orderId }, ctx) {
    const order = await orders.find(orderId, { info: ctx.info, signal: ctx.signal });
    if (!order) throw new ToolError("not_found", "No such order.");
    return order; // plain return = completed
  },
});

export const supportAgent = Agent({
  id: "support",
  name: "Support",
  instructions: "You help customers with orders. Be brief.",
  tools: [lookup],
}).capability(capability({ id: "policy" }).instructions("Never promise a refund."));

// Optional: .build() is a no-op facade
const agent = supportAgent.build();

JSON.stringify(supportAgent); // manifest
Agent.from(supportAgent.toJSON(), implementations);
```

`.use()` returns a **new** agent. Top-level `tools` / `instructions` are first-class. Do **not** put `model` on `Agent({})` — Runtime resolves and calls the model.

## Run the loop

Taught path for hosts/Runtime:

```ts
import { run, bindingFromAgent } from "@nylorun/harness/run";

const result = await run({
  binding: bindingFromAgent(supportAgent.build()),
  input: "Hello",
  onModelCall: async () => "Hello back!",
  info: { tenantId: "acme" },
  record: (state) => store.save(state),
});
```

This is a breaking beta: `agent.run()` has been removed. Application execution uses SDK sessions. Durable execution uses `createDurableCheckpoint` and `runDurable` with individually persisted model and tool effects; a suspended checkpoint requires its effect journal.

## Tools

Prefer `input` / `output` / `run`. Legacy `inputSchema` / `execute` and tagged `{ kind: "completed" }` outcomes still work.

- `approval` — declarative pause before execute (code-only; not in the manifest)
- `effects` — `"read" | "idempotent" | "write"` (code-only)
- `ctx.idempotencyKey`, `ctx.redelivery`, `ctx.state`, `ctx.session`, `ctx.progress`
- Durable waits: `ctx.ask`, `ctx.approve`, `ctx.sleep`, `ctx.waitFor`, `ctx.step`

Definitions must not import `@nylorun/runtime`.

Local explicit engine execution retains middleware. Durable manifests reject middleware
closures: a hosted agent is its manifest, and the Runtime never calls your code during a session.

## Checkpoint / durability

`ExecutionState` is the continuation token (plus `manifestHash`). Runtime persists `record(state)` at durable boundaries and resumes with `continue` / `approve` / `respond` / `settle`. `checkCompatibility(manifest, state)` fails on hash mismatch.

## Client types

The authoritative session/action wire schemas live in `/contracts` and do not import durable checkpoint types. Use `@nylorun/agents` for the session client and to save agents (`saveAgent`); the Runtime runs no code of yours during a session, so a tool there is an `http()` tool or a remote MCP server's. Historical root client types remain for deferred local tooling; they are not the new wire contract.
