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
// Protocol 16: an agent is saved as an agent manifest, and sessions run on an Agent made from it.
await client.agentManifests.save({ agent, runtime: { kind: "virtual", network: { allowedHosts: [] } } });
await client.agents.put("users/local/web", { manifest: "test", owner: "local" });
const session = await client.createSession({ agent: "users/local/web", ownerUserId: "local" });
await client.createSession({ id: "web-1", agent: "users/local/web", ownerUserId: "local", info: { from: "types" } });
// @ts-expect-error Sessions name an Agent: there is no inline sandbox.
await client.createSession({ agent: "users/local/web", ownerUserId: "local", sandbox: "virtual" });
// @ts-expect-error Sessions name an Agent, not a definition and an Environment (protocol 16).
await client.createSession({ agentId: agent.manifest.id, ownerUserId: "local", environment: "users/local/web" });
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
});
await client.agentManifests.save({ agent: Agent({ id: "orders", name: "Orders" }).tools(lookupOrder).build() });
await client.agentManifests.save({ agent, runtime: { kind: "virtual" } }, { ifMatch: 0, requestId: "save-1" });
await client.agentManifests.plan({ agent });
// @ts-expect-error saveAgent was removed in protocol 16: save an agent manifest.
await client.saveAgent(agent);
// With no connection fields the client resolves the Project link (what the starter does).
const linked = await createClient();
await linked.agentManifests.save({ agent });
await linked.agents.put("test", { manifest: "test" });
// @ts-expect-error Approval is the Tenant's tool policy, not the tool's (R5 step 2).
http({ name: "x", input: z.object({}), url: "https://example.com", approval: "always" });
// @ts-expect-error Action handlers were removed: the Runtime runs agents from their manifests alone.
void sdk.createActionHandler;
// @ts-expect-error Action sandboxes went with them.
void sdk.createActionSandbox;
// @ts-expect-error Executors were removed in protocol 3.
import("@nylorun/agents/executor");
void startEphemeralRuntime;
