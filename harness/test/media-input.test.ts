import { runAgent } from "./run-agent.js";
import { describe, expect, it, vi } from "vitest";
import { HarnessError, type ModelCall, type ObserveEvent } from "@nylorun/core/define";
import { model, testAgent } from "./fixtures.js";

const image = {
  type: "media" as const,
  mediaType: "image/png",
  reference: { url: "https://cdn.example.test/chart.png" },
};

describe("media input", () => {
  it("preserves ordered media content through input, middleware, transcript, and ModelCall", async () => {
    const arrivals: unknown[] = [];
    const calls: ModelCall[] = [];
    const reference = { url: "https://cdn.example.test/chart.png" };
    const session = testAgent()
      .use("inspect", async (request, next) => {
        arrivals.push(request.arrivals);
        return next();
      })
      .with(
        model(async (call) => {
          calls.push(call);
          return "done";
        }),
      )
      .build()
      .run();

    await session.input({
      content: [
        { type: "text", text: "Describe this chart." },
        { type: "media", mediaType: "image/png", reference },
        { type: "text", text: "Use one sentence." },
      ],
    }).completed;
    reference.url = "https://changed.example.test/chart.png";

    const expected = [
      { type: "text", text: "Describe this chart." },
      { type: "media", mediaType: "image/png", reference: { url: image.reference.url } },
      { type: "text", text: "Use one sentence." },
    ];
    expect(arrivals).toEqual([
      [
        {
          kind: "user-message",
          content: expected,
        },
      ],
    ]);
    expect(session.state.transcript[0]).toMatchObject({ event: { content: expected } });
    expect(calls[0]?.prompt).toContainEqual({ kind: "message", role: "user", content: expected });
    expect(Object.isFrozen(calls[0]?.prompt[0]?.content)).toBe(true);
  });

  it("copies media references into serializable execution state", async () => {
    const { Agent } = await import("@nylorun/core/define");
    const reference = { url: "https://cdn.example.test/seed.png" };
    const agent = Agent({ id: "a", name: "A" }).build();
    const result = await runAgent(agent, {
      input: { content: [{ ...image, reference }] },
      onModelCall: async () => "done",
    });
    reference.url = "changed";
    expect(JSON.stringify(result.state)).toContain("https://cdn.example.test/seed.png");
    const resumed = await runAgent(agent, {
      state: JSON.parse(JSON.stringify(result.state)),
      input: "next",
      onModelCall: async (call) => {
        expect(JSON.stringify(call)).toContain("https://cdn.example.test/seed.png");
        return "ok";
      },
    });
    expect(resumed.status).toBe("completed");
  });
  it("rejects malformed media before model invocation", async () => {
    const { Agent } = await import("@nylorun/core/define");
    const invoke = vi.fn(async () => "done");
    await expect(
      runAgent(Agent({ id: "a", name: "A" }).build(), {
        input: { content: [{ type: "media", mediaType: "", reference: {} }] },
        onModelCall: invoke,
      }),
    ).rejects.toMatchObject({ code: "execution.invalid-input" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("leaves media support to the model adapter, whose unsupported-content error ends the turn", async () => {
    const pdf = { type: "media" as const, mediaType: "application/pdf", reference: { url: "x" } };
    const calls: ModelCall[] = [];
    const session = testAgent()
      .with(
        model(async (call) => {
          calls.push(call);
          throw new HarnessError("model.unsupported-content", "PDF input is not supported");
        }),
      )
      .build()
      .run();
    const result = await session.input({ content: [{ type: "text", text: "Inspect." }, pdf] })
      .completed;
    expect(calls[0]?.prompt).toContainEqual({
      kind: "message",
      role: "user",
      content: [{ type: "text", text: "Inspect." }, pdf],
    });
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "tripwire",
        tripwire: expect.objectContaining({ code: "model.unsupported-content" }),
      }),
    );
  });

  it("observes the one derived call an adapter reports, after the canonical call", async () => {
    const events: ObserveEvent[] = [];
    const adapter = model(async (call, context) => {
      context.reportPreparedCall({
        adapter: "test-provider",
        call: { messageCount: call.prompt.length },
      });
      return `prepared ${call.prompt.length}`;
    });
    const session = testAgent().with(adapter).build().run();
    session.observe((event) => events.push(event));

    await session.input("go").completed;
    const requested = events.find((event) => event.type === "model.requested");
    const prepared = events.find((event) => event.type === "model.prepared");
    if (!requested || !prepared || prepared.type !== "model.prepared")
      throw new Error("missing model preparation events");
    expect(events.indexOf(requested)).toBeLessThan(events.indexOf(prepared));
    expect(prepared.attributes).toEqual({ adapter: "test-provider", call: { messageCount: 1 } });
    expect(Object.isFrozen(prepared.attributes.call)).toBe(true);
  });
});
