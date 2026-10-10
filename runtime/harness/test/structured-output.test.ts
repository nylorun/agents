import { runAgent } from "./run-agent.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent, defineSchema, type ModelCandidate } from "@nylorun/core/define";

describe("agent output contracts", () => {
  it("projects and validates the final schema through a tool loop", async () => {
    const seen: unknown[] = [];
    const schema = z.object({ count: z.coerce.number() });
    const agent = Agent({ id: "a", name: "A", outputSchema: schema })
      .use({
        id: "tools",
        tools: [
          {
            name: "lookup",
            inputSchema: z.object({}),
            execute: async () => ({ kind: "completed", output: 3 }),
          },
        ],
      })
      .build();
    let calls = 0;
    const result = await runAgent(agent, {
      input: "go",
      onModelCall: async (call) => {
        seen.push(call.outputSchema);
        return calls++
          ? { output: [{ type: "json", value: { count: "3" } }] }
          : { output: [{ type: "tool-call", id: "c", name: "lookup", args: {} }] };
      },
    });
    expect(result).toMatchObject({ status: "completed", output: { count: 3 } });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(seen[1]);
  });
  it.each<ModelCandidate>([
    { output: [{ type: "text", text: '{"count":3}' }] },
    { output: [{ type: "json", value: { count: "bad" } }] },
    {
      output: [
        { type: "json", value: { count: 3 } },
        { type: "json", value: { count: 4 } },
      ],
    },
  ])("rejects nonconforming final output", async (candidate) => {
    const agent = Agent({
      id: "a",
      name: "A",
      outputSchema: z.object({ count: z.number() }),
    }).build();
    const result = await runAgent(agent, { input: "go", onModelCall: async () => candidate });
    expect(result).toMatchObject({ status: "failed", error: { code: "output.invalid" } });
    expect(result.state.transcript.some((entry) => entry.kind === "candidate")).toBe(true);
  });
  it("validates the final middleware replacement", async () => {
    const agent = Agent({ id: "a", name: "A", outputSchema: z.object({ count: z.number() }) })
      .use("review", async (_, next) => {
        const response = await next();
        response.replace({ output: [{ type: "json", value: { count: 9 } }] });
        return response;
      })
      .build();
    expect(
      await runAgent(agent, {
        input: "go",
        onModelCall: async () => ({ output: [{ type: "json", value: { count: 3 } }] }),
      }),
    ).toMatchObject({ status: "completed", output: { count: 9 } });
  });
  it("binds explicit and Standard Schema output contracts", async () => {
    const explicit = defineSchema({
      jsonSchema: { type: "number" },
      validate: (value: unknown) =>
        typeof value === "number"
          ? { ok: true as const, value }
          : {
              ok: false as const,
              issues: [{ path: [], code: "invalid", message: "number required" }],
            },
    });
    const standard = {
      "~standard": {
        validate: (value: unknown) =>
          typeof value === "number" ? { value } : { issues: [{ message: "number required" }] },
        jsonSchema: { input: () => ({ type: "number" }), output: () => ({ type: "number" }) },
      },
    };
    for (const outputSchema of [explicit, standard])
      expect(
        await runAgent(Agent({ id: "a", name: "A", outputSchema }).build(), {
          input: "go",
          onModelCall: async () => ({ output: [{ type: "json", value: 7 }] }),
        }),
      ).toMatchObject({ status: "completed", output: 7 });
  });
});
