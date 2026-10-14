import { runAgent } from "./run-agent.js";
import { expect, it } from "vitest";
import { z } from "zod";
import { Agent } from "@nylorun/core/define";

it("isolates state, info, and execution identities in concurrent calls", async () => {
  const infos: unknown[] = [];
  const agent = Agent<{ name: string }>({ id: "a", name: "A" })
    .tools({
      name: "who",
      inputSchema: z.object({}),
      execute: async (_args, { info }) => {
        infos.push(info);
        return { kind: "completed" as const, output: info!.name };
      },
    })
    .build();
  const results = await Promise.all(
    ["a", "b", "c"].map((name) =>
      runAgent(agent, {
        input: name,
        info: { name },
        onModelCall: async (_, { request }) => {
          await Promise.resolve();
          const result = request.toolResults[0];
          if (!result) return { output: [{ type: "tool-call", id: "who", name: "who", args: {} }] };
          return result.kind === "completed" ? String(result.output) : "failed";
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
