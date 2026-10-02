import { Agent, createActionHandler, createClient } from "@nylorun/agents";
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
const actions = createActionHandler({
  agents: [agent],
  runtime: {
    url: "http://127.0.0.1:8787",
  },
});
const answered: Response = await actions.fetch(
  new Request("http://localhost:3001/nylorun/actions", { method: "POST" }),
);
void answered;
await actions.register({ url: "http://localhost:3001/nylorun/actions" });
// @ts-expect-error Executors were removed in protocol 3.
import("@nylorun/agents/executor");
void startEphemeralRuntime;
