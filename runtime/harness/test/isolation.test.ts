import { runAgent } from "./run-agent.js";
import { expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";

it("isolates state, info, and execution identities in concurrent calls", async () => {
  const infos: unknown[] = [];
  const agent = Agent<{ name: string }>({ id: "a", name: "A" })
    .use("info", async (request, next) => {
      infos.push(request.info);
      request.context.set("name", [{ value: request.info!.name }]);
      return next();
    })
    .build();
  const results = await Promise.all(
    ["a", "b", "c"].map((name) =>
      runAgent(agent, {
        input: name,
        info: { name },
        onModelCall: async (_, { request }) => {
          await Promise.resolve();
          return String(request.context.items[0]!.value);
        },
      }),
    ),
  );
  expect(results.map((result) => result.status === "completed" && result.output)).toEqual([
    "a",
    "b",
    "c",
  ]);
  expect(new Set(results.map((result) => result.state.executionId)).size).toBe(3);
  expect(infos).toEqual([{ name: "a" }, { name: "b" }, { name: "c" }]);
});
