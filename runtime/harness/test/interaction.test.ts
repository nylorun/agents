import { describe, expect, it, vi } from "vitest";
import { testAgent, execution, offer, model, tool, toolCalls, turn } from "./fixtures.js";

describe("interaction resume", () => {
  it("retains the plan and resumes an execution interaction with the same invocation", async () => {
    const invocationIds: string[] = [];
    const order: string[] = [];
    const positions: { turnNumber: number; stepNumber: number }[] = [];
    const execute = vi.fn(async (_call, context) => {
      invocationIds.push(context.invocationId);
      order.push(context.resume ? "execute-resumed" : "execute");
      return context.resume
        ? { kind: "completed" as const, output: "ok" }
        : {
            kind: "interaction-required" as const,
            interaction: { kind: "approval" as const, prompt: "approve" },
            token: "opaque",
          };
    });
    let step = 0;
    const result = testAgent()
      .use("policy", async (request, next) => {
        positions.push({
          turnNumber: request.turnNumber,
          stepNumber: request.stepNumber,
        });
        return next();
      })
      .use("test", offer(tool("echo", execution(execute))))
      .with(
        model(async () =>
          ++step === 1 ? toolCalls({ id: "call", name: "echo", args: {} }) : "done",
        ),
      )
      .build();
    const { session, handle: streamed } = turn(result, "go");
    const first = await streamed.completed;
    expect(first.status).toBe("waiting");
    const required = first.events.find((event) => event.type === "interaction.required");
    if (!required || required.type !== "interaction.required")
      throw new Error("missing interaction");
    const resumed = await session.input({
      kind: "approve",
      interactionId: required.interaction.id,
      approved: true,
    }).completed;
    expect(resumed.events.at(-1)).toMatchObject({ type: "final", output: "done" });
    expect(order).toEqual(["execute", "execute-resumed"]);
    expect(new Set(invocationIds).size).toBe(1);
    expect(positions).toEqual([
      { turnNumber: 1, stepNumber: 1 },
      { turnNumber: 1, stepNumber: 2 },
    ]);
  });

  it("rejects stale correlation without exposing it to the Model", async () => {
    const invoke = vi.fn(async () => "done");
    const result = testAgent().with(model(invoke)).build();
    await expect(
      turn(result, { kind: "approve", interactionId: "stale", approved: true }).handle.completed,
    ).rejects.toMatchObject({ code: "execution.invalid-input" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("pairs every unresolved call when cancelling an interaction wait, then preserves FIFO", async () => {
    const execute = vi.fn(async () => ({ kind: "completed", output: "effect" }));
    let calls = 0;
    const agent = testAgent()
      .use("approval", async (_, next) => {
        const response = await next();
        for (const call of response.toolCalls())
          response.requireInteraction(call.id, { kind: "approval", prompt: "Approve?" });
        return response;
      })
      .use("tools", offer(tool("first", execute), tool("second", execute)))
      .with(
        model(async () =>
          calls++ ? "done" : toolCalls({ id: "a", name: "first" }, { id: "b", name: "second" }),
        ),
      )
      .build();
    const session = agent.run();
    const first = await session.input("go").completed;
    const interaction = first.events.find(
      (event) => event.type === "interaction.required",
    ).interaction;
    const controller = new AbortController();
    controller.abort();
    const cancelled = await session.input(
      { kind: "approve", interactionId: interaction.id, approved: true },
      { signal: controller.signal },
    ).completed;
    expect(cancelled.status).toBe("cancelled");
    expect(execute).not.toHaveBeenCalled();
    expect(
      session.state.transcript.find((entry) => entry.kind === "tool-results").results,
    ).toHaveLength(2);
  });

  it("resumes an interaction after a delay without a harness deadline", async () => {
    let modelStep = 0;
    const local = execution(async () => {
      await new Promise((resolve) => setTimeout(resolve, 35));
      return { kind: "completed", output: "too late" };
    });
    const result = testAgent()
      .use("approval", async (_request, next) => {
        const response = await next();
        response.requireInteraction("call", { kind: "approval", prompt: "approve" });
        return response;
      })
      .use("test", offer(tool("echo", local)))
      .with(
        model(async () =>
          ++modelStep === 1 ? toolCalls({ id: "call", name: "echo", args: {} }) : "done",
        ),
      )
      .build();
    const { session, handle: streamed } = turn(result, "go");
    const first = await streamed.completed;
    const required = first.events.find((event) => event.type === "interaction.required");
    if (!required || required.type !== "interaction.required")
      throw new Error("missing interaction");
    await new Promise((resolve) => setTimeout(resolve, 65));
    const resumed = await session.input({
      kind: "approve",
      interactionId: required.interaction.id,
      approved: true,
    }).completed;
    expect(resumed.status).toBe("completed");
    expect(resumed.events[0]).toMatchObject({
      type: "input",
      event: { kind: "approve", approved: true },
    });
    expect(resumed.events.some((event) => event.type === "candidate")).toBe(true);
    expect(resumed.events.at(-1)).toMatchObject({ type: "final", output: "done" });
  });
});
