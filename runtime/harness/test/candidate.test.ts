import { registered } from "./fixtures.js";
import { describe, expect, it } from "vitest";
import { testAgent, offer, model, tool, toolCalls, turn } from "./fixtures.js";

describe("model candidate blocks", () => {
  it("joins interleaved text blocks and ignores reasoning on session final", async () => {
    let step = 0;
    const result = testAgent()
      .use("test", offer(tool()))
      .with(
        model(async () => {
          if (++step > 1) return "done";
          return {
            output: [
              { type: "text", text: "Hello" },
              { type: "reasoning", text: "should not appear" },
              {
                type: "tool-call",
                id: "call",
                name: "echo",
                args: {},
              },
              { type: "text", text: " world" },
            ],
            finishReason: "tool-calls" as const,
            usage: { inputTokens: 3, outputTokens: 2, costUsd: 0.01 },
            evidence: { requestId: "req-1", resolvedModel: "test", extras: { route: "local" } },
          };
        }),
      )
      .build();
    const { session, handle } = turn(result, "go");
    const completion = await handle.completed;
    expect(completion.events.at(-1)).toMatchObject({ type: "final", output: "done" });
    const minted = session.state.transcript.find((entry) => entry.kind === "candidate");
    expect(minted?.kind).toBe("candidate");
    if (minted?.kind === "candidate") {
      expect(minted.candidate.output).toEqual([
        { type: "text", text: "Hello" },
        { type: "reasoning", text: "should not appear" },
        { type: "tool-call", id: "call", name: "echo", args: {} },
        { type: "text", text: " world" },
      ]);
      expect(minted.candidate.finishReason).toBe("tool-calls");
      expect(minted.candidate.usage).toEqual({
        inputTokens: 3,
        outputTokens: 2,
        costUsd: 0.01,
      });
      expect(minted.candidate.evidence).toEqual({
        requestId: "req-1",
        resolvedModel: "test",
        extras: { route: "local" },
      });
    }
  });

  it("returns an empty string for empty output and text-only output as joined text", async () => {
    const empty = testAgent()
      .with(model(async () => ({ output: [] })))
      .build();
    expect((await turn(empty, "go").handle.completed).events).toMatchObject([
      { type: "input", event: { kind: "user-message", text: "go" } },
      { type: "candidate" },
      { type: "final", output: "" },
    ]);

    const textOnly = testAgent()
      .with(
        model(async () => ({
          output: [
            { type: "text", text: "Hello" },
            { type: "reasoning", text: "hidden" },
            { type: "text", text: " world" },
          ],
        })),
      )
      .build();
    const { session, handle } = turn(textOnly, "go");
    expect((await handle.completed).events).toMatchObject([
      { type: "input", event: { kind: "user-message", text: "go" } },
      { type: "candidate" },
      { type: "final", output: "Hello world" },
    ]);
    const minted = session.state.transcript.find((entry) => entry.kind === "candidate");
    expect(minted?.kind).toBe("candidate");
    if (minted?.kind === "candidate") {
      expect(minted.candidate.output.some((block) => block.type === "reasoning")).toBe(true);
    }
  });

  it("rejects non-object tool args and invalid finish reasons at normalize", async () => {
    const nonObject = testAgent()
      .with(
        model(
          async () =>
            ({
              output: [{ type: "tool-call", id: "call", name: "echo", args: "nope" }],
            }) as never,
        ),
      )
      .build();
    expect((await turn(nonObject, "go").handle.completed).events).toMatchObject([
      { type: "input", event: { kind: "user-message", text: "go" } },
      { type: "tripwire", tripwire: { code: "model.invalid-candidate" } },
    ]);

    const aborted = testAgent()
      .with(model(async () => ({ output: [], finishReason: "aborted" }) as never))
      .build();
    expect((await turn(aborted, "go").handle.completed).events).toMatchObject([
      { type: "input", event: { kind: "user-message", text: "go" } },
      { type: "tripwire", tripwire: { code: "model.invalid-candidate" } },
    ]);

    const errored = testAgent()
      .with(model(async () => ({ output: [], finishReason: "error" }) as never))
      .build();
    expect((await turn(errored, "go").handle.completed).events).toMatchObject([
      { type: "input", event: { kind: "user-message", text: "go" } },
      { type: "tripwire", tripwire: { code: "model.invalid-candidate" } },
    ]);
  });

  it("rejects negative token counts and treats a thrown invoke as model.failed", async () => {
    const tokens = testAgent()
      .with(
        model(async () => ({
          output: [{ type: "text", text: "x" }],
          usage: { inputTokens: -1 },
        })),
      )
      .build();
    expect((await turn(tokens, "go").handle.completed).events).toMatchObject([
      { type: "input", event: { kind: "user-message", text: "go" } },
      { type: "tripwire", tripwire: { code: "model.invalid-candidate" } },
    ]);

    const thrown = testAgent()
      .with(
        model(async () => {
          throw new Error("upstream down");
        }),
      )
      .build();
    expect((await turn(thrown, "go").handle.completed).events).toMatchObject([
      { type: "input", event: { kind: "user-message", text: "go" } },
      { type: "tripwire", tripwire: { code: "model.failed" } },
    ]);
  });

  it("preserves usage, evidence, and finishReason when replace only changes output", async () => {
    let step = 0;
    const result = testAgent()
      .use(
        "review",
        registered([[tool()]], (registeredTools) => async (request, next) => {
          request.configuration.tools.set("review", registeredTools[0]);
          const response = await next();
          response.replace(toolCalls({ id: "keep", name: "echo", args: { n: 1 } }));
          return response;
        }),
      )
      .with(
        model(async () => {
          if (++step > 1) return "done";
          return {
            output: [
              { type: "text", text: "keep " },
              { type: "tool-call", id: "keep", name: "echo", args: { n: 1 } },
              { type: "tool-call", id: "drop", name: "echo", args: { n: 2 } },
            ],
            finishReason: "tool-calls" as const,
            usage: { inputTokens: 1, outputTokens: 4 },
            evidence: { requestId: "abc", warnings: ["slow"] },
          };
        }),
      )
      .build();
    const { session, handle } = turn(result, "go");
    await handle.completed;
    const minted = session.state.transcript.find((entry) => entry.kind === "candidate");
    expect(minted?.kind).toBe("candidate");
    if (minted?.kind === "candidate") {
      expect(minted.candidate.output).toEqual([
        { type: "tool-call", id: "keep", name: "echo", args: { n: 1 } },
      ]);
      expect(minted.candidate.finishReason).toBe("tool-calls");
      expect(minted.candidate.usage).toEqual({ inputTokens: 1, outputTokens: 4 });
      expect(minted.candidate.evidence).toEqual({ requestId: "abc", warnings: ["slow"] });
    }
  });

  it("accepts empty-object tool args and still schema-validates them", async () => {
    let call = 0;
    const result = testAgent()
      .use(
        "typed",
        registered([[tool()]], (registeredTools) => async (request, next) => {
          request.configuration.tools.set("typed", registeredTools[0]);
          return next();
        }),
      )
      .with(
        model(async () =>
          ++call === 1 ? toolCalls({ id: "echo", name: "echo", args: {} }) : "done",
        ),
      )
      .build();
    const { session, handle } = turn(result, "go");
    await handle.completed;
    const results = session.state.transcript.find((entry) => entry.kind === "tool-results");
    expect(results?.kind).toBe("tool-results");
    if (results?.kind === "tool-results") {
      expect(results.results).toEqual([
        expect.objectContaining({ callId: "echo", kind: "completed", output: {} }),
      ]);
    }
  });
});
