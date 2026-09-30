import { expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import type { Action } from "@nylorun/core/contracts";
import { executeAction } from "../src/execute-action.js";

const hookAction = (capabilityIds: string[]): Action => ({
  actionId: "turn:0:hook:before-step:step_1",
  sessionId: "s1",
  turnId: "turn",
  agentId: "hooked",
  manifestHash: "hash",
  implementationVersion: "dev",
  kind: "hook",
  hook: { at: "before", scope: "step", capabilityIds },
  input: { step: 0, state: {}, messages: [] },
  context: {},
  status: "delivering",
  generation: 1,
});

it("runs every capability's hook in one action and isolates failures", async () => {
  const seen: unknown[] = [];
  const agent = Agent({ id: "hooked" })
    .use({
      id: "one",
      before: {
        step: (args) => {
          seen.push(args.step);
          return { instructions: ["from one"] };
        },
      },
    })
    .use({
      id: "two",
      before: {
        step: () => {
          throw new Error("two failed");
        },
      },
    })
    .build();
  const outcome = await executeAction(
    hookAction(["one", "two"]),
    agent,
    new AbortController().signal
  );
  expect(outcome.value).toEqual({
    results: {
      one: { instructions: ["from one"] },
      two: { block: "two failed" },
    },
  });
  expect(seen).toEqual([0]);
});

it("blocks instead of throwing when a hook implementation is missing", async () => {
  const agent = Agent({ id: "hooked" }).build();
  const outcome = await executeAction(
    hookAction(["ghost"]),
    agent,
    new AbortController().signal
  );
  expect(outcome.value).toEqual({
    results: {
      ghost: { block: `Missing before("step") implementation for capability 'ghost'` },
    },
  });
});
