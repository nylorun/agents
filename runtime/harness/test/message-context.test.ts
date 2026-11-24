import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ModelCall, TranscriptEntry } from "@nylorun/core/define";
import { messageContextOf } from "../src/loop/step/step-context.js";
import { model, testAgent, toolCalls } from "./fixtures.js";

const bot = { type: "bot", value: "[bot] Nylo, chief of staff" };
const time = { type: "time", value: "Fri 20 Nov, 10:00" };

/** The runtime-context block of a call's prompt, when it has one. */
function contextBlock(call: ModelCall): string | undefined {
  const text = JSON.stringify(call.prompt);
  const start = text.indexOf("<runtime-context>");
  return start < 0 ? undefined : text.slice(start, text.indexOf("</runtime-context>") + 18);
}

describe("message context", () => {
  it("reaches every model call of its turn, after the history, and none of the next turn's", async () => {
    const calls: ModelCall[] = [];
    let step = 0;
    const session = testAgent()
      .tools({ name: "job", inputSchema: z.object({}), execute: async () => "ok" })
      .with(
        model(async (call) => {
          calls.push(call);
          return step++ === 0 ? toolCalls({ id: "c1", name: "job" }) : "done";
        }),
      )
      .build()
      .run();

    await session.input({ text: "plan my day", metadata: { context: [bot, time] } }).completed;
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(contextBlock(call)).toContain("[bot] Nylo, chief of staff");
      expect(contextBlock(call)).toContain("Fri 20 Nov, 10:00");
      // After the history: the block is the prompt's last item.
      expect(JSON.stringify(call.prompt.at(-1))).toContain("<runtime-context>");
    }
    // The person's words are the message, as typed.
    expect(calls[0]!.prompt).toContainEqual(
      expect.objectContaining({
        kind: "message",
        role: "user",
        content: [{ type: "text", text: "plan my day" }],
      }),
    );

    await session.input("and tomorrow?").completed;
    expect(calls).toHaveLength(3);
    expect(contextBlock(calls[2]!)).toBeUndefined();
  });

  it("takes the turn's latest input that carries context, a steered message's over the first's", () => {
    const transcript: TranscriptEntry[] = [
      {
        kind: "input",
        turnId: "t0",
        event: { kind: "user-message", text: "old", metadata: { context: [time] } },
      },
      {
        kind: "input",
        turnId: "t1",
        event: { kind: "user-message", text: "hi", metadata: { context: [bot] } },
      },
    ];
    expect(messageContextOf({ turnId: "t1", transcript, arrivals: [] })?.items).toEqual([bot]);
    expect(
      messageContextOf({
        turnId: "t1",
        transcript,
        arrivals: [{ kind: "user-message", text: "also", metadata: { context: [time] } }],
      })?.items,
    ).toEqual([time]);
    // An arrival without context leaves the turn's own.
    expect(
      messageContextOf({
        turnId: "t1",
        transcript,
        arrivals: [{ kind: "user-message", text: "also" }],
      })?.items,
    ).toEqual([bot]);
    // Another turn's context is not this one's.
    expect(messageContextOf({ turnId: "t2", transcript, arrivals: [] })).toBeUndefined();
    expect(
      messageContextOf({ turnId: "t1", transcript, arrivals: [] })?.contributors[0]?.partId,
    ).toBe("message-context");
  });
});
