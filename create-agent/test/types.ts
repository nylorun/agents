import { Agent, createClient, http } from "@nylorun/agents";
import * as sdk from "@nylorun/agents";
import { z } from "zod";
import { startEphemeralRuntime } from "@nylorun/runtime";
import { piModel } from "@nylorun/runtime/node";
import type { ModelAdapter } from "@nylorun/core/define";

const model: ModelAdapter = piModel();
void model;
const agent = Agent({ id: "test", name: "Test" }).build();
// @ts-expect-error Definitions do not execute themselves.
agent.run();
const client = createClient({
  url: "http://127.0.0.1:8787",
  key: "server",
});
const session = await client.createSession({
  agentId: agent.manifest.id,
  ownerUserId: "local",
});
await session.input("hello", { idempotencyKey: "input-1" });
await session.history();
await session.cancel({ idempotencyKey: "cancel-1" });
// Definitions are saved, never served: tools are HTTP tools the Runtime calls itself.
const lookupOrder = http({
  name: "lookup_order",
  input: z.object({ orderId: z.string() }),
  url: "https://orders.example.com/lookup",
  method: "POST",
  timeoutMs: 10_000,
  approval: "never",
});
await client.saveAgent(Agent({ id: "orders", name: "Orders" }).tools(lookupOrder).build());
await client.saveAgent(agent, { implementationVersion: "1.0.0", requestId: "save-1" });
await client.saveAgent(agent);
// With no connection fields the client resolves the Project link (what the starter does).
const linked = await createClient();
await linked.saveAgent(agent);
// @ts-expect-error Approval is "always" or "never".
http({ name: "x", input: z.object({}), url: "https://example.com", approval: "sometimes" });
// @ts-expect-error Action handlers were removed: the Runtime runs no code of yours during a session.
void sdk.createActionHandler;
// @ts-expect-error Action sandboxes went with them.
void sdk.createActionSandbox;
// @ts-expect-error Executors were removed in protocol 3.
import("@nylorun/agents/executor");
void startEphemeralRuntime;
