/**
 * R2b C9 and C10 end to end over the Runtime API. Per-tool settings on an MCP server (manifest
 * v6): an allowlist through `"*": {enabled: false}`, approval per tool, a diagnostic for a key
 * that names no tool, and turn variants that may only tighten them. Deferred tools: an agent
 * whose MCP tools pass a tenth of the model's context window gets `tool_search` and `tool_call`
 * in their place, decided once for the session, and `tool_call` runs a tool as a direct call
 * would (arguments checked, approval asked, the tool named). v5 manifests are accepted unchanged.
 * With `NYLORUN_TEST_MODEL_GATE=http` the gates service makes every call; otherwise the Tenant
 * does, in process.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Agent, createClient, type AgentsClient } from "@nylorun/agents";
import { hashManifest, type AgentManifest, type ModelCall } from "@nylorun/core/define";
import type { ModelProvider } from "../src/core/provider.js";
import { contextWindowOf, hostModelCatalog } from "../src/model/catalog.js";
import { pinDeferral, sessionToolsOf, type McpSnapshot } from "../src/mcp/snapshot.js";
import { rank } from "../src/tenant/tool-search.js";
import { startTestTenant } from "./support/tenant.js";

const APP = "tool-settings-app-key-aaaaaaaaaaaaa";
/** About 280 characters of a tool's description that no query of these tests matches. */
const FILLER =
  "Returns the records of the account named in the request, a page at a time, sorted by date, with totals for the page and a cursor for the next page while more remain. Fails when the account is closed or unknown to the service.";

interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly input?: z.ZodRawShape;
}

/** A remote MCP server with `tools`, keeping the names of the tools called. */
async function mcpServer(name: string, tools: readonly ToolSpec[], instructions?: string) {
  const called: string[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") return void res.writeHead(405).end();
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const mcp = new McpServer({ name, version: "0.0.0" }, instructions ? { instructions } : undefined);
    for (const tool of tools)
      mcp.registerTool(tool.name, { description: tool.description, inputSchema: tool.input ?? {} }, async () => {
        called.push(tool.name);
        return { content: [{ type: "text", text: `${tool.name} ok` }] };
      });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    res.on("close", () => {
      void transport.close().catch(() => {});
      void mcp.close().catch(() => {});
    });
    await transport.handleRequest(req, res, JSON.parse(Buffer.concat(chunks).toString()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, called };
}

/** Twenty tools of a large server, each about 330 characters of JSON. */
const many = (prefix: string, extra: ToolSpec[] = []): ToolSpec[] => [
  ...extra,
  ...Array.from({ length: 20 - extra.length }, (_, i) => ({
    name: `${prefix}_t${String(i).padStart(2, "0")}`,
    description: `Tool ${i} of ${prefix}. ${FILLER}`,
  })),
];

const servers: Server[] = [];

/** A tool result the model saw: its status and its JSON. */
interface Seen {
  readonly status: string;
  readonly payload: any;
}
type Call = { name: string; args: Record<string, unknown> };
/** What the model does next, given the result it just saw (none on its first step). */
let brain: (seen: Seen | undefined) => Call | undefined = () => undefined;
/** The tool names of each model call, and its prompt as JSON. */
let offered: string[][] = [];
let prompts: string[] = [];
let calls = 0;
const model: ModelProvider = async (effect: { input: unknown }) => {
  const input = effect.input as ModelCall;
  offered.push(input.tools.map((tool) => tool.name));
  prompts.push(JSON.stringify(input.prompt));
  const last = input.prompt.at(-1);
  const seen =
    last?.kind === "tool-result"
      ? {
          status: last.status,
          payload: JSON.parse((last.content.find((part) => part.type === "text") as { text: string }).text),
        }
      : undefined;
  const next = brain(seen);
  if (!next) return { output: [{ type: "text", text: "done" }] };
  calls += 1;
  return { output: [{ type: "tool-call", id: `call-${calls}`, name: next.name, args: next.args }] };
};

/** The model makes `script`'s calls in turn, keeping each result it sees, then answers. */
function script(...steps: Call[]): Seen[] {
  const seen: Seen[] = [];
  let step = 0;
  brain = (result) => {
    if (result) seen.push(result);
    return steps[step++];
  };
  return seen;
}

type Runtime = Awaited<ReturnType<typeof startTestTenant>>;
let runtime: Runtime;
let client: AgentsClient;
let github: Awaited<ReturnType<typeof mcpServer>>;
let ledger: Awaited<ReturnType<typeof mcpServer>>;
let funds: Awaited<ReturnType<typeof mcpServer>>;

async function put(manifest: unknown) {
  const id = (manifest as { id: string }).id;
  const response = await fetch(`${runtime.url}/v1/agents/${id}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${APP}`, "content-type": "application/json" },
    body: JSON.stringify({ requestId: `put-${id}`, manifest, implementationVersion: "dev" }),
  });
  expect(response.status).toBeLessThan(300);
}

let sessions = 0;
type Session = ReturnType<AgentsClient["session"]>;
/** Opens a session of `agentId` and starts a turn; `offered` and `prompts` start empty. */
async function open(agentId: string): Promise<Session> {
  sessions += 1;
  offered = [];
  prompts = [];
  const session = await client.createSession({ id: `settings-${sessions}`, agentId, ownerUserId: "u:ada" });
  await session.input("go", { idempotencyKey: `m${sessions}` });
  return session;
}

async function settled(session: Session) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const view = await session.inspect();
    if (["idle", "completed", "failed", "uncertain", "cancelled"].includes(view.status)) return view;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timeout waiting for the turn to settle");
}

async function paused(session: Session) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const waits = await session.pending();
    if (Array.isArray(waits) && waits.length > 0) return waits[0] as { interaction: { id: string; prompt: string } };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timeout waiting for the approval");
}

async function events(session: Session, type: string) {
  const history = await session.history();
  return history.items.filter((item) => item.type === type).map((item) => item.payload as Record<string, any>);
}

const toolsOf = (names: readonly string[], server: string) => names.filter((name) => name.startsWith(`${server}__`));

beforeAll(async () => {
  github = await mcpServer("github", [
    { name: "search_issues", description: "Search issues.", input: { q: z.string() } },
    { name: "create_issue", description: "Open an issue.", input: { title: z.string() } },
    { name: "delete_repo", description: "Delete a repository." },
    { name: "get_me", description: "The signed-in user." },
  ]);
  ledger = await mcpServer(
    "ledger",
    many("ledger", [
      { name: "reconcile", description: `Run the month's reconciliation of two ledgers. ${FILLER}` },
      { name: "post", description: `Post an entry. ${FILLER}`, input: { amount: z.number(), memo: z.string() } },
    ]),
    "Ledger tools act on the books of the signed-in company; amounts are in cents.",
  );
  funds = await mcpServer("funds", many("funds", [{ name: "transfer", description: `Move money. ${FILLER}` }]));
  const archive = await mcpServer("archive", many("archive"));
  const small = await mcpServer(
    "small",
    ["alpha", "beta", "gamma", "delta", "epsilon"].map((name) => ({ name, description: `The ${name} tool.` })),
  );

  runtime = await startTestTenant({ applicationKey: APP, modelProvider: model });
  client = createClient({ url: runtime.url, key: runtime.applicationKey, tenant: runtime.tenantId });
  await put(
    Agent({ id: "allow" })
      .mcp({
        github: {
          type: "streamable-http",
          url: github.url,
          tools: {
            "*": { enabled: false },
            search_issues: { enabled: true },
            create_issue: { enabled: true, approval: "always" },
            not_a_tool: { enabled: true },
          },
        },
      })
      .build().manifest,
  );
  await put(
    Agent({ id: "big" })
      .mcp({
        ledger: { type: "streamable-http", url: ledger.url },
        funds: { type: "streamable-http", url: funds.url, tools: { transfer: { approval: "always" } } },
        // One tool stays in the list whatever the size (Q21: settings override).
        archive: { type: "streamable-http", url: archive.url, tools: { archive_t00: { deferred: false } } },
      })
      .build().manifest,
  );
  await put(Agent({ id: "small" }).mcp({ small: { type: "streamable-http", url: small.url } }).build().manifest);
  await put(
    Agent({ id: "picked" })
      .mcp({ small: { type: "streamable-http", url: small.url, tools: { epsilon: { deferred: true } } } })
      .build().manifest,
  );
}, 60_000);

afterAll(async () => {
  await runtime?.close();
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
});

describe("per-tool settings (C9)", () => {
  it("makes an allowlist with '*': {enabled: false}, and names a key no tool has", async () => {
    script({ name: "github__search_issues", args: { q: "bug" } });
    const session = await open("allow");
    expect((await settled(session)).status).toBe("completed");
    expect(toolsOf(offered[0]!, "github")).toEqual(["github__search_issues", "github__create_issue"]);
    expect(github.called).toEqual(["search_issues"]);
    const [discovered] = await events(session, "mcp.discovered");
    expect(discovered!.servers).toEqual([
      expect.objectContaining({
        serverName: "github",
        outcome: "connected",
        tools: 2,
        disabled: 2,
        unknownTools: ["not_a_tool"],
        message: expect.stringContaining("not_a_tool"),
      }),
    ]);
  });

  it("never calls a disabled tool the model names", async () => {
    const before = github.called.length;
    const seen = script({ name: "github__delete_repo", args: {} });
    const session = await open("allow");
    expect((await settled(session)).status).toBe("completed");
    expect(seen[0]!.status).toBe("failed");
    expect(github.called.length).toBe(before);
  });

  it("asks for approval of one tool, not the others", async () => {
    script({ name: "github__create_issue", args: { title: "x" } });
    const session = await open("allow");
    const wait = await paused(session);
    expect(wait.interaction.prompt).toBe("Approve github__create_issue?");
    expect(github.called).not.toContain("create_issue");
    await session.approve(wait.interaction.id, true, { idempotencyKey: "approve-create" });
    expect((await settled(session)).status).toBe("completed");
    expect(github.called).toContain("create_issue");
  });

  it("lets a turn variant disable a tool and require another's approval", async () => {
    script();
    const session = await open("allow");
    await settled(session);
    const pinned = (await session.manifest()).manifest as unknown as AgentManifest;
    const variant: AgentManifest = {
      ...pinned,
      manifestSchemaVersion: 6,
      capabilities: pinned.capabilities.map((capability) =>
        capability.mcpServers?.github
          ? {
              ...capability,
              mcpServers: {
                github: {
                  ...capability.mcpServers.github,
                  tools: {
                    ...capability.mcpServers.github.tools,
                    search_issues: { enabled: true, approval: "always" },
                    create_issue: { enabled: false, approval: "always" },
                  },
                },
              },
            }
          : capability
      ),
    };
    offered = [];
    script({ name: "github__search_issues", args: { q: "flaky" } });
    await session.command({ type: "message", requestId: "variant-1", idempotencyKey: "variant-1", content: "again", manifest: variant });
    const wait = await paused(session);
    expect(wait.interaction.prompt).toBe("Approve github__search_issues?");
    expect(toolsOf(offered[0]!, "github")).toEqual(["github__search_issues"]);
    await session.approve(wait.interaction.id, false, { idempotencyKey: "deny-search" });
    await settled(session);

    // Widening is refused: enabling a tool the pin's allowlist leaves out.
    const widened: AgentManifest = {
      ...pinned,
      manifestSchemaVersion: 6,
      capabilities: pinned.capabilities.map((capability) =>
        capability.mcpServers?.github
          ? {
              ...capability,
              mcpServers: {
                github: {
                  ...capability.mcpServers.github,
                  tools: { ...capability.mcpServers.github.tools, delete_repo: { enabled: true } },
                },
              },
            }
          : capability
      ),
    };
    await expect(
      session.command({ type: "message", requestId: "variant-2", idempotencyKey: "variant-2", content: "wider", manifest: widened })
    ).rejects.toThrow(/not a variant/);
  });
});

describe("deferred tools (C10)", () => {
  it("defers 60 tools across 3 servers, keeps one a setting lists, and gives the model tool_search and tool_call", async () => {
    script();
    const session = await open("big");
    expect((await settled(session)).status).toBe("completed");
    const names = offered[0]!;
    expect(names).toEqual(expect.arrayContaining(["tool_search", "tool_call", "archive__archive_t00"]));
    expect(names.filter((name) => /^(ledger|funds|archive)__/.test(name))).toEqual(["archive__archive_t00"]);
    // The note names each server, its deferred tools and its own instructions.
    expect(prompts[0]).toContain("ledger: 20 tools");
    expect(prompts[0]).toContain("amounts are in cents");
    expect(prompts[0]).toContain("archive: 19 tools");
    const [discovered] = await events(session, "mcp.discovered");
    expect(discovered!.servers.map((server: any) => [server.serverName, server.tools, server.deferred])).toEqual([
      ["ledger", 20, 20],
      ["funds", 20, 20],
      ["archive", 20, 19],
    ]);
  });

  it("defers none of 5 tools", async () => {
    script();
    const session = await open("small");
    expect((await settled(session)).status).toBe("completed");
    expect(toolsOf(offered[0]!, "small")).toHaveLength(5);
    expect(offered[0]).not.toContain("tool_search");
    expect((await events(session, "mcp.discovered"))[0]!.servers[0]).not.toHaveProperty("deferred");
  });

  it("defers the one tool a setting defers, even among 5", async () => {
    script();
    const session = await open("picked");
    await settled(session);
    expect(toolsOf(offered[0]!, "small")).toEqual(["small__alpha", "small__beta", "small__gamma", "small__delta"]);
    expect(offered[0]).toEqual(expect.arrayContaining(["tool_search", "tool_call"]));
  });

  it("finds a tool by a word in its description, runs it with tool_call, and lists the same tools at every step", async () => {
    const seen = script(
      { name: "tool_search", args: { query: "reconciliation" } },
      { name: "tool_call", args: { name: "ledger__reconcile", arguments: {} } },
    );
    const session = await open("big");
    expect((await settled(session)).status).toBe("completed");
    expect(seen[0]!.payload.tools[0]).toEqual({
      name: "ledger__reconcile",
      description: expect.stringContaining("reconciliation"),
      inputSchema: expect.objectContaining({ type: "object" }),
    });
    expect(seen[1]).toEqual({ status: "completed", payload: "reconcile ok" });
    expect(ledger.called).toContain("reconcile");
    // The effect and tool.completed name the tool, not tool_call.
    const completed = await events(session, "tool.completed");
    expect(completed.map((item) => item.toolName)).toEqual(["tool_search", "ledger__reconcile"]);
    expect(offered).toHaveLength(3);
    for (const names of offered) expect(names).toEqual(offered[0]);
  });

  it("answers tool_call with arguments that do not match the tool's inputSchema with a failed result", async () => {
    const before = ledger.called.length;
    const seen = script({ name: "tool_call", args: { name: "ledger__post", arguments: { amount: "ten" } } });
    const session = await open("big");
    expect((await settled(session)).status).toBe("completed");
    expect(seen[0]!.status).toBe("failed");
    expect(JSON.stringify(seen[0]!.payload)).toMatch(/tool\.invalid-arguments|amount/);
    expect(ledger.called.length).toBe(before);
  });

  it("asks for approval of a tool that needs it through tool_call, then runs it", async () => {
    script({ name: "tool_call", args: { name: "funds__transfer", arguments: {} } });
    const session = await open("big");
    const wait = await paused(session);
    expect(wait.interaction.prompt).toBe("Approve funds__transfer?");
    expect(funds.called).toEqual([]);
    await session.approve(wait.interaction.id, true, { idempotencyKey: "approve-transfer" });
    expect((await settled(session)).status).toBe("completed");
    expect(funds.called).toEqual(["transfer"]);
    expect((await events(session, "tool.completed")).map((item) => item.toolName)).toEqual(["funds__transfer"]);
  });
});

it("accepts a v5 manifest unchanged", async () => {
  const json = {
    manifestSchemaVersion: 5,
    id: "legacy",
    capabilities: [
      { id: "mcp", type: "agent", mcpServers: { small: { name: "small", type: "streamable-http", url: github.url } } },
    ],
  };
  await put(json);
  const listed = (await client.listAgents()).agents.find((agent) => agent.agentId === "legacy")!;
  expect(listed.manifestHash).toBe(hashManifest(json as AgentManifest));
});

describe("deciding deferral (Q21)", () => {
  const manifest = Agent({ id: "a" })
    .mcp({ s: { type: "streamable-http", url: "https://s.example.invalid/mcp" } })
    .build().manifest;
  const pinnedManifest: AgentManifest = {
    ...manifest,
    capabilities: [...manifest.capabilities, { id: "nylorun.tools", type: "agent" }],
  };
  const snapshot = (count: number, size: number): McpSnapshot => ({
    snapshotSchemaVersion: 1,
    manifestHash: "h",
    mcpTools: Array.from({ length: count }, (_, i) => ({
      capabilityId: "mcp",
      serverName: "s",
      serverToolName: `t${i}`,
      name: `s__t${i}`,
      description: "d".repeat(size),
      inputSchema: { type: "object" },
    })),
  });

  it("defers past a tenth of the window, at 4 characters a token", () => {
    // 10 tools of about 1,050 characters: 10,500, against 10% of 4 × 25,000 = 10,000.
    const deferred = (window: number) =>
      pinDeferral(snapshot(10, 1_000), pinnedManifest, window).mcpTools.filter((tool) => tool.deferred).length;
    expect(deferred(25_000)).toBe(10);
    expect(deferred(30_000)).toBe(0);
  });

  it("defers nothing for an agent without the nylorun.tools capability", () => {
    const pinned = pinDeferral(snapshot(10, 1_000), manifest, 1_024);
    expect(pinned.mcpTools.some((tool) => tool.deferred)).toBe(false);
    expect(sessionToolsOf(pinned, manifest)!.map((tool) => tool.name)).toHaveLength(10);
  });

  it("knows a catalog model's window, and assumes a small one otherwise", () => {
    const provider = hostModelCatalog().providers.find((item) => item.models.length > 0)!;
    const window = contextWindowOf({ configured: true, provider: provider.id, model: provider.models[0]!.id });
    expect(window).toBeGreaterThan(1_024);
    expect(contextWindowOf({ configured: false })).toBe(32_768);
    expect(contextWindowOf({ configured: true, provider: "custom", model: "m", baseUrl: "http://x", settings: { contextWindow: 9_000 } })).toBe(9_000);
  });

  it("ranks by BM25: a description word finds the tool; no shared word finds nothing", () => {
    const tools = snapshot(3, 0).mcpTools.map((tool, i) => ({
      ...tool,
      description: ["Create a pull request.", "List open issues by label.", "Close an issue."][i],
    }));
    expect(rank(tools, "label issues").map((tool) => tool.name)).toEqual(["s__t1", "s__t2"]);
    expect(rank(tools, "deploy")).toEqual([]);
  });
});
