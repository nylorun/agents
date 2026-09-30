import { expect, it } from "vitest";
import { z } from "zod";
import { Agent, tool } from "@nylorun/core/define";
import { ActionSchema, type Action } from "@nylorun/core/contracts";
import { executeAction } from "../src/execute-action.js";

const seen: unknown[] = [];
const search = tool({
  name: "search_orders",
  input: z.object({ query: z.string() }),
  run: async ({ query }, ctx) => {
    seen.push(ctx.agent);
    ctx.state.set("last", query);
    return `found ${query}`;
  },
});
const researcher = Agent({ id: "researcher", description: "Researches.", tools: [search] })
  .before("step", () => ({ instructions: ["child hook"] }))
  .build();
const support = Agent({ id: "support", tools: [researcher] }).build();
const agent = { id: "researcher", path: "support/researcher", delegationId: "invocation_1" };

const base = {
  actionId: "t:0:tool:invocation_1/invocation_2",
  sessionId: "s1",
  turnId: "t",
  agentId: "support",
  manifestHash: "hash",
  implementationVersion: "dev",
  context: {},
  status: "delivering" as const,
  generation: 1,
};

it("keeps the agent identity through the wire schema", () => {
  const parsed = ActionSchema.parse({
    ...base,
    kind: "tool",
    capabilityId: "agent",
    toolName: "search_orders",
    input: {},
    agent,
  });
  expect(parsed.agent).toEqual(agent);
});

it("runs a delegated agent's tool from the root binding", async () => {
  const action: Action = {
    ...base,
    kind: "tool",
    capabilityId: "agent",
    toolName: "search_orders",
    input: { query: "A" },
    agent,
  };
  const outcome = await executeAction(action, support, new AbortController().signal);
  expect(outcome).toEqual({
    value: { kind: "completed", output: "found A" },
    statePatch: { last: "A" },
  });
  expect(seen.at(-1)).toEqual(agent);
});

it("runs a delegated agent's hooks", async () => {
  const action: Action = {
    ...base,
    kind: "hook",
    hook: { at: "before", scope: "step", capabilityIds: ["agent"] },
    input: { step: 0, state: {}, messages: [] },
    agent,
  };
  const outcome = await executeAction(action, support, new AbortController().signal);
  expect(outcome.value).toEqual({ results: { agent: { instructions: ["child hook"] } } });
});

it("tells root tools which agent they belong to", async () => {
  const root = Agent({ id: "root", tools: [search] }).build();
  await executeAction(
    { ...base, agentId: "root", kind: "tool", capabilityId: "agent", toolName: "search_orders", input: { query: "B" } },
    root,
    new AbortController().signal
  );
  expect(seen.at(-1)).toEqual({ id: "root", path: "root" });
});
