import { runAgent } from "./run-agent.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Agent, defineSchema, type ModelCandidate } from "@nylorun/core/define";

describe("agent output contracts", () => {
  it("projects and validates the final schema through a tool loop", async () => {
    const seen: unknown[] = [];
    const schema = z.object({ count: z.coerce.number() });
    const agent = Agent({ id: "a", name: "A", outputSchema: schema })
      .tools({
        name: "lookup",
        inputSchema: z.object({}),
        execute: async () => ({ kind: "completed", output: 3 }),
      })
      .build();
    let calls = 0;
    const result = await runAgent(agent, {
      input: "go",
      onModelCall: async (call) => {
        // The engine asks for JSON itself (protocol 15): the call carries no schema of its own.
        expect(call).not.toHaveProperty("outputSchema");
        const system = call.prompt[0]!;
        seen.push(
          system.kind === "instructions" && system.content[0]?.type === "text"
            ? system.content[0].text
            : "",
        );
        return calls++
          ? { output: [{ type: "json", value: { count: "3" } }] }
          : { output: [{ type: "tool-call", id: "c", name: "lookup", args: {} }] };
      },
    });
    expect(result).toMatchObject({ status: "completed", output: { count: 3 } });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[0]).toContain(
      `Return the final answer as JSON matching this schema: ${JSON.stringify(agent.manifest.outputSchema)}. Use tools when needed before returning the final JSON.`,
    );
  });
  it("reads a text answer as JSON, fenced or with raw control characters (protocol 15)", async () => {
    const agent = Agent({
      id: "a",
      name: "A",
      outputSchema: z.object({ note: z.string() }),
    }).build();
    for (const text of ['{"note":"ok"}', '```json\n{"note": "two\nlines"}\n```']) {
      const result = await runAgent(agent, {
        input: "go",
        onModelCall: async () => ({ output: [{ type: "text", text }] }),
      });
      expect(result).toMatchObject({ status: "completed" });
      expect(result.state.transcript.at(-2)).toMatchObject({
        kind: "candidate",
        candidate: { output: [{ type: "json" }] },
      });
    }
  });
  it("fails a text answer that is not JSON with model.invalid_output, keeping the text", async () => {
    const agent = Agent({
      id: "a",
      name: "A",
      outputSchema: z.object({ count: z.number() }),
    }).build();
    const result = await runAgent(agent, {
      input: "go",
      onModelCall: async () => ({ output: [{ type: "text", text: "not json" }] }),
    });
    expect(result).toMatchObject({ status: "failed", error: { code: "model.invalid_output" } });
    expect(result.state.transcript.at(-1)).toMatchObject({
      kind: "candidate",
      candidate: { output: [{ type: "text", text: "not json" }] },
    });
  });
  it.each<ModelCandidate>([
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
