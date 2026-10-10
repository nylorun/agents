import { describe, expect, it, vi } from "vitest";
import { testAgent, execution, offer, model, tool, toolCalls, turn } from "./fixtures.js";

describe("sealing", () => {
  it("turns invalid calls into paired failures and dispatches only sealed calls", async () => {
    const execute = vi.fn(async (call) => ({ kind: "completed" as const, output: call.args }));
    let calls = 0;
    const result = testAgent()
      .use("test", offer(tool("echo", execution(execute))))
      .with(
        model(async (_call, { request }) => {
          calls += 1;
          return calls === 1
            ? toolCalls(
                { id: "unknown", name: "missing", args: {} },
                { id: "valid", name: "echo", args: { value: 1 } },
              )
            : `results:${request.toolResults.map((item) => item.kind).join(",")}`;
        }),
      )
      .build();
    const output = (await turn(result, "go").handle.completed).events;
    expect(output).toMatchObject([
      { type: "input", event: { kind: "user-message", text: "go" } },
      { type: "candidate" },
      { type: "candidate" },
      { type: "final", output: "results:failed,completed" },
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(execute.mock.calls[0]![0].args)).toBe(true);
  });

  it("canonicalizes malformed call ids and deeply copies candidate and Tool result data", async () => {
    const candidateArgs = { value: 1 };
    const implementationOutput = { nested: { value: 1 } };
    let step = 0;
    const result = testAgent()
      .use(
        "test",
        offer(
          tool(
            "echo",
            execution(async () => ({ kind: "completed", output: implementationOutput })),
          ),
        ),
      )
      .with(
        model(async (_call, { request }) => {
          if (++step > 1) return "done";
          return toolCalls(
            { id: "", name: "echo", args: candidateArgs },
            { id: "duplicate", name: "echo", args: candidateArgs },
            { id: "duplicate", name: "echo", args: candidateArgs },
            { id: "valid", name: "echo", args: candidateArgs },
          );
        }),
      )
      .build();
    const { session, handle } = turn(result, "go");
    await handle.completed;

    candidateArgs.value = 9;
    implementationOutput.nested.value = 9;
    const candidate = session.state.transcript.find((entry) => entry.kind === "candidate");
    const results = session.state.transcript.find((entry) => entry.kind === "tool-results");
    if (!candidate || candidate.kind !== "candidate" || !results || results.kind !== "tool-results")
      throw new Error("missing transcript entries");
    const candidateIds = candidate.candidate.output
      .filter((block) => block.type === "tool-call")
      .map((block) => block.id);
    expect(new Set(candidateIds).size).toBe(4);
    expect(results.results.map((item) => item.callId)).toEqual(candidateIds);
    expect(results.results.map((item) => item.code)).toEqual([
      "tool.invalid-call-id",
      "tool.duplicate-call-id",
      "tool.duplicate-call-id",
      undefined,
    ]);
    const validCall = candidate.candidate.output.find(
      (block) => block.type === "tool-call" && block.id === "valid",
    );
    expect(validCall && validCall.type === "tool-call" ? validCall.args : undefined).toEqual({
      value: 1,
    });
    expect(results.results[3]?.output).toEqual({ nested: { value: 1 } });
    expect(Object.isFrozen((results.results[3]?.output as { nested: object }).nested)).toBe(true);
  });

  it("normalizes malformed JavaScript model and tool outcome scalar fields into failures", async () => {
    const malformedModel = testAgent()
      .with(model(async () => ({ output: "invalid" }) as never))
      .build();
    const modelCompletion = await turn(malformedModel, "go").handle.completed;
    expect(modelCompletion.events).toMatchObject([
      { type: "input", event: { kind: "user-message", text: "go" } },
      { type: "tripwire", tripwire: { code: "model.invalid-candidate" } },
    ]);

    let step = 0;
    const malformedAdapter = testAgent()
      .use(
        "test",
        offer(
          tool(
            "echo",
            execution(async () => ({ kind: "denied", reason: { mutable: true } }) as never),
          ),
        ),
      )
      .with(
        model(async () =>
          ++step === 1 ? toolCalls({ id: "call", name: "echo", args: {} }) : "done",
        ),
      )
      .build();
    const { session, handle } = turn(malformedAdapter, "go");
    await handle.completed;
    const results = session.state.transcript.find((entry) => entry.kind === "tool-results");
    expect(results?.kind).toBe("tool-results");
    if (results?.kind === "tool-results")
      expect(results.results).toEqual([
        expect.objectContaining({
          kind: "failed",
          code: "tool.invalid-tool-result",
          message: "Tool denial reason must be a string",
        }),
      ]);
  });
});
