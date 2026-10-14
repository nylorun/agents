import { describe, expect, it } from "vitest";
import { type ModelConfigurationSnapshot } from "@nylorun/core/define";
import { testAgent, model, tool, toolCalls, turn } from "./fixtures.js";

describe("model configuration", () => {
  it("offers each part's instructions and tools on every model step", async () => {
    const snapshots: ModelConfigurationSnapshot[] = [];
    let calls = 0;
    const agent = testAgent()
      .instructions("Policy")
      .tools(tool())
      .with(
        model(async (_call, { request }) => {
          snapshots.push(request.configuration);
          return ++calls === 1 ? toolCalls({ id: "call", name: "echo", args: {} }) : "done";
        }),
      )
      .build();

    await turn(agent).handle.completed;

    expect(snapshots.map((snapshot) => snapshot.instructions.map((item) => item.text))).toEqual([
      ["Policy"],
      ["Policy"],
    ]);
    expect(snapshots.map((snapshot) => snapshot.tools.map((tool) => tool.name))).toEqual([
      ["echo"],
      ["echo"],
    ]);
  });

  it("orders parts as they were added and attributes them", async () => {
    let configuration!: ModelConfigurationSnapshot;
    const agent = testAgent()
      .part({ id: "first", instructions: ["first"], tools: [tool("first")] })
      .part({ id: "later", instructions: ["second"], tools: [tool("late")] })
      .with(
        model(async (_call, { request }) => {
          configuration = request.configuration;
          return "done";
        }),
      )
      .build();
    await turn(agent).handle.completed;

    expect(configuration.instructions.map((item) => item.text)).toEqual(["first", "second"]);
    expect(configuration.tools.map((item) => item.name)).toEqual(["first", "late"]);
    expect(configuration.contributors.map((item) => `${item.partId}:${item.slot}`)).toEqual([
      "first:first",
      "later:later",
      "first:first",
      "later:later",
    ]);
  });
});
