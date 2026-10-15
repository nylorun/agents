/**
 * R2b C10 in our engine (protocol 15): from the turn's MCP facts, our engine defers an agent's
 * MCP tools by the manifest's setting or by the model's window, keeps them out of the model's
 * list with a note on their servers, finds them with `tool_search` (BM25, run by our harness)
 * and runs one with `tool_call` as that tool's own call, by its identity.
 */
import { describe, expect, it } from "vitest";
import { Agent, type AgentManifest } from "@nylorun/core/define";
import type { McpFacts, ModelDescriptor } from "@nylorun/core/harness-api";
import {
  createDurableCheckpoint,
  runDurable,
  type DurableHost,
  type HostEffect,
} from "../src/run/index.js";
import { DEFAULT_MCP_TOOL_CONFIG, mcpToolSet } from "../src/tools/mcp.js";
import {
  TOOL_CALL_TOOL,
  TOOL_SEARCH_TOOL,
  deferredToolsNote,
  rank,
  runToolSearch,
} from "../src/tools/tool-search.js";

const pinned: AgentManifest = Agent({ id: "bot" })
  .mcp({ github: { type: "streamable-http", url: "https://mcp.example.com/github" } })
  .build().manifest;
const issueSchema = {
  type: "object",
  properties: { number: { type: "integer" } },
  required: ["number"],
  additionalProperties: false,
};
/** github's facts: `list_repos` listed, `get_issue` and `create_issue` deferred by setting. */
const facts: McpFacts = {
  servers: [
    {
      name: "github",
      instructions: "Use labels.",
      tools: [
        { name: "list_repos", inputSchema: { type: "object" }, enabled: true, deferred: false },
        {
          name: "get_issue",
          description: "Read an issue.",
          inputSchema: issueSchema,
          enabled: true,
          deferred: true,
        },
        {
          name: "create_issue",
          description: "Open an issue.",
          inputSchema: { type: "object" },
          enabled: true,
          deferred: true,
        },
      ],
    },
  ],
};
const config = DEFAULT_MCP_TOOL_CONFIG;

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
    mcp: mcpToolSet(facts, pinned, { config }),
  });

describe("deferred tools in our engine", () => {
  it("leaves them out of the model's list, which every step repeats, and shows the note", async () => {
    const h = host([{ name: TOOL_SEARCH_TOOL, args: { query: "issue" } }]);
    expect((await run(h.host)).status).toBe("completed");
    expect(h.offered[0]).toEqual(["github__list_repos", TOOL_SEARCH_TOOL, TOOL_CALL_TOOL]);
    expect(h.offered[1]).toEqual(h.offered[0]);
    expect(h.prompts[0]).toContain("Some tools of these MCP servers are not in your tool list.");
    expect(h.prompts[0]).toContain("- github: 2 tools. The server says: Use labels.");
    // tool_search is our harness's own tool, run like any host effect.
    expect(h.tools).toMatchObject([{ toolName: TOOL_SEARCH_TOOL, target: { kind: "harness" } }]);
  });

  it("runs a deferred tool through tool_call as that tool's own effect, by its identity", async () => {
    const h = host([
      { name: TOOL_CALL_TOOL, args: { name: "github__get_issue", arguments: { number: 7 } } },
    ]);
    expect((await run(h.host)).status).toBe("completed");
    expect(h.tools).toHaveLength(1);
    expect(h.tools[0]).toMatchObject({
      kind: "tool",
      toolName: "github__get_issue",
      target: { kind: "mcp", server: "github", tool: "get_issue" },
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
  });

  it("answers a name that is no deferred tool with a failed result", async () => {
    const h = host([{ name: TOOL_CALL_TOOL, args: { name: "github__list_repos", arguments: {} } }]);
    expect((await run(h.host)).status).toBe("completed");
    expect(h.tools).toEqual([]);
    expect(JSON.stringify(h.results[0])).toContain("tool.unknown");
  });

  it("never asks for approval itself: the Tool Gate holds a call its policy asks about (R5 step 2)", async () => {
    const h = host([
      { name: TOOL_CALL_TOOL, args: { name: "github__create_issue", arguments: { title: "x" } } },
    ]);
    const result = await run(h.host);
    expect(result.status).not.toBe("paused");
  });
});

describe("deciding deferral (Q21)", () => {
  const manifest = Agent({ id: "a" })
    .mcp({ s: { type: "streamable-http", url: "https://s.example.invalid/mcp" } })
    .build().manifest;
  const many = (count: number, size: number, deferred?: boolean): McpFacts => ({
    servers: [
      {
        name: "s",
        tools: Array.from({ length: count }, (_, i) => ({
          name: `t${i}`,
          description: "d".repeat(size),
          inputSchema: { type: "object" },
          enabled: true,
          ...(deferred === undefined ? {} : { deferred }),
        })),
      },
    ],
  });
  const model = (contextWindow: number): ModelDescriptor => ({
    provider: "p",
    id: "m",
    inputs: ["text"],
    contextWindow,
    maxOutputTokens: 1024,
  });
  const deferred = (facts: McpFacts, window?: number) =>
    mcpToolSet(facts, manifest, {
      config,
      ...(window === undefined ? {} : { model: model(window) }),
    }).tools.filter((tool) => tool.deferred).length;

  it("defers past a tenth of the model's window, at 4 characters a token", () => {
    // 10 tools of about 1,050 characters: 10,500, against 10% of 4 × 25,000 = 10,000.
    expect(deferred(many(10, 1_000), 25_000)).toBe(10);
    expect(deferred(many(10, 1_000), 30_000)).toBe(0);
  });

  it("follows the harness's configuration, and its fallback window without a model", () => {
    const facts = many(10, 1_000);
    expect(deferred(facts)).toBe(0);
    const small = mcpToolSet(facts, manifest, {
      config: { ...config, fallbackContextWindow: 1_024 },
    });
    expect(small.tools.filter((tool) => tool.deferred)).toHaveLength(10);
    const share = mcpToolSet(facts, manifest, {
      config: { ...config, deferShare: 0.5 },
      model: model(25_000),
    });
    expect(share.tools.filter((tool) => tool.deferred)).toHaveLength(0);
  });

  it("follows the manifest's setting whatever the window", () => {
    expect(deferred(many(2, 0, true), 1_000_000)).toBe(2);
    expect(deferred(many(10, 1_000, false), 1_024)).toBe(0);
  });

  it("gives an agent with deferred tools tool_search and tool_call, and its search finds only its own", () => {
    const set = mcpToolSet(many(10, 1_000), manifest, { config, model: model(1_024) });
    expect(set.tools.filter((tool) => !tool.deferred).map((tool) => tool.name)).toEqual([
      TOOL_SEARCH_TOOL,
      TOOL_CALL_TOOL,
    ]);
    expect(set.deferredOf(undefined)).toHaveLength(10);
    expect(set.deferredOf("other")).toEqual([]);
  });
});

describe("the deferred tools' note", () => {
  it("names each server and its count, its instructions cut to the harness's limit", () => {
    const note = deferredToolsNote(
      [
        { serverName: "ledger", tools: 20, instructions: "x".repeat(50) },
        { serverName: "one", tools: 1 },
      ],
      { serverInstructionsMaxChars: 10 },
    );
    expect(note).toContain(`- ledger: 20 tools. The server says: ${"x".repeat(10)}…`);
    expect(note).toContain("- one: 1 tool");
    expect(note).not.toContain("x".repeat(11));
  });
});

describe("tool_search", () => {
  const tool = (name: string, server: string, raw: string, description: string) => ({
    name,
    description,
    inputSchema: { type: "object" },
    deferred: true,
    target: { kind: "mcp" as const, server, tool: raw },
  });
  const tools = [
    tool("s__t0", "s", "pulls.create", "Create a pull request."),
    tool("s__t1", "s", "issues.list", "List open issues by label."),
    tool("s__t2", "s", "issues.close", "Close an issue."),
  ];

  it("ranks by BM25: a description word finds the tool; no shared word finds nothing", () => {
    expect(rank(tools, "label issues").map((item) => item.name)).toEqual(["s__t1", "s__t2"]);
    expect(rank(tools, "deploy")).toEqual([]);
  });

  it("matches the server's own name for a tool", () => {
    expect(rank(tools, "pulls").map((item) => item.name)).toEqual(["s__t0"]);
  });

  it("answers the matches with their schemas, at most its limit, and asks for a query", () => {
    const limits = { toolSearchDefaultLimit: 1, toolSearchMaxLimit: 2 };
    expect(runToolSearch({ input: { query: "issue" } }, tools, limits)).toEqual({
      kind: "completed",
      output: {
        tools: [{ name: "s__t2", description: "Close an issue.", inputSchema: { type: "object" } }],
      },
    });
    const all = runToolSearch({ input: { query: "issue", limit: 20 } }, tools, limits) as {
      output: { tools: unknown[] };
    };
    expect(all.output.tools).toHaveLength(2);
    expect(runToolSearch({ input: { query: " " } }, tools, limits)).toMatchObject({
      kind: "failed",
      code: "tools.invalid_input",
    });
    expect(runToolSearch({ input: { query: "deploy" } }, tools, limits)).toMatchObject({
      kind: "completed",
      output: { tools: [], message: expect.stringContaining("3 tools are searchable") },
    });
  });
});
