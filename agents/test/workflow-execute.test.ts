import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
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
    workflowSchemaVersion: 3,
    id: "ship",
    root: {
      tool: {
        name: "open-pr",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
      },
    },
    agents: {},
  };
  const binding: WorkflowBinding = {
    manifest,
    nodes: { "open-pr": { kind: "tool", tool: bound } },
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
      path: "open-pr",
      key: "open-pr",
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
      path: "open-pr",
      key: "open-pr",
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

  it("refuses an Action that is not a tool node", async () => {
    await expect(
      executeAction(
        { ...base, kind: "fn", path: "open-pr:input", key: "open-pr:input", input: {} } as never,
        workflowWithTool(() => ({ url: "x" })),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/Unsupported action kind fn on workflow/);
  });
});
