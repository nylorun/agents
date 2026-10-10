import { runAgent } from "./run-agent.js";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { Agent } from "@nylorun/core/define";
import { type ExecutionEvent } from "../src/index.js";

it("emits causal correlated events and independent observer-failure diagnostics", async () => {
  const events: ExecutionEvent[] = [];
  let fail = true;
  const agent = Agent({ id: "a", name: "A" })
    .use({
      id: "tools",
      tools: [
        {
          name: "t",
          inputSchema: z.object({}),
          execute: async () => ({ kind: "completed", output: "done" }),
        },
      ],
    })
    .build();
  let calls = 0;
  const result = await runAgent(agent, {
    input: "go",
    onModelCall: async () =>
      calls++ ? "done" : { output: [{ type: "tool-call", id: "c", name: "t", args: {} }] },
    onEvent: (event) => {
      events.push(event);
      if (fail) {
        fail = false;
        throw new Error("observer unavailable");
      }
    },
  });
  expect(result.status).toBe("completed");
  const types = events.map((event) => event.type);
  expect(types).toContain("observation.failed");
  for (const [before, after] of [
    ["step.started", "model.requested"],
    ["model.requested", "model.completed"],
    ["model.completed", "tool.sealed"],
    ["tool.sealed", "tool.started"],
    ["tool.started", "tool.completed"],
    ["turn.completed", "execution.completed"],
  ])
    expect(types.indexOf(before!)).toBeLessThan(types.lastIndexOf(after!));
  expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
  expect(events.every((event) => event.executionId === result.state.executionId)).toBe(true);
});

it("does not fail execution when an asynchronous observer rejects", async () => {
  const events: string[] = [];
  const result = await runAgent(Agent({ id: "a", name: "A" }).build(), {
    input: "go",
    onModelCall: async () => "done",
    onEvent: async (event) => {
      events.push(event.type);
      if (event.type !== "observation.failed") throw new Error("observer failed");
    },
  });
  expect(result.status).toBe("completed");
  expect(events).toContain("observation.failed");
});

it("observes early policy failures without a model call", async () => {
  const onModelCall = vi.fn(async () => "bad");
  const events: ExecutionEvent[] = [];
  const result = await runAgent(
    Agent({ id: "a", name: "A" })
      .use("policy", async (request) =>
        request.tripwire({ code: "policy.denied", message: "Denied" }),
      )
      .build(),
    {
      input: "go",
      onModelCall,
      onEvent: (event) => {
        events.push(event);
      },
    },
  );
  expect(result.status).toBe("failed");
  expect(onModelCall).not.toHaveBeenCalled();
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "tripwire",
        code: "policy.denied",
        attributes: { message: "Denied" },
      }),
      expect.objectContaining({ type: "execution.failed" }),
    ]),
  );
});

it("reports thrown tool failures and continues with a model-visible result", async () => {
  const events: ExecutionEvent[] = [];
  const agent = Agent({ id: "a", name: "A" })
    .use({
      id: "tools",
      tools: [
        {
          name: "t",
          inputSchema: z.object({}),
          execute: async () => {
            throw new Error("tool failed");
          },
        },
      ],
    })
    .build();
  let calls = 0;
  const result = await runAgent(agent, {
    input: "go",
    onEvent: (event) => {
      events.push(event);
    },
    onModelCall: async (call) => {
      if (calls++) {
        expect(JSON.stringify(call.prompt)).toContain("tool failed");
        return "recovered";
      }
      return { output: [{ type: "tool-call", id: "c", name: "t", args: {} }] };
    },
  });
  expect(result.status).toBe("completed");
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "tool.completed",
        outcome: "failed",
        invocationId: expect.any(String),
      }),
    ]),
  );
});
