import { describe, expect, it } from "vitest";
import { type ContextSnapshot } from "@nylorun/core/define";
import { testAgent, model, tool, toolCalls, turn } from "./fixtures.js";

describe("runtime context", () => {
  it("keeps application info out of model context", async () => {
    const snapshots: ContextSnapshot[] = [];
    let calls = 0;
    const agent = testAgent()
      .tools(tool())
      .with(
        model(async (_call, { request }) => {
          snapshots.push(request.context);
          return ++calls === 1 ? toolCalls({ id: "call", name: "echo", args: {} }) : "done";
        }),
      )
      .build();
    await turn(agent, "go", { context: { user: "ada" } }).handle.completed;
    expect(snapshots.map((snapshot) => snapshot.items)).toEqual([[], []]);
  });

  it("offers the same configuration on every step", async () => {
    const configurations: string[][] = [];
    let calls = 0;
    const agent = testAgent()
      .instructions("Stable policy")
      .tools(tool())
      .with(
        model(async (_call, { request }) => {
          configurations.push(request.configuration.instructions.map((item) => item.text));
          return ++calls === 1 ? toolCalls({ id: "call", name: "echo", args: {} }) : "done";
        }),
      )
      .build();

    await turn(agent).handle.completed;
    expect(configurations).toEqual([["Stable policy"], ["Stable policy"]]);
  });
});
