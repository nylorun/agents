import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { chmodSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Agent, hashManifest } from "@nylorun/core/define";
import { registerEndpoint, startEndpoint } from "./support/endpoint.js";
import { patchStoredSession, startTestTenant } from "./support/tenant.js";

const APP = "server-token-value-aaaaaaaa";
import type { ModelProvider } from "../src/core/provider.js";

const KEK = Buffer.alloc(32, 9).toString("base64");
const TOKEN = "ada-mcp-plaintext-token-7f3c9a2e";
const SECRET = "parent-secret-value";
const serverHeaders = {
  authorization: `Bearer ${APP}`,
  "content-type": "application/json",
};
const fixtureDir = realpathSync(
  dirname(fileURLToPath(new URL("./fixtures/stdio-env-server.mjs", import.meta.url))),
);

interface Probe {
  url: string;
  requests: { method?: string; authorization?: string | null; toolset?: string | null }[];
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
    requests.push({ method: body?.method, authorization, toolset });
    if (options.requiredToken && authorization !== `Bearer ${options.requiredToken}`) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (body?.method === "tools/call" && state.failCalls) {
      res.writeHead(500);
      res.end("upstream failed");
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

async function createBearer(runtime: { url: string }, ownerUserId: string, url: string, token: string) {
  const vault = await (
    await fetch(`${runtime.url}/v1/vaults`, {
      method: "POST",
      headers: serverHeaders,
      body: JSON.stringify({
        requestId: `vault-${ownerUserId}-${url}`,
        idempotencyKey: `vault-${ownerUserId}-${url}`,
        name: "GitHub",
        ownerUserId,
      }),
    })
  ).json();
  const credential = await (
    await fetch(`${runtime.url}/v1/vaults/${vault.id}/credentials`, {
      method: "POST",
      headers: serverHeaders,
      body: JSON.stringify({
        requestId: `cred-${token}`,
        idempotencyKey: `cred-${token}`,
        name: token,
        auth: { type: "bearer", url, token },
      }),
    })
  ).json();
  return { vaultId: vault.id as string, credentialId: credential.id as string };
}

async function register(
  runtime: { url: string },
  manifest: unknown,
  pluginRoots?: Record<string, string>,
) {
  const response = await fetch(`${runtime.url}/v1/agents/bot`, {
    method: "PUT",
    headers: serverHeaders,
    body: JSON.stringify({
      requestId: "put-agent",
      manifest,
      implementationVersion: "dev",
      ...(pluginRoots ? { pluginRoots } : {}),
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
  expect(response.ok).toBe(true);
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

it("discovers a remote MCP server with a bearer and calls it without delivering an Action", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-bearer-"));
  const remote = await probe({ name: "github", tool: "get_issue", requiredToken: TOKEN });
  const seen: string[][] = [];
  let cleanup = async () => {};
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
      .use({
        id: "issue-management",
        mcpServers: {
          github: {
            name: "github",
            type: "streamable-http",
            url: remote.url,
            headers: { "X-Toolset": "issues" },
          },
        },
      })
      .build();
    const registered = await register(runtime, agent.manifest);
    expect(registered.manifestHash).toBe(hashManifest(agent.manifest));
    // The agent has an Action endpoint, but the MCP call never reaches it.
    const endpoint = await startEndpoint({ runtime });
    cleanup = () => endpoint.close();
    await registerEndpoint(runtime, "bot", endpoint.url);
    const vault = await createBearer(runtime, "ada", remote.url, TOKEN);
    await openSession(runtime, "s1", { vaultIds: [vault.vaultId] });
    await say(runtime, "s1", "read the issue");
    const session = await until(runtime, "s1", ["completed", "failed", "uncertain"]);
    expect(session.status).toBe("completed");
    expect(session.mcpSnapshot.mcpTools).toEqual([
      expect.objectContaining({
        capabilityId: "issue-management",
        serverName: "github",
        serverToolName: "get_issue",
        name: "github__get_issue",
      }),
    ]);
    expect(JSON.stringify(session)).not.toContain(TOKEN);
    expect(seen[0]).toContain("github__get_issue");
    const called = remote.requests.filter((item) => item.method === "tools/call");
    expect(called).toEqual([
      expect.objectContaining({
        authorization: `Bearer ${TOKEN}`,
        toolset: "issues",
      }),
    ]);
    expect(endpoint.deliveries).toEqual([]);
    const history = await (
      await fetch(`${runtime.url}/v1/sessions/s1/items`, { headers: serverHeaders })
    ).json();
    expect(history.items.some((item: { type: string }) => item.type === "action.pending")).toBe(
      false,
    );
  } finally {
    await runtime.close();
    await remote.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("writes tool.completed with the output or the tool error of each MCP call", async () => {
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
      .use({
        id: "issue-management",
        mcpServers: {
          github: { name: "github", type: "streamable-http", url: remote.url },
        },
      })
      .build();
    await register(runtime, agent.manifest);
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
        capabilityId: "issue-management",
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
  } finally {
    await runtime.close();
    await remote.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("refuses an ambiguous server and still discovers the other one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-ambiguous-"));
  const github = await probe({ name: "github", tool: "get_issue", requiredToken: TOKEN });
  const docs = await probe({ name: "docs", tool: "search" });
  const runtime = await boot(directory, async () => ({
    output: [{ type: "text", text: "done" }],
  }));
  try {
    const agent = Agent({ id: "bot", name: "Bot" })
      .use({
        id: "issue-management",
        mcpServers: {
          github: { name: "github", type: "streamable-http", url: github.url },
          docs: { name: "docs", type: "streamable-http", url: docs.url },
        },
      })
      .build();
    await register(runtime, agent.manifest);
    const first = await createBearer(runtime, "ada", github.url, TOKEN);
    const second = await createBearer(runtime, "ada", github.url, `${TOKEN}-other`);
    await openSession(runtime, "s1", { vaultIds: [first.vaultId] });
    await say(runtime, "s1", "hello");
    const session = await until(runtime, "s1", ["completed", "failed", "uncertain"]);
    expect(session.status).toBe("completed");
    expect(github.requests).toEqual([]);
    expect(session.mcpSnapshot.mcpTools.map((tool: { name: string }) => tool.name)).toEqual([
      "docs__search",
    ]);
    expect(session.mcpDiagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          serverName: "github",
          outcome: "refused",
          credentialIds: expect.arrayContaining([first.credentialId, second.credentialId]),
        }),
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

it("connects without Authorization when no credential matches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-public-"));
  const remote = await probe({ name: "github", tool: "get_issue" });
  const runtime = await boot(directory, async () => ({
    output: [{ type: "text", text: "done" }],
  }));
  try {
    const agent = Agent({ id: "bot", name: "Bot" })
      .use({
        id: "issue-management",
        mcpServers: {
          github: { name: "github", type: "streamable-http", url: remote.url },
        },
      })
      .build();
    await register(runtime, agent.manifest);
    await openSession(runtime, "s1");
    await say(runtime, "s1", "hello");
    const session = await until(runtime, "s1", ["completed", "failed", "uncertain"]);
    expect(session.status).toBe("completed");
    expect(remote.requests.some((item) => item.method === "tools/list")).toBe(true);
    expect(remote.requests.every((item) => item.authorization == null)).toBe(true);
    expect(session.mcpSnapshot.mcpTools[0].name).toBe("github__get_issue");
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
      .use({
        id: "issue-management",
        mcpServers: {
          github: { name: "github", type: "streamable-http", url: remote.url },
        },
      })
      .build();
    await register(runtime, agent.manifest);
    await openSession(runtime, "s1");
    await say(runtime, "s1", "first");
    const first = await until(runtime, "s1", ["completed", "failed"]);
    expect(first.mcpSnapshot.mcpTools.map((tool: { name: string }) => tool.name)).toEqual([
      "github__get_issue",
    ]);
    const listed = () => remote.requests.filter((item) => item.method === "tools/list").length;
    expect(listed()).toBe(1);
    remote.addTool("added");
    await say(runtime, "s1", "second");
    const again = await until(runtime, "s1", ["completed", "failed"]);
    expect(again.mcpSnapshot.mcpTools.map((tool: { name: string }) => tool.name)).toEqual([
      "github__get_issue",
    ]);
    expect(listed()).toBe(1);
    await openSession(runtime, "s2");
    await say(runtime, "s2", "fresh");
    const next = await until(runtime, "s2", ["completed", "failed"]);
    expect(next.mcpSnapshot.mcpTools.map((tool: { name: string }) => tool.name).sort()).toEqual([
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

it("does not send a failed MCP call again after it is uncertain", async () => {
  const remote = await probe({ name: "github", tool: "get_issue" });
  remote.failCalls = true;
  const runtime = await startTestTenant({
    applicationKey: APP,
    retainRoot: true,
    vaultKek: KEK,
    modelProvider: async () => ({
      output: [
        { type: "tool-call", id: "call-1", name: "github__get_issue", args: { number: 1 } },
      ],
    }),
  });
  try {
    const agent = Agent({ id: "bot", name: "Bot" })
      .use({
        id: "issue-management",
        mcpServers: {
          github: { name: "github", type: "streamable-http", url: remote.url },
        },
      })
      .build();
    await register(runtime, agent.manifest);
    await openSession(runtime, "s1");
    await say(runtime, "s1", "read");
    const session = await until(runtime, "s1", ["uncertain", "failed", "completed"]);
    expect(session.status).toBe("uncertain");
    expect(remote.requests.filter((item) => item.method === "tools/call")).toHaveLength(1);
    await runtime.close();
    await patchStoredSession(runtime.root, runtime.tenantId, "s1", { status: "runnable" });
    const again = await startTestTenant({
      applicationKey: APP,
      hostRoot: runtime.root,
      tenantId: runtime.tenantId,
      vaultKek: KEK,
      modelProvider: async () => {
        throw new Error("model must not run again");
      },
    });
    try {
      await until(again, "s1", ["uncertain", "failed", "completed"]);
      expect(remote.requests.filter((item) => item.method === "tools/call")).toHaveLength(1);
    } finally {
      await again.close();
      await rm(runtime.root, { recursive: true, force: true });
    }
  } finally {
    await remote.close();
  }
});

it("launches stdio without the parent environment and reports PLUGIN_DATA", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-stdio-"));
  chmodSync(join(fixtureDir, "stdio-env-server.mjs"), 0o755);
  process.env.NYLORUN_PARENT_SECRET = SECRET;
  const prompts: unknown[] = [];
  const runtime = await boot(directory, async (effect: { input: unknown }) => {
    const call = effect.input as { tools?: { name: string }[]; prompt?: { kind?: string }[] };
    prompts.push(effect.input);
    if (call.prompt?.at(-1)?.kind === "tool-result")
      return { output: [{ type: "text", text: "done" }] };
    return {
      output: [{ type: "tool-call", id: "call-1", name: "local__env", args: { key: "PATH" } }],
    };
  });
  try {
    const agent = Agent({ id: "bot", name: "Bot" })
      .use({
        id: "local",
        mcpServers: {
          local: {
            name: "local",
            type: "stdio",
            command: "./stdio-env-server.mjs",
          },
        },
      })
      .build();
    await register(runtime, agent.manifest, { local: fixtureDir });
    await openSession(runtime, "s1");
    await say(runtime, "s1", "env");
    const session = await until(runtime, "s1", ["completed", "failed", "uncertain"]);
    expect(session.status).toBe("completed");
    const rendered = JSON.stringify(prompts);
    expect(rendered).toContain("plugin-data");
    expect(rendered).not.toContain(SECRET);
    expect(session.mcpSnapshot.mcpTools[0].name).toBe("local__env");
  } finally {
    delete process.env.NYLORUN_PARENT_SECRET;
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("fails a relative stdio command that has no plugin root and still finishes the turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-stdio-root-"));
  const runtime = await boot(directory, async () => ({
    output: [{ type: "text", text: "done" }],
  }));
  try {
    const agent = Agent({ id: "bot", name: "Bot" })
      .use({
        id: "local",
        mcpServers: {
          local: { name: "local", type: "stdio", command: "./missing.mjs" },
        },
      })
      .build();
    await register(runtime, agent.manifest);
    await openSession(runtime, "s1");
    await say(runtime, "s1", "hello");
    const session = await until(runtime, "s1", ["completed", "failed", "uncertain"]);
    expect(session.status).toBe("completed");
    expect(session.mcpSnapshot.mcpTools).toEqual([]);
    expect(session.mcpDiagnostics).toEqual([
      expect.objectContaining({
        serverName: "local",
        outcome: "failed",
        message: expect.stringContaining("plugin root"),
      }),
    ]);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
