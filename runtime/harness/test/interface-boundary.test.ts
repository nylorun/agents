import { runAgent } from "./run-agent.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createExecutionState } from "../src/run/index.js";
import { Agent, AgentBuilder, type ModelRequest } from "@nylorun/core/define";
import { type ExecutionEvent } from "../src/index.js";

function expectDataOnly(value: unknown): void {
  expect(typeof value).not.toBe("function");
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const item of Object.values(value)) expectDataOnly(item);
}

describe("public interface boundaries", () => {
  it("encapsulates definitions while preserving build identity and developer-owned resources", async () => {
    const builder = Agent({ id: "a", name: "A" });
    const agent = builder.build();
    expect(builder.build()).toBe(agent);
    expect(Reflect.ownKeys(agent).sort()).toEqual([
      "getBinding",
      "id",
      "manifest",
      "name",
      "toJSON",
    ]);
    for (const field of ["registry", "middleware", "output"]) {
      expect(field in agent).toBe(false);
    }
    expect("state" in builder).toBe(false);
    const close = vi.fn(async () => {});
    const decorated = Object.assign(agent, { close });
    const state = createExecutionState(decorated);
    // Extracted run does not depend on a public receiver holding definitions.
    expect("run" in agent).toBe(false);
    const run = (options: import("../src/types/execution.js").RunOptions) =>
      runAgent(agent, options);
    expect((await run({ state, input: "go", onModelCall: async () => "ok" })).status).toBe(
      "completed",
    );
    await decorated.close();
    expect(close).toHaveBeenCalledOnce();
    expect(new AgentBuilder({ id: "direct", name: "Direct" }).build().id).toBe("direct");
  });

  it("initializes the original output contract without exposing its validator", async () => {
    const agent = Agent({
      id: "structured",
      name: "Structured",
      outputSchema: z.object({ count: z.number() }),
    }).build();
    const state = createExecutionState(agent);
    expect(state).toMatchObject({
      version: 1,
      status: "ready",
      outputContract: { type: "object" },
    });
    expect(state).not.toHaveProperty("executionVersion");
    expectDataOnly(state);
    expect(createExecutionState(agent).executionId).not.toBe(state.executionId);
    const result = await runAgent(agent, {
      state,
      input: "go",
      onModelCall: async () => ({ output: [{ type: "json", value: { count: 2 } }] }),
    });
    expect(result).toMatchObject({ status: "completed", output: { count: 2 } });
    expect(state.turnCount).toBe(0);
    expect(() => createExecutionState({ ...agent })).toThrow(/getBinding/);
  });

  it("projects tool metadata before adapters run while keeping dispatch and events intact", async () => {
    const execute = vi.fn(async ({ value }: { value: number }) => ({
      kind: "completed" as const,
      output: { doubled: value * 2 },
    }));
    const agent = Agent({ id: "tools", name: "Tools" })
      .use({
        id: "math",
        tools: [
          {
            name: "double",
            description: "Double a number",
            inputSchema: z.object({ value: z.number() }),
            outputSchema: z.object({ doubled: z.number() }),
            execute,
          },
        ],
      })
      .build();
    const requests: ModelRequest[] = [];
    const events: ExecutionEvent[] = [];
    const result = await runAgent(agent, {
      input: "double 3",
      onEvent: (event) => {
        events.push(event);
      },
      onModelCall: async (call, context) => {
        requests.push(context.request);
        const { tools, configuration } = context.request;
        expectDataOnly(tools);
        expectDataOnly(configuration);
        const descriptor = tools[0]!;
        expect(descriptor).toMatchObject({
          name: "double",
          description: "Double a number",
          owner: { middlewareId: "math", slot: "math" },
          inputSchema: { jsonSchema: { type: "object" } },
          outputSchema: { jsonSchema: { type: "object" } },
        });
        expect(tools).toEqual(configuration.tools);
        expect(Reflect.set(descriptor.inputSchema.jsonSchema, "type", "string")).toBe(false);
        expect(call.tools[0]).toEqual({
          name: "double",
          description: "Double a number",
          inputSchema: descriptor.inputSchema.jsonSchema,
        });
        if (requests.length === 1) {
          expect(execute).not.toHaveBeenCalled();
          return {
            output: [{ type: "tool-call", id: "call", name: "double", args: { value: 3 } }],
          };
        }
        return "done";
      },
    });
    expect(result.status).toBe("completed");
    expect(execute).toHaveBeenCalledOnce();
    const requested = events.filter((event) => event.type === "model.requested");
    expect(requested).toHaveLength(2);
    expect(requested[0]?.attributes.configuration).toEqual(requests[0]?.configuration);
  });
});
