/**
 * The fixture model's script (R4.3): the scripted markers, and the release demo it keeps.
 */
import { describe, expect, it } from "vitest";
import type { ModelCall } from "@nylorun/core/harness-api";
import { fixtureAnswer } from "../../src/gates/fixture-model.js";

const bash = { name: "bash", inputSchema: { type: "object" } };
const user = (text: string) => ({ kind: "message" as const, role: "user" as const, content: [{ type: "text" as const, text }] });
const call = (prompt: ModelCall["prompt"], tools: ModelCall["tools"] = []): ModelCall => ({
  prompt,
  tools,
  executionId: "e1",
});

describe("fixture model", () => {
  it("answers fixture:text with text, metered with cost 0", async () => {
    const answer = await fixtureAnswer(call([user("fixture:text")]));
    expect(answer).toMatchObject({
      output: [{ type: "text", text: "fixture ok" }],
      finishReason: "stop",
      usage: { costUsd: 0 },
      evidence: { extras: { producer: { provider: "fixture" } } },
    });
  });

  it("calls an offered tool, then quotes its result", async () => {
    const first = await fixtureAnswer(call([user('fixture:tool bash {"command":"echo hi"}')], [bash]));
    expect(first).toMatchObject({
      output: [{ type: "tool-call", name: "bash", args: { command: "echo hi" } }],
      finishReason: "tool-calls",
    });
    const second = await fixtureAnswer(
      call(
        [
          user('fixture:tool bash {"command":"echo hi"}'),
          { kind: "tool-result", toolCallId: "fixture_call", toolName: "bash", status: "completed", content: [{ type: "text", text: "hi" }] },
        ],
        [bash]
      )
    );
    expect(second).toMatchObject({ output: [{ type: "text", text: "fixture tool completed: hi" }] });
  });

  it("says so when the named tool is not offered", async () => {
    expect(await fixtureAnswer(call([user("fixture:tool bash {}")]))).toMatchObject({
      output: [{ type: "text", text: "fixture: no tool bash is offered" }],
    });
  });

  it("calls a tool that is not offered on fixture:unoffered, and never one that is", async () => {
    expect(await fixtureAnswer(call([user('fixture:unoffered nylorun_fixture_unoffered {"x":1}')], [bash]))).toMatchObject({
      output: [{ type: "tool-call", name: "nylorun_fixture_unoffered", args: { x: 1 } }],
      finishReason: "tool-calls",
    });
    expect(await fixtureAnswer(call([user("fixture:unoffered bash {}")], [bash]))).toMatchObject({
      output: [{ type: "text", text: "fixture: tool bash is offered" }],
    });
  });

  it("fails with budget_exhausted on fixture:budget", async () => {
    expect(await fixtureAnswer(call([user("fixture:budget")]))).toMatchObject({
      kind: "failed",
      code: "budget_exhausted",
      retryable: false,
    });
  });

  it("waits on fixture:slow until aborted", async () => {
    const controller = new AbortController();
    const answer = fixtureAnswer(call([user("fixture:slow 20")]), controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(answer).rejects.toThrow("cancelled");
  });

  it("keeps the release demo", async () => {
    const lookup = { name: "lookup_order", inputSchema: { type: "object" } };
    expect(await fixtureAnswer(call([user("Where is my order?")], [lookup]))).toMatchObject({
      output: [{ type: "tool-call", name: "lookup_order", args: { orderId: "demo-123" } }],
    });
    expect(await fixtureAnswer(call([user("hi")]))).toMatchObject({
      output: [{ type: "text", text: "Hello from the fixture model." }],
    });
    expect(await fixtureAnswer(call([user("first"), user("second")]))).toMatchObject({
      output: [{ type: "text", text: "I remember: first" }],
    });
  });
});
