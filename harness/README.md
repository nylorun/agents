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
})
  .use(capability({ id: "policy", after: { step: ({ text }) => ({}) } }))
  .before("turn", ({ info }) => ({ instructions: [`Tenant ${info?.tenantId}`] }));

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

This is a breaking beta: `agent.run()` has been removed. Application execution uses SDK sessions. Durable execution uses `createDurableCheckpoint` and `runDurable` with individually persisted model/tool/hook effects; a suspended checkpoint requires its effect journal.

## Tools

Prefer `input` / `output` / `run`. Legacy `inputSchema` / `execute` and tagged `{ kind: "completed" }` outcomes still work.

- `approval` — declarative pause before execute (code-only; not in the manifest)
- `effects` — `"read" | "idempotent" | "write"` (code-only)
- `ctx.idempotencyKey`, `ctx.redelivery`, `ctx.state`, `ctx.session`, `ctx.progress`
- Durable waits: `ctx.ask`, `ctx.approve`, `ctx.sleep`, `ctx.waitFor`, `ctx.step`

Definitions must not import `@nylorun/runtime`.

## Hooks

Register a hook with `before(scope, fn)` / `after(scope, fn)` on the agent, or
`before: { turn, step }` / `after: { step, turn }` on a capability. The scope says how
often your code runs:

| Hook             | Runs                                         | Returns                                            |
| ---------------- | -------------------------------------------- | -------------------------------------------------- |
| `before("turn")` | Once per turn, before the first model call   | `Patch`, applied to every model call in the turn   |
| `before("step")` | Before every model call                      | `Patch` for that call, layered over the turn patch |
| `after("step")`  | After every model response, before tools run | `Decision` (text/deny/approve/retry/block)         |
| `after("turn")`  | Once, on the final answer                    | `TurnDecision` (text or output/retry/block)        |

`Patch` is capabilities/tools/instructions/state/block, with no `model`. Registered
hooks are listed in the manifest (`capabilities[].hooks`). In a Runtime each hook point
is one delivery to your Action endpoint per turn or per model call, whatever the
number of capabilities using it, so prefer `"turn"` when a decision does not change
within a turn.

Hooks may run more than once when a delivery is retried, so keep side effects in
tools. `retry` is never capped by the engine: every `after` hook receives `attempt`,
so bound it yourself, for example
`attempt < 2 ? { retry: "Be specific" } : { block: "No usable answer" }`.

Local explicit engine execution retains middleware. Durable manifests reject arbitrary middleware closures; use hooks.

## Checkpoint / durability

`ExecutionState` is the continuation token (plus `manifestHash`). Runtime persists `record(state)` at durable boundaries and resumes with `continue` / `approve` / `respond` / `settle`. `checkCompatibility(manifest, state)` fails on hash mismatch.

## Client types

The authoritative session/action wire schemas live in `/contracts` and do not import durable checkpoint types. Use `@nylorun/agents` for the session client and the Action endpoint (`createActionHandler`). Historical root client types remain for deferred local tooling; they are not the new wire contract.
