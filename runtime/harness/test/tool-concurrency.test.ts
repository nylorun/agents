import { describe, expect, it, vi } from "vitest";
import { testAgent, model, offer, tool, toolCalls, turn } from "./fixtures.js";

describe("central tool concurrency", () => {
  it("starts sibling calls concurrently and commits their results in model order", async () => {
    const releases = new Map<string, () => void>();
    const started: string[] = [];
    const execute = async (args: { id?: string }) => {
      const id = String(args.id);
      started.push(id);
      await new Promise<void>((resolve) => releases.set(id, resolve));
      return { kind: "completed" as const, output: id };
    };
    let step = 0;
    const agent = testAgent()
      .use("tools", offer(tool("echo", execute as never)))
      .with(
        model(async () =>
          ++step === 1
            ? toolCalls(
                { id: "first", name: "echo", args: { id: "first" } },
                { id: "second", name: "echo", args: { id: "second" } },
              )
            : "done",
        ),
      )
      .build();

    const running = turn(agent, "go");
    await vi.waitFor(() => expect(started).toEqual(["first", "second"]));
    releases.get("second")!();
    releases.get("first")!();
    await running.handle.completed;

    const entry = running.session.state.transcript.find((item) => item.kind === "tool-results");
    expect(entry?.kind === "tool-results" ? entry.results.map((item) => item.callId) : []).toEqual([
      "first",
      "second",
    ]);
  });
});
