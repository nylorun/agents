import { describe, expect, it, vi } from "vitest";
import { tool as authoredTool } from "@nylorun/core/define";
import { testAgent, model, tool, toolCalls, turn } from "./fixtures.js";
import { z } from "zod";

describe("step pipeline", () => {
  it("tripwires duplicate dynamic tools before the Model runs", async () => {
    expect(() =>
      testAgent()
        .tools(tool("echo"), tool("echo"))
        .with(model(async () => "done"))
        .build(),
    ).toThrow(/Tool 'echo' is declared twice/);
  });

  it("freezes the tool snapshot so later mutations do not change the bound input schema", async () => {
    const definition = authoredTool({
      name: "echo",
      inputSchema: z.object({ text: z.string() }),
      async execute(args) {
        return { kind: "completed", output: args };
      },
    });
    const schemas: unknown[] = [];
    const result = testAgent()
      .tools(definition)
      .with(
        model(async (_call, { request }) => {
          schemas.push(request.tools[0]?.inputSchema.jsonSchema);
          return "done";
        }),
      )
      .build();
    (definition as { inputSchema: unknown }).inputSchema = z.object({ admin: z.string() });
    await turn(result, "go").handle.completed;
    expect(schemas).toMatchObject([{ type: "object", properties: { text: { type: "string" } } }]);
  });

  it("emits step.started before model.requested, and tool.sealed after the model call", async () => {
    const types: string[] = [];
    let step = 0;
    const result = testAgent()
      .tools(tool())
      .with(
        model(async () =>
          ++step === 1 ? toolCalls({ id: "call", name: "echo", args: {} }) : "done",
        ),
      )
      .build();
    const session = result.run();
    session.observe((event) => types.push(event.type));
    const handle = session.input("go");
    await handle.completed;
    expect(types.indexOf("step.started")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("step.started")).toBeLessThan(types.indexOf("model.requested"));
    expect(types.indexOf("model.requested")).toBeLessThan(types.indexOf("tool.sealed"));
    expect(types.filter((type) => type === "step.started").length).toBeGreaterThan(0);
  });

  it("keeps a sibling Session running after a session-scoped tripwire", async () => {
    const agent = testAgent()
      .with(model(async () => "ok"))
      .build();
    const a = turn(agent, "go", {
      onModelCall: async () => {
        throw new Error("stop A");
      },
    });
    const b = turn(agent, "go");
    await expect(a.handle.completed).resolves.toMatchObject({
      events: [
        { type: "input", event: { kind: "user-message", text: "go" } },
        { type: "tripwire", tripwire: { code: "model.failed" } },
      ],
    });
    expect(a.session.state.status).toBe("stopped");
    await expect(b.handle.completed).resolves.toMatchObject({
      events: [
        { type: "input", event: { kind: "user-message", text: "go" } },
        { type: "candidate" },
        { type: "final", output: "ok" },
      ],
    });
    expect(b.session.state.status).toBe("idle");
  });
});
