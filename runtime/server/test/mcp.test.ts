import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Agent, hashManifest } from "@nylorun/core/define";
import { startTestTenant } from "./support/tenant.js";

const APP = "server-token-value-aaaaaaaa";
import type { ModelProvider } from "../src/core/provider.js";

/** The tools a session pinned, as `server__tool` (protocol 15: the snapshot keeps raw names). */
function pinnedNames(snapshot: any): string[] {
  return (snapshot?.servers ?? []).flatMap((server: any) =>
    server.tools.map((tool: { name: string }) => `${server.name}__${tool.name}`),
  );
}

const KEK = Buffer.alloc(32, 9).toString("base64");
const TOKEN = "ada-mcp-plaintext-token-7f3c9a2e";
const serverHeaders = {
  authorization: `Bearer ${APP}`,
  "content-type": "application/json",
};

interface Probe {
  url: string;
  requests: {
    method?: string;
    authorization?: string | null;
    toolset?: string | null;
    traceparent?: string | null;
  }[];
  failCalls: boolean;
  close(): Promise<void>;
  addTool(name: string): void;
}

async function probe(options: {
  name: string;
  tool: string;
  requiredToken?: string;
}): Promise<Probe> {
  const names = [options.tool];
  const requests: Probe["requests"] = [];
  const state = { failCalls: false };
  const http = createServer(async (req, res) => {
    try {
      await onRequest(req, res);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end(error instanceof Error ? error.message : "failed");
      }
    }
  });
  async function onRequest(req: IncomingMessage, res: ServerResponse) {
    const authorization = header(req, "authorization");
    const toolset = header(req, "x-toolset");
    if (req.method === "GET") {
      if (options.requiredToken && authorization !== `Bearer ${options.requiredToken}`) {
        res.writeHead(401);
        res.end();
        return;
      }
      res.writeHead(405);
      res.end();
      return;
    }
    const body = await readBody(req);
    requests.push({ method: body?.method, authorization, toolset, traceparent: header(req, "traceparent") });
    if (options.requiredToken && authorization !== `Bearer ${options.requiredToken}`) {
      res.writeHead(401);
      res.end();
      return;
    }
    // The call arrived and its answer is lost: it may have run (R2b C7).
    if (body?.method === "tools/call" && state.failCalls) {
      req.socket.destroy();
      return;
    }
    const mcp = new McpServer({ name: options.name, version: "0.0.0" });
    for (const name of names)
      mcp.registerTool(
        name,
        {
          description: `Tool ${name}.`,
          inputSchema: { number: z.number().int() },
        },
        async ({ number }) => {
          // A negative number is a tool error, which the server reports with `isError`.
          if (number < 0) throw new Error(`no issue ${number}`);
          return {
            content: [{ type: "text", text: String(number) }],
            structuredContent: { number, title: name },
          };
        },
      );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    res.on("close", () => {
      void transport.close().catch(() => {});
      void mcp.close().catch(() => {});
    });
    await transport.handleRequest(req, res, body);
  }
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requests,
    get failCalls() {
      return state.failCalls;
    },
    set failCalls(value: boolean) {
      state.failCalls = value;
    },
    addTool(name: string) {
      names.push(name);
    },
    close: () =>
      new Promise((resolve, reject) => {
        http.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  return typeof value === "string" ? value : null;
}

async function readBody(req: IncomingMessage): Promise<{ method?: string } | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString();
  if (!raw) return undefined;
  return JSON.parse(raw) as { method?: string };
}

async function boot(_directory: string, model?: ModelProvider) {
  return startTestTenant({
    applicationKey: APP,
    vaultKek: KEK,
    ...(model ? { modelProvider: model } : {}),
  });
}

/** Creates Environment `environmentId` (no sandbox), if it is not there yet. */
async function createEnvironment(runtime: { url: string }, environmentId: string) {
  const response = await fetch(`${runtime.url}/v1/environments/${environmentId}`, {
    method: "PUT",
    headers: serverHeaders,
    body: JSON.stringify({ requestId: `env-${environmentId}`, kind: "none" }),
  });
  expect(response.ok, await response.clone().text()).toBe(true);
}

/** Writes a bearer credential for `url` to the Environment's vault, as secret `name`. */
async function putBearer(
  runtime: { url: string },
  environmentId: string,
  name: string,
  url: string,
  token: string,
) {
  return fetch(`${runtime.url}/v1/environments/${environmentId}/secrets/${name}`, {
    method: "PUT",
    headers: serverHeaders,
    body: JSON.stringify({ requestId: `secret-${name}`, type: "bearer", url, value: token }),
  });
}

/** An Environment with one bearer credential for `url`. */
async function createBearer(runtime: { url: string }, environmentId: string, url: string, token: string) {
  await createEnvironment(runtime, environmentId);
  const response = await putBearer(runtime, environmentId, "github", url, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return { environmentId };
}

async function register(runtime: { url: string }, manifest: unknown) {
  const response = await fetch(`${runtime.url}/v1/agents/bot`, {
    method: "PUT",
    headers: serverHeaders,
    body: JSON.stringify({
      requestId: "put-agent",
      manifest,
      implementationVersion: "dev",
    }),
  });
  expect(response.ok).toBe(true);
  return response.json() as Promise<{ manifestHash: string }>;
}

async function openSession(
  runtime: { url: string },
  id: string,
  body: Record<string, unknown> = {},
) {
  const response = await fetch(`${runtime.url}/v1/sessions/${id}`, {
    method: "PUT",
    headers: serverHeaders,
    body: JSON.stringify({
      requestId: `session-${id}`,
      agentId: "bot",
      ownerUserId: "ada",
      ...body,
    }),
  });
  expect(response.ok, await response.clone().text()).toBe(true);
}

async function say(runtime: { url: string }, id: string, content: string) {
  const response = await fetch(`${runtime.url}/v1/sessions/${id}/commands`, {
    method: "POST",
    headers: serverHeaders,
    body: JSON.stringify({
      type: "message",
      requestId: `msg-${id}-${content}`,
      idempotencyKey: `msg-${id}-${content}`,
      content,
    }),
  });
  expect(response.ok).toBe(true);
}

async function until(runtime: { url: string }, id: string, statuses: readonly string[]) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const body = await (await fetch(`${runtime.url}/v1/sessions/${id}`, { headers: serverHeaders })).json();
    if (statuses.includes(body.status)) return body;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`session ${id} did not reach ${statuses.join(", ")}`);
}

it("discovers a remote MCP server with a bearer and calls it from the Runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-bearer-"));
  const remote = await probe({ name: "github", tool: "get_issue", requiredToken: TOKEN });
  const seen: string[][] = [];
  const runtime = await boot(directory, async (effect: { input: unknown }) => {
    const call = effect.input as { tools?: { name: string }[]; prompt?: { kind?: string }[] };
    const names = (call.tools ?? []).map((tool) => tool.name);
    seen.push(names);
    if (!names.includes("github__get_issue") || call.prompt?.at(-1)?.kind === "tool-result")
      return { output: [{ type: "text", text: "done" }] };
    return {
      output: [
        { type: "tool-call", id: "call-1", name: "github__get_issue", args: { number: 7 } },
      ],
    };
  });
  try {
    const agent = Agent({ id: "bot", name: "Bot" })
      .mcp({
        github: {
          name: "github",
          type: "streamable-http",
          url: remote.url,
          headers: { "X-Toolset": "issues" },
        },
      })
      .build();
    const registered = await register(runtime, agent.manifest);
    expect(registered.manifestHash).toBe(hashManifest(agent.manifest));
    const { environmentId } = await createBearer(runtime, "ada-env", remote.url, TOKEN);
    await openSession(runtime, "s1", { environment: environmentId });
    await say(runtime, "s1", "read the issue");
    const session = await until(runtime, "s1", ["completed", "failed", "uncertain"]);
    expect(session.status).toBe("completed");
    expect(session.mcpSnapshot.servers).toEqual([
      expect.objectContaining({ name: "github", tools: [expect.objectContaining({ name: "get_issue" })] }),
    ]);
    expect(JSON.stringify(session)).not.toContain(TOKEN);
    expect(seen[0]).toContain("github__get_issue");
    const called = remote.requests.filter((item) => item.method === "tools/call");
    expect(called).toEqual([
      expect.objectContaining({
        authorization: `Bearer ${TOKEN}`,
        toolset: "issues",
        // The call's span context (R7.4), on the call's own request only.
        traceparent: expect.stringMatching(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/),
      }),
    ]);
    for (const request of remote.requests.filter((item) => item.method !== "tools/call"))
      expect(request.traceparent).toBeNull();
    // The Runtime made the call itself: the log has its result and no action.* events.
    const history = await (
      await fetch(`${runtime.url}/v1/sessions/s1/items`, { headers: serverHeaders })
    ).json();
    expect(history.items.some((item: { type: string }) => item.type.startsWith("action."))).toBe(
      false,
    );
    expect(history.items.some((item: { type: string }) => item.type === "tool.completed")).toBe(
      true,
    );
  } finally {
    await runtime.close();
    await remote.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("writes tool.completed with the output or the tool error of each MCP call, traced to the server's plugin", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-transcript-"));
  const remote = await probe({ name: "github", tool: "get_issue" });
  const runtime = await boot(directory, async (effect: { input: unknown }) => {
    const call = effect.input as { prompt?: { kind?: string }[] };
    const results = (call.prompt ?? []).filter((item) => item.kind === "tool-result").length;
    if (results >= 2) return { output: [{ type: "text", text: "done" }] };
    return {
      output: [
        {
          type: "tool-call",
          id: `call-${results + 1}`,
          name: "github__get_issue",
          args: { number: results === 0 ? 7 : -1 },
        },
      ],
    };
  });
  try {
    const agent = Agent({ id: "bot", name: "Bot" })
      .mcp({
        github: { name: "github", type: "streamable-http", url: remote.url },
      })
      .build();
    // As `.plugin(dir)` labels a plugin's servers.
    const plugin = { name: "repo-tools", version: "0.3.1" };
    const manifest = {
      ...agent.manifest,
      mcpServers: { github: { ...agent.manifest.mcpServers!.github!, plugin } },
    };
    await register(runtime, manifest);
    await openSession(runtime, "s1");
    await say(runtime, "s1", "read two issues");
    expect((await until(runtime, "s1", ["completed", "failed", "uncertain"])).status).toBe(
      "completed",
    );
    const history = await (
      await fetch(`${runtime.url}/v1/sessions/s1/items`, { headers: serverHeaders })
    ).json();
    const completed = history.items
      .filter((item: { type: string }) => item.type === "tool.completed")
      .map((item: { payload: unknown }) => item.payload);
    expect(completed).toEqual([
      expect.objectContaining({
        callId: "call-1",
        toolName: "github__get_issue",
        output: { number: 7, title: "get_issue" },
      }),
      expect.objectContaining({
        callId: "call-2",
        toolName: "github__get_issue",
        error: { code: "mcp.tool", message: expect.stringContaining("no issue -1") },
      }),
    ]);
    expect(completed[1]).not.toHaveProperty("output");
    for (const call of completed)
      expect(call).toMatchObject({ kind: "mcp", server: "github", plugin });
    const discovered = history.items.find((item: { type: string }) => item.type === "mcp.discovered");
    expect(discovered.payload.servers).toEqual([expect.objectContaining({ serverName: "github", plugin })]);
    const rows = await (
      await fetch(`${runtime.url}/v1/sessions/s1/calls/tool`, { headers: serverHeaders })
    ).json();
    expect(rows.calls).toEqual(
      expect.arrayContaining([expect.objectContaining({ server: "github", skill: null, plugin })]),
    );
  } finally {
    await runtime.close();
    await remote.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("refuses a second credential for one server at the write, and connects with the first", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-conflict-"));
  const github = await probe({ name: "github", tool: "get_issue", requiredToken: TOKEN });
  const docs = await probe({ name: "docs", tool: "search" });
  const runtime = await boot(directory, async () => ({
    output: [{ type: "text", text: "done" }],
  }));
  try {
    const agent = Agent({ id: "bot", name: "Bot" })
      .mcp({
        github: { name: "github", type: "streamable-http", url: github.url },
        docs: { name: "docs", type: "streamable-http", url: docs.url },
      })
      .build();
    await register(runtime, agent.manifest);
    const { environmentId } = await createBearer(runtime, "ada-env", github.url, TOKEN);
    // Ambiguity is refused where it would start (protocol 11): one credential per URL.
    const second = await putBearer(runtime, environmentId, "other", github.url, `${TOKEN}-other`);
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ code: "credential_conflict" });
    const secrets = await (
      await fetch(`${runtime.url}/v1/environments/${environmentId}/secrets`, { headers: serverHeaders })
    ).json();
    expect(secrets.secrets.map((secret: { name: string }) => secret.name)).toEqual(["github"]);
    await openSession(runtime, "s1", { environment: environmentId });
    await say(runtime, "s1", "hello");
    const session = await until(runtime, "s1", ["completed", "failed", "uncertain"]);
    expect(session.status).toBe("completed");
    expect(github.requests.length).toBeGreaterThan(0);
    expect(github.requests.every((item) => item.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(docs.requests.every((item) => item.authorization == null)).toBe(true);
    expect(pinnedNames(session.mcpSnapshot).sort()).toEqual([
      "docs__search",
      "github__get_issue",
    ]);
    expect(session.mcpDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ serverName: "github", outcome: "connected" }),
        expect.objectContaining({ serverName: "docs", outcome: "connected" }),
      ]),
    );
  } finally {
    await runtime.close();
    await github.close();
    await docs.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("records mcp.discovered once, on the first turn, with each server's outcome", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-discovered-"));
  const docs = await probe({ name: "docs", tool: "search" });
  const down = await probe({ name: "down", tool: "never" });
  await down.close();
  const runtime = await boot(directory, async () => ({
    output: [{ type: "text", text: "done" }],
  }));
  try {
    const agent = Agent({ id: "bot", name: "Bot" })
      .mcp({
        docs: { name: "docs", type: "streamable-http", url: docs.url },
        down: { name: "down", type: "streamable-http", url: down.url },
      })
      .build();
    await register(runtime, agent.manifest);
    await openSession(runtime, "s1");
    await say(runtime, "s1", "first");
    expect((await until(runtime, "s1", ["completed", "failed", "uncertain"])).status).toBe("completed");
    await say(runtime, "s1", "second");
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const history = await (await fetch(`${runtime.url}/v1/sessions/s1/items`, { headers: serverHeaders })).json();
      if (history.items.filter((item: { type: string }) => item.type === "turn.completed").length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const history = await (await fetch(`${runtime.url}/v1/sessions/s1/items`, { headers: serverHeaders })).json();
    const types = history.items.map((item: { type: string }) => item.type);
    expect(types.filter((type: string) => type === "turn.completed")).toHaveLength(2);
    const discovered = history.items.filter((item: { type: string }) => item.type === "mcp.discovered");
    expect(discovered).toHaveLength(1);
    // Before the first turn's model call: the log says which tools the model has.
    expect(types.indexOf("mcp.discovered")).toBeLessThan(types.indexOf("turn.completed"));
    expect(discovered[0].turnId).toBe(history.items.find((item: { type: string }) => item.type === "turn.completed").turnId);
    expect(discovered[0].payload.servers).toEqual(
      expect.arrayContaining([
        { serverName: "docs", outcome: "connected", message: "Connected", tools: 1 },
        {
          serverName: "down",
          outcome: "failed",
          message: expect.stringMatching(/ECONNREFUSED/),
          tools: 0,
        },
      ]),
    );
    expect(discovered[0].payload.servers).toHaveLength(2);
  } finally {
    await runtime.close();
    await docs.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("connects without Authorization when no credential matches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-public-"));
  const remote = await probe({ name: "github", tool: "get_issue" });
  const runtime = await boot(directory, async () => ({
    output: [{ type: "text", text: "done" }],
  }));
  try {
    const agent = Agent({ id: "bot", name: "Bot" })
      .mcp({
        github: { name: "github", type: "streamable-http", url: remote.url },
      })
      .build();
    await register(runtime, agent.manifest);
    await openSession(runtime, "s1");
    await say(runtime, "s1", "hello");
    const session = await until(runtime, "s1", ["completed", "failed", "uncertain"]);
    expect(session.status).toBe("completed");
    expect(remote.requests.some((item) => item.method === "tools/list")).toBe(true);
    expect(remote.requests.every((item) => item.authorization == null)).toBe(true);
    expect(pinnedNames(session.mcpSnapshot)[0]).toBe("github__get_issue");
  } finally {
    await runtime.close();
    await remote.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("pins the discovery snapshot and lets a new session discover again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-pin-"));
  const remote = await probe({ name: "github", tool: "get_issue" });
  const runtime = await boot(directory, async (effect: { sessionId: string; input: unknown }) => {
    const call = effect.input as { tools?: { name: string }[] };
    if (effect.sessionId === "s1" && call.tools?.some((tool) => tool.name === "github__added"))
      return { output: [{ type: "text", text: "saw-new-tool" }] };
    return { output: [{ type: "text", text: "done" }] };
  });
  try {
    const agent = Agent({ id: "bot", name: "Bot" })
      .mcp({
        github: { name: "github", type: "streamable-http", url: remote.url },
      })
      .build();
    await register(runtime, agent.manifest);
    await openSession(runtime, "s1");
    await say(runtime, "s1", "first");
    const first = await until(runtime, "s1", ["completed", "failed"]);
    expect(pinnedNames(first.mcpSnapshot)).toEqual([
      "github__get_issue",
    ]);
    const listed = () => remote.requests.filter((item) => item.method === "tools/list").length;
    expect(listed()).toBe(1);
    remote.addTool("added");
    await say(runtime, "s1", "second");
    const again = await until(runtime, "s1", ["completed", "failed"]);
    expect(pinnedNames(again.mcpSnapshot)).toEqual([
      "github__get_issue",
    ]);
    expect(listed()).toBe(1);
    await openSession(runtime, "s2");
    await say(runtime, "s2", "fresh");
    const next = await until(runtime, "s2", ["completed", "failed"]);
    expect(pinnedNames(next.mcpSnapshot).sort()).toEqual([
      "github__added",
      "github__get_issue",
    ]);
    expect(listed()).toBe(2);
  } finally {
    await runtime.close();
    await remote.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("gives a lost MCP answer to the model as mcp.lost, and never sends the call again (R5)", async () => {
  const remote = await probe({ name: "github", tool: "get_issue" });
  remote.failCalls = true;
  const seen: unknown[] = [];
  const runtime = await startTestTenant({
    applicationKey: APP,
    vaultKek: KEK,
    modelProvider: async (effect) => {
      const prompt = (effect.input as { prompt?: { kind?: string }[] }).prompt ?? [];
      const result = prompt.find((item) => item.kind === "tool-result");
      if (result) {
        seen.push(result);
        return { output: [{ type: "text", text: "done" }] };
      }
      return {
        output: [{ type: "tool-call", id: "call-1", name: "github__get_issue", args: { number: 1 } }],
      };
    },
  });
  try {
    const agent = Agent({ id: "bot", name: "Bot" })
      .mcp({
        github: { name: "github", type: "streamable-http", url: remote.url },
      })
      .build();
    await register(runtime, agent.manifest);
    await openSession(runtime, "s1");
    await say(runtime, "s1", "read");
    const session = await until(runtime, "s1", ["uncertain", "failed", "completed"]);
    expect(session.status).toBe("completed");
    expect(JSON.stringify(seen)).toContain("mcp.lost");
    expect(remote.requests.filter((item) => item.method === "tools/call")).toHaveLength(1);
  } finally {
    await runtime.close();
    await remote.close();
  }
});

it("refuses to store an agent that declares a stdio MCP server", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-stdio-"));
  const runtime = await boot(directory);
  try {
    const manifest = Agent({ id: "bot", name: "Bot" }).build().manifest;
    const response = await fetch(`${runtime.url}/v1/agents/bot`, {
      method: "PUT",
      headers: serverHeaders,
      body: JSON.stringify({
        requestId: "put-agent",
        manifest: {
          ...manifest,
          mcpServers: { local: { name: "local", type: "stdio", command: "./server.mjs" } },
        },
        implementationVersion: "dev",
      }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).message).toContain(
      "MCP server 'local' uses stdio; Nylorun accepts remote MCP servers only (streamable-http or sse).",
    );
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
