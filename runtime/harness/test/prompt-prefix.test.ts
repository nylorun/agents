import { registered } from "./fixtures.js";
import { describe, expect, it } from "vitest";
import { type ModelConfigurationSnapshot } from "@nylorun/core/define";
import { testAgent, model, tool, toolCalls, turn } from "./fixtures.js";

describe("model configuration", () => {
  it("assembles named slots fresh for every model step", async () => {
    const snapshots: ModelConfigurationSnapshot[] = [];
    let calls = 0;
    const agent = testAgent()
      .use(
        "baseline",
        registered([[tool("discarded")], [tool()]], (registeredTools) => async (request, next) => {
          if (request.stepNumber === 1) {
            request.configuration.instructions.set("policy", ["Discarded declaration"]);
            request.configuration.instructions.set("policy", ["Step-one policy"], { order: 20 });
            request.configuration.tools.set("tools", registeredTools[0]);
            request.configuration.tools.set("tools", registeredTools[1], { order: 20 });
          }
          return next();
        }),
      )
      .with(
        model(async (_call, { request }) => {
          snapshots.push(request.configuration);
          return ++calls === 1 ? toolCalls({ id: "call", name: "echo", args: {} }) : "done";
        }),
      )
      .build();

    await turn(agent).handle.completed;

    expect(snapshots.map((snapshot) => snapshot.instructions.map((item) => item.text))).toEqual([
      ["Step-one policy"],
      [],
    ]);
    expect(snapshots.map((snapshot) => snapshot.tools.map((tool) => tool.name))).toEqual([
      ["echo"],
      [],
    ]);
  });

  it("orders same-step slots canonically and attributes them", async () => {
    let configuration!: ModelConfigurationSnapshot;
    const agent = testAgent()
      .use(
        "later",
        registered([[tool("late")]], (registeredTools) => async (request, next) => {
          request.configuration.instructions.set("a", ["second"], { order: 20 });
          request.configuration.tools.set("late", registeredTools[0], { order: 20 });
          return next();
        }),
      )
      .use(
        "first",
        registered([[tool("first")]], (registeredTools) => async (request, next) => {
          request.configuration.instructions.set("z", ["first"], { order: 10 });
          request.configuration.tools.set("first", registeredTools[0], { order: 10 });
          return next();
        }),
      )
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
    expect(
      configuration.contributors
        .filter((item) => item.slot !== "fixture-registration")
        .map((item) => `${item.middlewareId}:${item.slot}`),
    ).toEqual(["first:z", "later:a", "first:first", "later:late"]);
  });

  it("rejects unregistered closures before model dispatch", async () => {
    const invoke = async () => {
      throw new Error("must not call model");
    };
    const agent = testAgent()
      .use("tools", async (request, next) => {
        request.configuration.tools.set("echo", [
          tool("echo", async () => ({ kind: "completed", output: request.stepNumber })),
        ]);
        return next();
      })
      .with(model(invoke))
      .build();
    expect((await turn(agent).handle.completed).events).toContainEqual(
      expect.objectContaining({
        type: "tripwire",
        tripwire: expect.objectContaining({ code: "tool.unregistered" }),
      }),
    );
  });
});
