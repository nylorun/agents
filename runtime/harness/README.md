# `@nylorun/harness`

Execution engine, checkpoints and durable host effects. Shared authoring and wire
contracts live in `@nylorun/core`; applications use `@nylorun/agents`.
OSS publishes harness for local Runtime; Cloud installs published packages from
npm independently.

Use `/run` for explicit execution, `/api` for a harness over the Harness API,
and `/compatibility` for checkpoint compatibility. Definitions and protocol
schemas are no longer harness exports.

The harness makes no model call. Each step projects a provider-neutral `ModelCall`
(`@nylorun/core/define`) and hands it to its host: to `onModelCall` with `run`, or
as a model effect with `runDurable` and `/api`. The Runtime's Model Gate makes the
provider call.

> **DX v5.6:** definition ⊥ engine. `model` is not on `Agent({})` — Runtime injects `onModelCall`. Host data stays `info` (not `user`); session memory is `state`.

## Compose an agent

```ts
import { Agent, tool, ToolError } from "@nylorun/agents/define";
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

export const supportAgent = Agent({ id: "support", name: "Support" })
  .instructions("You help customers with orders. Be brief.", "Never promise a refund.")
  .tools(lookup);

// Optional: .build() is a no-op facade
const agent = supportAgent.build();

JSON.stringify(supportAgent); // manifest v7: { manifestSchemaVersion: 7, id, name, instructions, tools }
Agent.from(supportAgent.toJSON(), { tools: { lookup_order: lookup } });
```

The manifest is flat: the agent's `instructions`, `tools`, `skills` and `mcpServers` are top-level, and a skill or server from an Agent Plugin carries its `plugin` label. A tool's name may not contain `__` (an MCP server's tools). A session pins the manifest as registered; when our harness runs a turn it adds the model-facing text and tools from the facts the Runtime states (`engineToolsFor`): the sandbox tools and note with a sandbox, the skill tools with the skill catalog, and the artifact tools. Each tool call names what runs it (its effect `target`), so no name is reserved: a name two of the model's tools share fails the turn.

Each builder call (`.instructions()`, `.tools()`, `.subagents()`, `.mcp()`, `.output()`) returns a **new** agent; the engine offers the agent's instructions and tools to the model on every step. Do **not** put `model` on `Agent({})` — Runtime resolves and calls the model.

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

There is no step middleware: a hosted agent is its manifest, and the Runtime runs it from
that alone.

## Checkpoint / durability

`ExecutionState` is the continuation token (plus `manifestHash`). Runtime persists `record(state)` at durable boundaries and resumes with `continue` / `approve` / `respond` / `settle`. `checkCompatibility(manifest, state)` fails on hash mismatch.

## Client types

The authoritative session/action wire schemas live in `/contracts` and do not import durable checkpoint types. Use `@nylorun/agents` for the session client and to save agents (`saveAgent`); the Runtime runs agents from their manifests alone, so a tool there is an `http()` tool or a remote MCP server's. Historical root client types remain for deferred local tooling; they are not the new wire contract.
