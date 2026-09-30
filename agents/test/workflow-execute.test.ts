import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Agent,
  Loop,
  bindTool,
  tool,
  type BuiltWorkflow,
  type WorkflowBinding,
  type WorkflowManifest,
} from "@nylorun/core/define";
import type { Action } from "@nylorun/core/contracts";
import { executeAction } from "../src/execute-action.js";

const base = {
  actionId: "t:0:flow:open-pr:tool:-",
  sessionId: "s1",
  turnId: "t",
  agentId: "ship",
  manifestHash: "hash",
  implementationVersion: "dev",
  context: {},
  status: "delivering" as const,
  generation: 1,
};

function workflowWithTool(run: (
  input: unknown,
  ctx: { sandbox?: unknown },
) => unknown): BuiltWorkflow {
  // Core still requires object input schemas for tool(); non-object node schemas are a seam.
  const openPr = tool({
    name: "open-pr",
    input: z.object({ summaries: z.array(z.string()) }),
    output: z.object({ url: z.string() }),
    run: async (input, ctx) => run(input, ctx as { sandbox?: unknown }),
  });
  const bound = bindTool(openPr, { middlewareId: "workflow", slot: "tool" });
  const manifest: WorkflowManifest = {
    kind: "workflow",
    workflowSchemaVersion: 1,
    id: "ship",
    root: {
      tool: {
        name: "open-pr",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
      },
    },
  };
  const binding: WorkflowBinding = {
    manifest,
    nodes: { ship: { kind: "tool", tool: bound } },
    agents: {},
  };
  return {
    id: "ship",
    manifest,
    toJSON: () => manifest,
    getBinding: () => binding,
  };
}

describe("executeAction workflow tool nodes (WF-R13 / WF-D8 / WF-C5)", () => {
  it("routes tool actions by key and validates input/output schemas", async () => {
    const workflow = workflowWithTool((input) => ({
      url: `https://example.com/pr?n=${(input as { summaries: string[] }).summaries.length}`,
    }));
    const action: Action = {
      ...base,
      kind: "tool",
      path: "ship",
      key: "ship",
      input: { summaries: ["a", "b"] },
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    };
    const outcome = await executeAction(
      action,
      workflow,
      new AbortController().signal,
    );
    expect(outcome).toEqual({
      value: { kind: "completed", output: { url: "https://example.com/pr?n=2" } },
      statePatch: {},
    });
  });

  it("fails tool.invalid-input when the value fails the input schema", async () => {
    const workflow = workflowWithTool(() => ({ url: "x" }));
    const action: Action = {
      ...base,
      kind: "tool",
      path: "ship",
      key: "ship",
      input: { summaries: "not-an-array" },
    };
    const outcome = await executeAction(
      action,
      workflow,
      new AbortController().signal,
    );
    expect(outcome.value).toMatchObject({
      kind: "failed",
      code: "tool.invalid-input",
    });
  });

  it("dispatches fn and verify by key on the workflow binding", async () => {
    const writer = Agent({ id: "writer", instructions: "Write." }).build();
    const workflow = Loop({
      id: "polish",
      run: writer,
      verify: () => ({ pass: true as const }),
      decide: () => ({ output: "done" }),
    });
    const verify = await executeAction(
      {
        ...base,
        actionId: "t:0:flow:polish:verify:-",
        agentId: "polish",
        kind: "verify",
        path: "polish",
        key: "polish",
        input: { input: "x", output: "y", iteration: 1 },
      },
      workflow,
      new AbortController().signal,
    );
    expect(verify.value).toEqual({ pass: true });

    const decide = await executeAction(
      {
        ...base,
        actionId: "t:0:flow:polish:fn:-",
        agentId: "polish",
        kind: "fn",
        path: "polish",
        key: "polish/decide",
        input: {
          output: "y",
          verdict: { pass: true },
          iteration: 1,
          input: "x",
          history: [],
        },
      },
      workflow,
      new AbortController().signal,
    );
    expect(decide.value).toEqual({ output: "done" });
  });
});
