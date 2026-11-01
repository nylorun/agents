/**
 * `previewTurn` (`@nylorun/core/engine`, exported by `@nylorun/agents`) against what this harness
 * sends the model (ADR-100): for agent folders of both formats, the system text and the tool list
 * of the first model call of a turn, the root's and a subagent's, are the preview's.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { loopManifestOf, type AgentManifest } from "@nylorun/core/define";
import { compileAgentFolder, folderTextPaths, type AgentFolderEntry } from "@nylorun/core/folder";
import type { AgentManifestV8 } from "@nylorun/core/contracts";
import { previewTurn } from "@nylorun/core/engine";
import {
  HARNESS_API_VERSION,
  RUNTIME_LIMIT_DEFAULTS,
  memoryChannels,
  type McpFacts,
  type TurnStart,
} from "@nylorun/core/harness-api";
import { createHarness, type Harness, type HarnessExecutors } from "../../src/api/index.js";
import { createDurableCheckpoint } from "../../src/run/index.js";

const encoder = new TextEncoder();

function compiled(files: Record<string, string>): AgentManifestV8 {
  const entries: AgentFolderEntry[] = [];
  const bytes = new Map<string, Uint8Array>();
  for (const [path, content] of Object.entries(files)) {
    const data = encoder.encode(content);
    entries.push({
      path,
      size: data.byteLength,
      sha256: createHash("sha256").update(data).digest("hex"),
    });
    bytes.set(path, data);
  }
  const result = compileAgentFolder({
    entries,
    files: new Map(folderTextPaths(entries).map((path) => [path, bytes.get(path)!])),
  });
  if (!result.manifest)
    throw new Error(result.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
  return result.manifest;
}

const SKILL = "---\nname: pdf\ndescription: Fill PDF forms.\n---\nUse fill.py.\n";
const SCOUT = "---\nname: scout\ndescription: Looks things up.\n{engine}---\nLook it up.\n";
const TOOL = JSON.stringify({
  description: "Find an order.",
  inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  http: { url: "https://orders.example.com/find" },
});
const MCP = JSON.stringify({
  mcpServers: { gh: { type: "streamable-http", url: "https://mcp.example.com/gh" } },
});

/** The folders: an agent-folder/1 one, and agent-folder/2 ones with some features declared. */
const FOLDERS: Record<string, Record<string, string>> = {
  "agent-folder/1, with a computer": {
    "AGENT.md":
      "---\nname: helper\ndescription: Helps.\nmemory:\n  instructions: Keep preferences.\nloop:\n  plan: true\n  connections: true\n---\nHelp the person.\n",
    "runtime.json": JSON.stringify({ kind: "virtual", selfWake: true }),
    "mcp.json": MCP,
    "tools/find_order.json": TOOL,
    "skills/pdf/SKILL.md": SKILL,
    "skills/pdf/fill.py": "print(1)\n",
    "agents/scout/AGENT.md": SCOUT.replace("{engine}", ""),
  },
  "agent-folder/1, without a computer": {
    "AGENT.md": "---\nname: helper\ndescription: Helps.\n---\nHelp the person.\n",
    "mcp.json": MCP,
  },
  "agent-folder/2, some features": {
    "AGENT.md":
      "---\nname: helper\ndescription: Helps.\nformat: agent-folder/2\nmemory:\n  index: false\nloop:\n  plan: true\nengine:\n  sandbox: [read, grep]\n  artifacts: { read: true }\n  outputs: true\n  instructions:\n    plan: engine/plan.md\n---\nHelp the person.\n",
    "engine/plan.md": "Keep a plan with update_plan.\n",
    "runtime.json": JSON.stringify({ kind: "virtual" }),
    "mcp.json": MCP,
    "skills/pdf/SKILL.md": SKILL,
    "agents/scout/AGENT.md": SCOUT.replace("{engine}", "engine:\n  sandbox: [read]\n"),
  },
  "agent-folder/2, nothing declared": {
    "AGENT.md":
      "---\nname: helper\ndescription: Helps.\nformat: agent-folder/2\n---\nHelp the person.\n",
    "runtime.json": JSON.stringify({ kind: "pod" }),
    "mcp.json": MCP,
    "agents/scout/AGENT.md": SCOUT.replace("{engine}", ""),
  },
  "agent-folder/2, migrated from the first": {
    "AGENT.md":
      "---\nname: helper\ndescription: Helps.\nformat: agent-folder/2\nmemory:\n  instructions: Keep preferences.\nloop:\n  plan: true\n  connections: true\nengine:\n  sandbox: [bash, read, write, edit, grep, glob]\n  artifacts: { read: true, save: true }\n  outputs: true\n  toolSearch: true\n---\nHelp the person.\n",
    "runtime.json": JSON.stringify({ kind: "virtual", selfWake: true }),
    "mcp.json": MCP,
    "tools/find_order.json": TOOL,
    "skills/pdf/SKILL.md": SKILL,
    "skills/pdf/fill.py": "print(1)\n",
    "agents/scout/AGENT.md": SCOUT.replace(
      "{engine}",
      "engine:\n  sandbox: [bash, read, write, edit, grep, glob]\n  artifacts: { read: true, save: true }\n  outputs: true\n  toolSearch: true\n",
    ),
  },
};

/** The session's MCP tools: two of `gh`'s, one deferred by the server. */
const MCP_FACTS: McpFacts = {
  servers: [
    {
      name: "gh",
      instructions: "Use the GitHub tools for issues.",
      tools: [
        {
          name: "get_issue",
          description: "Get an issue.",
          inputSchema: { type: "object", properties: { n: { type: "integer" } } },
          enabled: true,
        },
        {
          name: "search_code",
          description: "Search code.",
          inputSchema: { type: "object" },
          enabled: true,
          deferred: true,
        },
      ],
    },
    { agentId: "scout", name: "gh", tools: [] },
  ],
} as unknown as McpFacts;

const MODEL = {
  provider: "anthropic",
  id: "claude",
  inputs: ["text", "image"] as ("text" | "image")[],
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
};

/** The turn.start a Runtime sends for a session on an Agent made from `manifest`. */
function turnStart(manifest: AgentManifestV8): TurnStart {
  const loop = loopManifestOf(manifest) as AgentManifest;
  const harness = manifest.harness as {
    memory?: { access?: "read_write" | "read_only"; instructions?: string; index?: boolean };
    loop?: Record<string, unknown>;
  };
  const kind = manifest.runtime?.kind ?? "none";
  return {
    type: "turn.start",
    engine: "agent",
    manifest: loop,
    checkpoint: createDurableCheckpoint({
      manifest: loop,
      sessionId: "s1",
      turnId: "t1",
      input: "go",
    }),
    outcomes: [],
    transcript: { cursor: -1 },
    options: { fixtureModel: false },
    routing: { rootManifest: loop },
    limits: RUNTIME_LIMIT_DEFAULTS,
    model: MODEL,
    mcp: MCP_FACTS,
    agent: {
      id: "ag_1",
      kind,
      ...(kind === "none" ? {} : { sandbox: { workspace: "/workspace" } }),
      ...(manifest.runtime?.selfWake ? { selfWake: true } : {}),
    },
    ...(harness.loop ? { loop: harness.loop } : {}),
    ...(harness.memory
      ? {
          memory: {
            access: harness.memory.access ?? "read_write",
            ...(harness.memory.instructions ? { instructions: harness.memory.instructions } : {}),
            ...(harness.memory.index === false ? {} : { index: "" }),
            truncated: false,
          },
        }
      : {}),
  } as TurnStart;
}

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.stop();
});

/** The first model call of the root and of subagent `scout` in a turn of `start`. */
async function modelCalls(start: TurnStart): Promise<{ root: any; scout?: any }> {
  const channels = memoryChannels({ json: true });
  let settled!: () => void;
  const done = new Promise<void>((resolve) => (settled = resolve));
  let offered = false;
  channels.core.handle(async (method, params: any) => {
    switch (method) {
      case "hello":
        return {
          api: HARNESS_API_VERSION,
          tenantId: "tn_test",
          sandbox: { backend: null },
          renewEveryMs: 1000,
        };
      case "lease":
        if (offered) return new Promise(() => undefined);
        offered = true;
        return { run: { runId: "r1", sessionId: "s1", turnId: "t1", epoch: 1 }, input: start };
      case "effect.intent":
        return { status: "execute" };
      case "effect.outcome":
        return { status: "completed", outcome: { value: params.value } };
      case "lease.renew":
        return { ok: true };
      case "event":
      case "lease.release":
        return {};
      default:
        settled();
        return { cursor: 1 };
    }
  });
  const calls: { root?: any; scout?: any } = {};
  const hasScout = ((start.manifest as AgentManifest).tools ?? []).some(
    (tool) => tool.name === "scout",
  );
  const executors: HarnessExecutors = {
    async model(effect) {
      if (effect.agent?.id === "scout") {
        calls.scout ??= effect.input;
        return { output: [{ type: "text", text: "found" }] };
      }
      const first = calls.root === undefined;
      calls.root ??= effect.input;
      return first && hasScout
        ? {
            output: [
              { type: "tool-call", id: "c1", name: "scout", args: { task: "Look up the order." } },
            ],
          }
        : { output: [{ type: "text", text: "done" }] };
    },
    tool: async () => "tool",
    recovers: { model: false, tool: () => false },
  };
  const harness = createHarness({ channel: channels.harness, executors });
  harnesses.push(harness);
  await harness.start();
  await done;
  return calls as { root: any; scout?: any };
}

/** What a model call holds that a preview shows: the system text and the tools. */
function seen(call: any) {
  const instructions = call.prompt.find((item: any) => item.kind === "instructions");
  return {
    system: instructions ? instructions.content.map((part: any) => part.text).join("") : "",
    tools: call.tools,
    pinned: call.prompt
      .filter((item: any) => item.kind === "context")
      .map((item: any) => item.content[0].text),
  };
}

describe("previewTurn and the harness (ADR-100)", () => {
  it.each(Object.keys(FOLDERS))("show the same turn: %s", async (name) => {
    const manifest = compiled(FOLDERS[name]!);
    const calls = await modelCalls(turnStart(manifest));
    const preview = previewTurn(manifest, { mcpFacts: MCP_FACTS, model: MODEL });
    const root = seen(calls.root);
    expect(root.system).toBe(preview.system);
    expect(root.tools).toEqual(preview.tools);
    expect(root.pinned).toEqual(preview.pinned);
    expect(calls.scout !== undefined).toBe("scout" in preview.agents);
    if (calls.scout) {
      const scout = seen(calls.scout);
      expect(scout.system).toBe(preview.agents.scout!.system);
      expect(scout.tools).toEqual(preview.agents.scout!.tools);
    }
  });

  it("migrating keeps every byte an agent-folder/1 agent's model reads", () => {
    const v1 = previewTurn(compiled(FOLDERS["agent-folder/1, with a computer"]!), {
      mcpFacts: MCP_FACTS,
      model: MODEL,
    });
    const v2 = previewTurn(compiled(FOLDERS["agent-folder/2, migrated from the first"]!), {
      mcpFacts: MCP_FACTS,
      model: MODEL,
    });
    expect(v2.system).toBe(v1.system);
    expect(v2.tools).toEqual(v1.tools);
    expect(v2.agents.scout!.system).toBe(v1.agents.scout!.system);
    expect(v2.agents.scout!.tools).toEqual(v1.agents.scout!.tools);
  });

  it("gives an agent-folder/2 agent only what it declares", () => {
    const preview = previewTurn(compiled(FOLDERS["agent-folder/2, some features"]!), {
      mcpFacts: MCP_FACTS,
      model: MODEL,
    });
    expect(preview.tools.map((tool) => tool.name)).toEqual([
      "scout",
      "read",
      "grep",
      "load_skill",
      "read_artifact",
      "memory",
      "update_plan",
      "gh__get_issue",
      "tool_search",
      "tool_call",
    ]);
    expect(preview.system).toContain("Keep a plan with update_plan.");
    expect(preview.system).not.toContain("save_artifact");
    expect(preview.system).not.toContain("index of the memory files");
    expect(preview.pinned).toEqual([]);
    // Memory, view-only, as an agent-folder/1 subagent has it.
    expect(preview.agents.scout!.tools.map((tool) => tool.name)).toEqual(["read", "memory"]);
    const bare = previewTurn(compiled(FOLDERS["agent-folder/2, nothing declared"]!), {
      mcpFacts: MCP_FACTS,
      model: MODEL,
    });
    expect(bare.tools.map((tool) => tool.name)).toEqual([
      "scout",
      "gh__get_issue",
      "tool_search",
      "tool_call",
    ]);
    expect(bare.system.startsWith("Help the person.\n\nSome tools of these MCP servers")).toBe(
      true,
    );
  });
});
