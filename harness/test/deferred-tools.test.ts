/**
 * R2b C10 in the engine: a deferred session tool stays out of the model's tool list, and
 * `tool_call` runs it as that tool's own call, after checking its arguments and asking for
 * approval when the tool needs it. `tool_search` is a host effect like any tool.
 */
import { describe, expect, it } from "vitest";
import {
  Agent,
  TOOL_CALL_TOOL,
  TOOL_SEARCH_TOOL,
  TOOLS_CAPABILITY_ID,
  deferredToolsTools,
  type AgentManifest,
} from "@nylorun/core/define";
import {
  createDurableCheckpoint,
  runDurable,
  type DurableHost,
  type DurableSessionTool,
  type HostEffect,
} from "../src/run/index.js";

const manifest: AgentManifest = {
  ...Agent({ id: "bot" })
    .mcp({ github: { type: "streamable-http", url: "https://mcp.example.com/github" } })
    .build().manifest,
};
const pinned: AgentManifest = {
  ...manifest,
  capabilities: [...manifest.capabilities, { id: TOOLS_CAPABILITY_ID, type: "agent" }],
};
const issueSchema = {
  type: "object",
  properties: { number: { type: "integer" } },
  required: ["number"],
  additionalProperties: false,
};
const [search, call] = deferredToolsTools();
const NOTE = "Some tools of these MCP servers are not in your tool list.";
const sessionTools: DurableSessionTool[] = [
  { capabilityId: "mcp", name: "github__list_repos", inputSchema: { type: "object" } },
  { capabilityId: TOOLS_CAPABILITY_ID, ...search!, instructions: [NOTE] },
  { capabilityId: TOOLS_CAPABILITY_ID, ...call! },
  {
    capabilityId: "mcp",
    name: "github__get_issue",
    description: "Read an issue.",
    inputSchema: issueSchema,
    deferred: true,
  },
  {
    capabilityId: "mcp",
    name: "github__create_issue",
    description: "Open an issue.",
    inputSchema: { type: "object" },
    approval: "always",
    deferred: true,
  },
];

/** A host whose model makes `calls` in turn, then answers; it keeps what it was asked. */
function host(calls: { name: string; args: unknown }[]) {
  const offered: string[][] = [];
  const prompts: string[] = [];
  const tools: HostEffect[] = [];
  const results: unknown[] = [];
  let step = 0;
  const value: DurableHost = {
    async resolveEffect(effect) {
      if (effect.kind === "model") {
        const input = effect.input as {
          tools: { name: string }[];
          prompt: { kind: string; content?: unknown }[];
        };
        offered.push(input.tools.map((tool) => tool.name));
        prompts.push(JSON.stringify(input.prompt));
        const last = input.prompt.at(-1);
        if (last?.kind === "tool-result") results.push(last);
        const next = calls[step++];
        return {
          status: "completed",
          outcome: {
            value: next
              ? {
                  output: [
                    { type: "tool-call", id: `call-${step}`, name: next.name, args: next.args },
                  ],
                }
              : { output: [{ type: "text", text: "done" }] },
          },
        };
      }
      tools.push(effect);
      return {
        status: "completed",
        outcome: { value: { kind: "completed", output: { title: "bug" } } },
      };
    },
  };
  return { host: value, offered, prompts, tools, results };
}

const run = (h: DurableHost) =>
  runDurable({
    manifest: pinned,
    checkpoint: createDurableCheckpoint({
      manifest: pinned,
      sessionId: "s",
      turnId: "t",
      input: "go",
    }),
    host: h,
    sessionTools,
  });

describe("deferred tools in the engine", () => {
  it("leaves them out of the model's list, which every step repeats, and shows the note", async () => {
    const h = host([{ name: TOOL_SEARCH_TOOL, args: { query: "issue" } }]);
    expect((await run(h.host)).status).toBe("completed");
    expect(h.offered[0]).toEqual(["github__list_repos", TOOL_SEARCH_TOOL, TOOL_CALL_TOOL]);
    expect(h.offered[1]).toEqual(h.offered[0]);
    expect(h.prompts[0]).toContain(NOTE);
    // tool_search is the host's to run, like any tool.
    expect(h.tools).toMatchObject([
      { capabilityId: TOOLS_CAPABILITY_ID, toolName: TOOL_SEARCH_TOOL },
    ]);
  });

  it("runs a deferred tool through tool_call as that tool's own effect", async () => {
    const h = host([
      { name: TOOL_CALL_TOOL, args: { name: "github__get_issue", arguments: { number: 7 } } },
    ]);
    expect((await run(h.host)).status).toBe("completed");
    expect(h.tools).toHaveLength(1);
    expect(h.tools[0]).toMatchObject({
      kind: "tool",
      capabilityId: "mcp",
      toolName: "github__get_issue",
      input: { number: 7 },
      context: { callId: "call-1" },
    });
    expect(JSON.stringify(h.results[0])).toContain("bug");
  });

  it("answers arguments that do not match the tool's inputSchema with a failed result, and runs nothing", async () => {
    const h = host([
      { name: TOOL_CALL_TOOL, args: { name: "github__get_issue", arguments: { number: "seven" } } },
    ]);
    expect((await run(h.host)).status).toBe("completed");
    expect(h.tools).toEqual([]);
    expect(h.results[0]).toMatchObject({ status: "failed" });
    expect(JSON.stringify(h.results[0])).toContain("tool.invalid-arguments");
    expect(JSON.stringify(h.results[0])).toContain("number");
  });

  it("answers a name that is no deferred tool with a failed result", async () => {
    const h = host([{ name: TOOL_CALL_TOOL, args: { name: "github__list_repos", arguments: {} } }]);
    expect((await run(h.host)).status).toBe("completed");
    expect(h.tools).toEqual([]);
    expect(JSON.stringify(h.results[0])).toContain("tool.unknown");
  });

  it("asks for approval of a tool that needs it, as a direct call would, before any effect", async () => {
    const h = host([
      { name: TOOL_CALL_TOOL, args: { name: "github__create_issue", arguments: { title: "x" } } },
    ]);
    const result = await run(h.host);
    expect(result.status).toBe("paused");
    expect(h.tools).toEqual([]);
    expect(JSON.stringify(result)).toContain("Approve github__create_issue?");
  });
});
