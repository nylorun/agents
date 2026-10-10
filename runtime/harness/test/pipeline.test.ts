import { registered } from "./fixtures.js";
import { describe, expect, it, vi } from "vitest";
import { tool as authoredTool } from "@nylorun/core/define";
import { testAgent, execution, offer, model, tool, toolCalls, turn } from "./fixtures.js";
import { z } from "zod";

describe("step pipeline", () => {
  it("short-circuits with zero Model calls", async () => {
    const invoke = vi.fn(async () => "done");
    const result = testAgent()
      .use("turn-budget", async (request, next) => {
        if (request.turnNumber > 0) {
          return request.tripwire({ code: "turn.limit", message: "Limit reached" });
        }
        return next();
      })
      .with(model(invoke))
      .build();
    const output = (await turn(result, "go").handle.completed).events;
    expect(output).toMatchObject([
      { type: "input", event: { kind: "user-message", text: "go" } },
      { type: "tripwire", tripwire: { code: "turn.limit" } },
    ]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not retain a named tool slot on the next Step", async () => {
    let step = 0;
    const seen: string[][] = [];
    const result = testAgent()
      .use(
        "once",
        registered([[tool()]], (registeredTools) => async (request, next) => {
          if (request.stepNumber === 1) request.configuration.tools.set("once", registeredTools[0]);
          return next();
        }),
      )
      .with(
        model(async (_call, { request }) => {
          seen.push(request.tools.map((item) => item.name));
          return ++step === 1 ? toolCalls({ id: "call", name: "echo", args: {} }) : "done";
        }),
      )
      .build();
    await turn(result, "go").handle.completed;
    expect(seen).toEqual([["echo"], []]);
  });

  it("tripwires duplicate dynamic tools before the Model runs", async () => {
    expect(() =>
      testAgent()
        .use("dup", offer(tool("echo"), tool("echo")))
        .with(model(async () => "done"))
        .build(),
    ).toThrow(/Duplicate registered tool/);
  });

  it("keeps canonical IDs and monotonic denials across replace", async () => {
    const execute = vi.fn(async () => ({ kind: "completed" as const, output: "nope" }));
    let step = 0;
    const result = testAgent()
      .use("outer", async (_request, next) => {
        const response = await next();
        response.replace(toolCalls({ id: "keep", name: "echo", args: { n: 1 } }));
        return response;
      })
      .use(
        "inner",
        registered(
          [[tool("echo", execution(execute))]],
          (registeredTools) => async (request, next) => {
            request.configuration.tools.set("inner", registeredTools[0]);
            const response = await next();
            expect(response.toolCalls().map((call) => call.id)).toEqual(["keep", "drop"]);
            response.deny("keep", "blocked");
            return response;
          },
        ),
      )
      .with(
        model(async () => {
          if (++step > 1) return "done";
          return toolCalls(
            { id: "keep", name: "echo", args: { n: 1 } },
            { id: "drop", name: "echo", args: { n: 2 } },
          );
        }),
      )
      .build();
    const { session, handle } = turn(result, "go");
    await handle.completed;
    const results = session.state.transcript.find((entry) => entry.kind === "tool-results");
    expect(results?.kind).toBe("tool-results");
    if (results?.kind === "tool-results") {
      expect(results.results).toEqual([
        expect.objectContaining({ callId: "keep", kind: "denied", reason: "blocked" }),
      ]);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("tripwires replace that changes a retained call identity", async () => {
    let step = 0;
    const result = testAgent()
      .use(
        "rewrite",
        registered([[tool()]], (registeredTools) => async (request, next) => {
          request.configuration.tools.set("rewrite", registeredTools[0]);
          const response = await next();
          response.replace(toolCalls({ id: "keep", name: "echo", args: { n: 99 } }));
          return response;
        }),
      )
      .with(
        model(async () =>
          ++step === 1 ? toolCalls({ id: "keep", name: "echo", args: { n: 1 } }) : "done",
        ),
      )
      .build();
    const output = (await turn(result, "go").handle.completed).events;
    expect(output).toMatchObject([
      { type: "input", event: { kind: "user-message", text: "go" } },
      { type: "candidate" },
      { type: "tripwire", tripwire: { code: "response.invalid-replacement" } },
    ]);
  });

  it("throws on late lease mutation without stopping a settled Session", async () => {
    const observed: string[] = [];
    let lateError = "";
    const result = testAgent()
      .use(
        "late",
        registered([[tool()]], (registeredTools) => async (request, next) => {
          setTimeout(() => {
            try {
              request.configuration.tools.set("late", registeredTools[0]);
            } catch (error) {
              lateError = error instanceof Error ? error.message : String(error);
            }
          }, 0);
          return next();
        }),
      )
      .with(model(async () => "done"))
      .build();
    const session = result.run();
    session.observe((event) => observed.push(event.type));
    const handle = session.input("go");
    await handle.completed;
    expect(session.state.status).toBe("idle");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(lateError).toMatch(/no longer active/);
    expect(observed).toContain("middleware.lease-violation");
    expect(session.state.status).toBe("idle");
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
      .use(
        "snapshot",
        registered([[definition]], (registeredTools) => async (request, next) => {
          request.configuration.tools.set("snapshot", registeredTools[0]);
          (definition as { inputSchema: unknown }).inputSchema = z.object({ admin: z.string() });
          return next();
        }),
      )
      .with(
        model(async (_call, { request }) => {
          schemas.push(request.tools[0]?.inputSchema.jsonSchema);
          return "done";
        }),
      )
      .build();
    await turn(result, "go").handle.completed;
    expect(schemas).toMatchObject([{ type: "object", properties: { text: { type: "string" } } }]);
  });

  it("emits step.started before middleware and model.requested, and tool.sealed after the onion", async () => {
    const types: string[] = [];
    let step = 0;
    const result = testAgent()
      .use("test", offer(tool()))
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
    expect(types.indexOf("step.started")).toBeLessThan(types.indexOf("middleware.entered"));
    expect(types.indexOf("middleware.entered")).toBeLessThan(types.indexOf("model.requested"));
    expect(types.indexOf("model.requested")).toBeLessThan(types.indexOf("tool.sealed"));
    expect(types.filter((type) => type === "step.started").length).toBeGreaterThan(0);
  });

  it("keeps a sibling Session running after a session-scoped tripwire", async () => {
    const agent = testAgent()
      .use("boom", async (request, next) => {
        if ((request.info as { userId?: string })?.userId === "a") {
          return request.tripwire({
            code: "policy.stop",
            message: "stop A",
            scope: "execution",
          });
        }
        return next();
      })
      .with(model(async () => "ok"))
      .build();
    const a = turn(agent, "go", { userId: "a" });
    const b = turn(agent, "go", { userId: "b" });
    await expect(a.handle.completed).resolves.toMatchObject({
      events: [
        { type: "input", event: { kind: "user-message", text: "go" } },
        { type: "tripwire", tripwire: { code: "policy.stop" } },
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

  it("lets host-level assembly decide whether a folder tool is contributed", async () => {
    const folder = (enabled: boolean) => async (request, next) => {
      if (enabled) request.configuration.tools.set("folder", [tool("folder")]);
      request.configuration.instructions.set("folder", ["from folder"]);
      return next();
    };
    const seen: string[][] = [];
    const builder = testAgent()
      .use("nylorun-folder", folder(false))
      .with(
        model(async (_call, { request }) => {
          seen.push(request.tools.map((item) => item.name));
          return "done";
        }),
      );
    await turn(builder.build(), "go").handle.completed;
    expect(seen).toEqual([[]]);
    expect(builder.build().manifest.capabilities.map((item) => item.id)).toEqual([
      "nylorun-folder",
    ]);
  });
});
