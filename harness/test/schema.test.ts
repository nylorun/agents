import { registered } from "./fixtures.js";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { tool } from "@nylorun/core/define";
import { defineSchema, normalizedSchemasFor } from "@nylorun/core/define";
import { testAgent, model, toolCalls, turn } from "./fixtures.js";

describe("Zod schemas", () => {
  it("executes a tool with Zod's parsed object output", async () => {
    let call = 0;
    let executed: unknown;
    const convert = tool({
      name: "convert",
      inputSchema: z.object({ count: z.coerce.number() }),
      async execute(args) {
        executed = args;
        return { kind: "completed", output: args };
      },
    });
    const result = testAgent()
      .use(
        "parsed",
        registered([[convert]], (registeredTools) => async (request, next) => {
          request.configuration.tools.set("parsed", registeredTools[0]);
          return next();
        }),
      )
      .with(
        model(async () => {
          call += 1;
          return call === 1
            ? toolCalls({ id: "convert", name: "convert", args: { count: "2" } })
            : "done";
        }),
      )
      .build();

    await turn(result, "go").handle.completed;
    expect(executed).toEqual({ count: 2 });
  });

  it("binds a Zod object onto the offered Model request", async () => {
    const inputSchema = z.object({ text: z.string() });
    const echo = tool({
      name: "echo",
      inputSchema,
      outputSchema: z.object({ echoed: z.string() }),
      async execute(args) {
        return { kind: "completed", output: { echoed: args.text } };
      },
    });
    const result = testAgent()
      .use(
        "zod",
        registered([[echo]], (registeredTools) => async (request, next) => {
          request.configuration.tools.set("zod", registeredTools[0]);
          return next();
        }),
      )
      .with(
        model(async (_call, { request }) => {
          expect(request.tools[0]?.inputSchema.jsonSchema).toMatchObject({
            type: "object",
            properties: { text: { type: "string" } },
          });
          expect(request.configuration.toolContracts[0]?.outputSchema).toMatchObject({
            type: "object",
            properties: { echoed: { type: "string" } },
          });
          return "done";
        }),
      )
      .build();

    const session = result.run();
    const observed: import("../src/index.js").ObserveEvent[] = [];
    session.observe((event) => observed.push(event));
    await session.input("go").completed;
    const requested = observed.find((event) => event.type === "model.requested");
    expect(requested).toMatchObject({
      attributes: {
        configuration: {
          tools: [
            {
              inputSchema: { jsonSchema: { type: "object" } },
              outputSchema: { jsonSchema: { type: "object" } },
            },
          ],
          toolContracts: [
            {
              inputSchema: { type: "object" },
              outputSchema: { type: "object" },
            },
          ],
        },
      },
    });
  });

  it("prepares authored and raw schemas once across repeated step declarations", async () => {
    const prepared = tool({
      name: "prepared",
      inputSchema: z.object({ value: z.string() }),
      async execute(args) {
        return { kind: "completed", output: args };
      },
    });
    const raw = {
      name: "raw",
      inputSchema: z.object({ value: z.string() }),
      async execute(args: { value: string }) {
        return { kind: "completed" as const, output: args };
      },
    };
    let calls = 0;
    const result = testAgent()
      .use(
        "tools",
        registered([[prepared, raw]], (registeredTools) => async (request, next) => {
          request.configuration.tools.set("tools", registeredTools[0]);
          return next();
        }),
      )
      .with(
        model(async () => {
          calls += 1;
          return calls === 1
            ? toolCalls({ id: "prepared", name: "prepared", args: { value: "x" } })
            : "done";
        }),
      )
      .build();

    await turn(result, "go").handle.completed;
    expect(normalizedSchemasFor(prepared)).toBe(normalizedSchemasFor(prepared));
    expect(normalizedSchemasFor(raw)).toBe(normalizedSchemasFor(raw));
  });

  it("rejects invalid authored schemas when tool() defines them", () => {
    expect(() =>
      tool({
        name: "bad",
        inputSchema: z.string() as never,
        async execute() {
          return { kind: "completed", output: null };
        },
      }),
    ).toThrow(/inputSchema JSON Schema root type must be object/);
  });

  it("tripwires an invalid raw tool literal when it is first bound", async () => {
    const invoke = vi.fn(async () => "done");
    expect(() =>
      testAgent()
        .use(
          "bad",
          registered(
            [
              [
                {
                  name: "bad",
                  inputSchema: z.string() as never,
                  async execute() {
                    return { kind: "completed" as const, output: null };
                  },
                },
              ],
            ],
            (registeredTools) => async (request, next) => {
              request.configuration.tools.set("bad", registeredTools[0]);
              return next();
            },
          ),
        )
        .with(model(invoke))
        .build(),
    ).toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("tripwires declared asynchronous Zod checks before the Model runs", async () => {
    const invoke = vi.fn(async () => "done");
    const inputSchema = z.object({ text: z.string() }).refine(async () => true);
    expect(() =>
      testAgent()
        .use(
          "async",
          registered(
            [
              [
                tool({
                  name: "async",
                  inputSchema,
                  async execute(args) {
                    return { kind: "completed", output: args };
                  },
                }),
              ],
            ],
            (registeredTools) => async (request, next) => {
              request.configuration.tools.set("async", registeredTools[0]);
              return next();
            },
          ),
        )
        .with(model(invoke))
        .build(),
    ).toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("tripwires a Zod object that cannot convert to JSON Schema before the Model runs", async () => {
    const invoke = vi.fn(async () => "done");
    expect(() =>
      testAgent()
        .use(
          "unconvertible",
          registered(
            [
              [
                tool({
                  name: "bigint",
                  inputSchema: z.object({ value: z.bigint() }),
                  async execute() {
                    return { kind: "completed", output: null };
                  },
                }),
              ],
            ],
            (registeredTools) => async (request, next) => {
              request.configuration.tools.set("unconvertible", registeredTools[0]);
              return next();
            },
          ),
        )
        .with(model(invoke))
        .build(),
    ).toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("seals invalid Zod arguments as tool.invalid-arguments", async () => {
    let call = 0;
    const result = testAgent()
      .use(
        "typed",
        registered(
          [
            [
              tool({
                name: "echo",
                inputSchema: z.object({ text: z.string() }),
                async execute(args) {
                  return { kind: "completed", output: args };
                },
              }),
            ],
          ],
          (registeredTools) => async (request, next) => {
            request.configuration.tools.set("typed", registeredTools[0]);
            return next();
          },
        ),
      )
      .with(
        model(async () => {
          call += 1;
          return call === 1 ? toolCalls({ id: "echo", name: "echo", args: { text: 1 } }) : "done";
        }),
      )
      .build();

    const { session, handle } = turn(result, "go");
    await handle.completed;
    const entry = session.state.transcript.find((item) => item.kind === "tool-results");
    expect(entry?.kind).toBe("tool-results");
    if (entry?.kind === "tool-results") {
      expect(entry.results).toEqual([
        expect.objectContaining({
          callId: "echo",
          kind: "failed",
          code: "tool.invalid-arguments",
          details: {
            phase: "input",
            issues: [expect.objectContaining({ path: ["text"] })],
          },
        }),
      ]);
    }
  });

  it("accepts synchronous Standard Schema contracts", async () => {
    let executed: unknown;
    const standard = {
      "~standard": {
        validate(value: unknown) {
          if (
            !value ||
            typeof value !== "object" ||
            typeof (value as { id?: unknown }).id !== "string"
          )
            return { issues: [{ path: ["id"], code: "invalid_type", message: "Expected string" }] };
          return { value: { id: (value as { id: string }).id.trim() } };
        },
        jsonSchema: {
          input: () => ({
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          }),
          output: () => ({
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          }),
        },
      },
    };
    const result = testAgent()
      .use(
        "standard",
        registered(
          [
            [
              tool({
                name: "standard",
                inputSchema: standard,
                async execute(args) {
                  executed = args;
                  return { kind: "completed", output: args };
                },
              }),
            ],
          ],
          (registeredTools) => async (request, next) => {
            request.configuration.tools.set("standard", registeredTools[0]);
            return next();
          },
        ),
      )
      .with(
        model(async () =>
          executed === undefined
            ? toolCalls({ id: "call", name: "standard", args: { id: " 42 " } })
            : "done",
        ),
      )
      .build();

    await turn(result).handle.completed;
    expect(executed).toEqual({ id: "42" });
  });

  it("accepts explicit raw JSON Schema contracts with a local validator", async () => {
    const inputSchema = defineSchema({
      jsonSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      validate(value) {
        if (
          !value ||
          typeof value !== "object" ||
          typeof (value as { id?: unknown }).id !== "string"
        )
          return {
            ok: false as const,
            issues: [{ path: ["id"], code: "invalid_type", message: "Expected string" }],
          };
        return { ok: true as const, value: { id: (value as { id: string }).id } };
      },
    });
    expect(inputSchema.jsonSchema).toEqual({
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    });
    expect(inputSchema.validate({ id: "42" })).toEqual({ ok: true, value: { id: "42" } });
  });

  it("validates, transforms, records, and projects the one completed output", async () => {
    let call = 0;
    const result = testAgent()
      .use(
        "output",
        registered(
          [
            [
              tool({
                name: "output",
                inputSchema: z.object({}),
                outputSchema: z.object({ count: z.coerce.number() }),
                async execute() {
                  return { kind: "completed", output: { count: "2" } as never };
                },
              }),
            ],
          ],
          (registeredTools) => async (request, next) => {
            request.configuration.tools.set("output", registeredTools[0]);
            return next();
          },
        ),
      )
      .with(
        model(async (_call, { request }) => {
          call += 1;
          if (call === 1) return toolCalls({ id: "output", name: "output", args: {} });
          const results = request.transcript.find((entry) => entry.kind === "tool-results");
          expect(results).toMatchObject({ results: [{ kind: "completed", output: { count: 2 } }] });
          return "done";
        }),
      )
      .build();

    const { session, handle } = turn(result);
    await handle.completed;
    const entry = session.state.transcript.find((item) => item.kind === "tool-results");
    expect(entry).toMatchObject({ results: [{ kind: "completed", output: { count: 2 } }] });
  });

  it("turns invalid output into a model-visible failed result", async () => {
    let call = 0;
    const result = testAgent()
      .use(
        "output",
        registered(
          [
            [
              tool({
                name: "output",
                inputSchema: z.object({}),
                outputSchema: z.object({ count: z.number() }),
                async execute() {
                  return { kind: "completed", output: { count: "bad" } as never };
                },
              }),
            ],
          ],
          (registeredTools) => async (request, next) => {
            request.configuration.tools.set("output", registeredTools[0]);
            return next();
          },
        ),
      )
      .with(
        model(async (_call, { request }) => {
          call += 1;
          if (call === 1) return toolCalls({ id: "output", name: "output", args: {} });
          expect(request.transcript).toContainEqual(
            expect.objectContaining({
              kind: "tool-results",
              results: [
                expect.objectContaining({
                  code: "tool.invalid-output",
                  details: { phase: "output" },
                }),
              ],
            }),
          );
          return "done";
        }),
      )
      .build();

    await turn(result).handle.completed;
  });

  it("does not check a host's preview of a result too large to show, and keeps its files (R2b C11)", async () => {
    let call = 0;
    const preview = { truncated: true, artifactId: "af_1", size: 200_000, preview: "…" };
    const files = [{ mediaType: "image/png", reference: { artifactId: "af_2", version: 1 } }];
    const result = testAgent()
      .use(
        "output",
        registered(
          [
            [
              tool({
                name: "output",
                inputSchema: z.object({}),
                outputSchema: z.object({ count: z.number() }),
                async execute() {
                  return { kind: "completed", output: preview as never, truncated: true, files };
                },
              }),
            ],
          ],
          (registeredTools) => async (request, next) => {
            request.configuration.tools.set("output", registeredTools[0]);
            return next();
          },
        ),
      )
      .with(
        model(async () => {
          call += 1;
          if (call === 1) return toolCalls({ id: "output", name: "output", args: {} });
          return "done";
        }),
      )
      .build();

    const { session, handle } = turn(result);
    await handle.completed;
    const entry = session.state.transcript.find((item) => item.kind === "tool-results");
    expect(entry).toMatchObject({ results: [{ kind: "completed", output: preview, files }] });
  });
});
