import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  Agent,
  tool,
} from "@nylorun/core/define";
import type { HostEffect } from "@nylorun/harness/run";
import {
  registerEndpoint,
  startEndpoint,
  type Delivery,
  type TestEndpoint,
} from "./support/endpoint.js";
import { startTestTenant } from "./support/tenant.js";

const APP = "server-token-value-aaaaaaaa";
import type { ModelProvider } from "../src/core/provider.js";

const serverHeaders = {
  authorization: `Bearer ${APP}`,
  "content-type": "application/json",
};
/** A streamable-http MCP server with one tool, `echo`; answers `echo <text>`. */
async function echoServer(): Promise<{ url: string; close(): Promise<void> }> {
  const http = createServer(async (req, res) => {
    if (req.method !== "POST") return void res.writeHead(405).end();
    const mcp = new McpServer({ name: "local", version: "0.0.0" });
    mcp.registerTool(
      "echo",
      { description: "Echo.", inputSchema: { text: z.string() } },
      async ({ text }) => ({ content: [{ type: "text", text: `echo ${text}` }] })
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    res.on("close", () => {
      void transport.close().catch(() => {});
      void mcp.close().catch(() => {});
    });
    await transport.handleRequest(req, res, await json(req));
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise((resolve) => http.close(() => resolve())),
  };
}

async function json(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString());
}

const search = tool({
  name: "search_orders",
  input: z.object({ query: z.string() }),
  run: async () => "unused: the test plays the Action endpoint",
});

type Call = { name: string; args: Record<string, unknown> };
type Prompt = { kind?: string; content?: { text?: string }[] }[];

/** Each agent plays its own list of tool calls, one per step, then answers. */
function script(plays: {
  root: Call[][];
  child: (task: string) => Call[];
}): ModelProvider & {
  seen: { agent: string; prompt: Prompt }[];
} {
  const seen: { agent: string; prompt: Prompt }[] = [];
  const provider = (async (effect: HostEffect) => {
    const prompt = (effect.input as { prompt?: Prompt }).prompt ?? [];
    seen.push({ agent: effect.agent?.id ?? "root", prompt });
    const step = prompt.filter((item) => item.kind === "tool-result").length;
    if (effect.agent) {
      const task =
        prompt.find((item) => item.kind === "message")?.content?.[0]?.text ??
        "";
      const next = plays.child(task)[step];
      if (!next) return { output: [{ type: "text", text: `answer ${task}` }] };
      return {
        output: [
          {
            type: "tool-call",
            id: `c${step}`,
            name: next.name,
            args: next.args,
          },
        ],
      };
    }
    const batch = plays.root[step];
    if (!batch) return { output: [{ type: "text", text: "done" }] };
    return {
      output: batch.map((call, index) => ({
        type: "tool-call",
        id: `p${step}-${index}`,
        name: call.name,
        args: call.args,
      })),
    };
  }) as unknown as ModelProvider & { seen: { agent: string; prompt: Prompt }[] };
  provider.seen = seen;
  return provider;
}

/** A Tenant whose agent `bot` is served by an endpoint that answers every delivery `202`. */
async function boot(_directory: string, modelProvider: ModelProvider) {
  const tenant = await startTestTenant({
    applicationKey: APP,
    vaultKek: null,
    modelProvider,
    sandbox: { backend: "virtual" },
  });
  const endpoint = await startEndpoint({ runtime: tenant });
  await registerEndpoint(tenant, "bot", endpoint.url);
  return {
    ...tenant,
    endpoint,
    async close() {
      await endpoint.close();
      await tenant.close();
    },
  };
}

async function start(
  runtime: { url: string },
  manifest: unknown,
  sandbox?: Record<string, unknown>
) {
  const put = await fetch(`${runtime.url}/v1/agents/bot`, {
    method: "PUT",
    headers: serverHeaders,
    body: JSON.stringify({
      requestId: "put-agent",
      manifest,
      implementationVersion: "dev",
    }),
  });
  expect(put.ok, await put.clone().text()).toBe(true);
  const session = await fetch(`${runtime.url}/v1/sessions/s1`, {
    method: "PUT",
    headers: serverHeaders,
    body: JSON.stringify({
      requestId: "session",
      agentId: "bot",
      ownerUserId: "ada",
      ...(sandbox ? { sandbox } : {}),
    }),
  });
  expect(session.ok).toBe(true);
  const message = await fetch(`${runtime.url}/v1/sessions/s1/commands`, {
    method: "POST",
    headers: serverHeaders,
    body: JSON.stringify({
      type: "message",
      requestId: "m1",
      idempotencyKey: "m1",
      content: "go",
    }),
  });
  expect(message.ok).toBe(true);
}

async function session(runtime: { url: string }) {
  return (
    await fetch(`${runtime.url}/v1/sessions/s1`, { headers: serverHeaders })
  ).json();
}

async function until(runtime: { url: string }, statuses: readonly string[]) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const body = await session(runtime);
    if (statuses.includes(body.status)) return body;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`session did not reach ${statuses.join(", ")}`);
}

async function items(runtime: { url: string }, agent?: string) {
  const query = agent ? `?agent=${encodeURIComponent(agent)}` : "";
  const body = await (
    await fetch(`${runtime.url}/v1/sessions/s1/items${query}`, {
      headers: serverHeaders,
    })
  ).json();
  return body.items as { type: string; payload: any }[];
}

/** Waits until the endpoint was sent `count` Actions, and returns them. */
async function deliveries(
  runtime: { endpoint: TestEndpoint },
  count: number
): Promise<Delivery[]> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (runtime.endpoint.deliveries.length >= count)
      return [...runtime.endpoint.deliveries];
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`expected ${count} deliveries`);
}

/** Play the root agent's endpoint: post the result of an Action it answered `202`. */
async function complete(delivery: Delivery, output: unknown) {
  const result = await delivery.result({ kind: "completed", output });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
}

it("delivers the work of agents used as tools to the root agent's endpoint and journals it once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "delegation-"));
  const model = script({
    root: [
      [
        { name: "researcher", args: { task: "A" } },
        { name: "researcher", args: { task: "B" } },
      ],
    ],
    child: (task) => [{ name: "search_orders", args: { query: task } }],
  });
  const runtime = await boot(directory, model);
  try {
    const researcher = Agent({
      id: "researcher",
      description: "Researches.",
      tools: [search],
    });
    await start(
      runtime,
      Agent({ id: "bot", tools: [researcher] }).build().manifest
    );
    const sent = await deliveries(runtime, 2);
    for (const { action } of sent)
      expect(action).toMatchObject({
        agentId: "bot",
        kind: "tool",
        toolName: "search_orders",
        agent: { id: "researcher", path: "bot/researcher" },
      });
    for (const delivery of sent)
      await complete(
        delivery,
        `found ${(delivery.action.input as { query: string }).query}`
      );
    const done = await until(runtime, ["completed", "failed", "uncertain"]);
    expect(done.status).toBe("completed");

    // The parent's final model call saw both children's answers and none of their work.
    const last = model.seen.filter((item) => item.agent === "root").at(-1)!;
    const text = JSON.stringify(last.prompt);
    expect(text).toContain("answer A");
    expect(text).toContain("answer B");
    expect(text).not.toContain("found A");

    const history = await items(runtime);
    const started = history.filter(
      (item) => item.type === "delegation.started"
    );
    const completed = history.filter(
      (item) => item.type === "delegation.completed"
    );
    expect(started.map((item) => item.payload.task).sort()).toEqual(["A", "B"]);
    expect(completed).toHaveLength(2);
    expect(completed.every((item) => item.payload.status === "completed")).toBe(
      true
    );
    // Each lifecycle event names the parent's tool call, for chat UIs.
    for (const item of [...started, ...completed])
      expect(item.payload.callId).toEqual(expect.any(String));
    const work = history.filter((item) => item.type.startsWith("action."));
    expect(work).toHaveLength(6);
    expect(
      work.every((item) => item.payload.agent?.path === "bot/researcher")
    ).toBe(true);

    const one = started[0]!.payload.agent.delegationId;
    const scoped = await items(runtime, one);
    expect(scoped.length).toBeGreaterThan(0);
    expect(
      scoped.every((item) => item.payload.agent.delegationId === one)
    ).toBe(true);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("gives an agent used as a tool its own MCP servers and the session's sandbox", async () => {
  const directory = await mkdtemp(join(tmpdir(), "delegation-mcp-"));
  const server = await echoServer();
  const model = script({
    root: [
      [{ name: "coder", args: { task: "note" } }],
      [{ name: "read", args: { path: "note.txt" } }],
    ],
    child: () => [
      { name: "local__echo", args: { text: "from the server" } },
      { name: "write", args: { path: "note.txt", content: "from the child" } },
    ],
  });
  const runtime = await boot(directory, model);
  try {
    const coder = Agent({ id: "coder", description: "Writes notes." })
      .use({
        id: "local",
        mcpServers: {
          local: { name: "local", type: "streamable-http", url: server.url },
        },
      });
    const bot = Agent({ id: "bot", tools: [coder] }).build();
    // The session is opened with a sandbox; the agent it uses as a tool shares it.
    await start(runtime, bot.manifest, {});
    const done = await until(runtime, ["completed", "failed", "uncertain"]);
    expect(done.status).toBe("completed");
    expect(done.mcpSnapshot.mcpTools).toEqual([
      expect.objectContaining({
        agentId: "coder",
        capabilityId: "local",
        name: "local__echo",
      }),
    ]);
    // The root never saw the child's MCP tool; the child did.
    const rootTools = JSON.stringify(
      model.seen.filter((item) => item.agent === "root")
    );
    expect(rootTools).not.toContain("local__echo");
    const childPrompts = JSON.stringify(
      model.seen.filter((item) => item.agent === "coder")
    );
    expect(childPrompts).toContain("echo from the server");
    // The parent read the file the child wrote: one sandbox per session.
    const last = model.seen.filter((item) => item.agent === "root").at(-1)!;
    expect(JSON.stringify(last.prompt)).toContain("from the child");
  } finally {
    await runtime.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("fences a delegated agent's work when the session is cancelled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "delegation-cancel-"));
  const model = script({
    root: [[{ name: "researcher", args: { task: "A" } }]],
    child: (task) => [{ name: "search_orders", args: { query: task } }],
  });
  const runtime = await boot(directory, model);
  try {
    const researcher = Agent({
      id: "researcher",
      description: "Researches.",
      tools: [search],
    });
    await start(
      runtime,
      Agent({ id: "bot", tools: [researcher] }).build().manifest
    );
    const [delivery] = await deliveries(runtime, 1);
    const cancel = await fetch(`${runtime.url}/v1/sessions/s1/commands`, {
      method: "POST",
      headers: serverHeaders,
      body: JSON.stringify({
        type: "cancel",
        requestId: "c1",
        idempotencyKey: "c1",
      }),
    });
    expect(cancel.ok).toBe(true);
    expect((await session(runtime)).status).toBe("cancelled");
    // The delegated Action is fenced: its endpoint's late result is refused.
    const late = await delivery!.result({ kind: "completed", output: "late" });
    expect(late.status).toBe(409);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("surfaces a child's empty answer as a failed tool result and filters history by path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "delegation-fail-"));
  const seen: { agent: string; prompt: Prompt }[] = [];
  const modelProvider: ModelProvider = async (effect) => {
    const prompt = (effect.input as { prompt?: Prompt }).prompt ?? [];
    seen.push({ agent: effect.agent?.id ?? "root", prompt });
    const step = prompt.filter((item) => item.kind === "tool-result").length;
    if (effect.agent) {
      const task =
        prompt.find((item) => item.kind === "message")?.content?.[0]?.text ??
        "";
      if (task === "A") return { output: [{ type: "text", text: "   " }] };
      if (step === 0)
        return {
          output: [
            {
              type: "tool-call",
              id: "c0",
              name: "search_orders",
              args: { query: task },
            },
          ],
        };
      return { output: [{ type: "text", text: `answer ${task}` }] };
    }
    if (step === 0)
      return {
        output: [
          {
            type: "tool-call",
            id: "p0-0",
            name: "researcher",
            args: { task: "A" },
          },
          {
            type: "tool-call",
            id: "p0-1",
            name: "researcher",
            args: { task: "B" },
          },
        ],
      };
    return { output: [{ type: "text", text: "done" }] };
  };
  const runtime = await boot(directory, modelProvider);
  try {
    const researcher = Agent({
      id: "researcher",
      description: "Researches.",
      tools: [search],
    });
    await start(
      runtime,
      Agent({ id: "bot", tools: [researcher] }).build().manifest
    );
    const sent = await deliveries(runtime, 1);
    expect(sent).toHaveLength(1);
    await complete(
      sent[0]!,
      `found ${(sent[0]!.action.input as { query: string }).query}`
    );
    const done = await until(runtime, ["completed", "failed", "uncertain"]);
    expect(done.status).toBe("completed");

    const last = seen.filter((item) => item.agent === "root").at(-1)!;
    const text = JSON.stringify(last.prompt);
    expect(text).toContain("answer B");
    expect(text).toContain("finished without an answer");

    const byPath = await items(runtime, "bot/researcher");
    expect(byPath.length).toBeGreaterThan(0);
    expect(
      byPath.every((item) => item.payload.agent?.path === "bot/researcher")
    ).toBe(true);
    const started = byPath.filter((item) => item.type === "delegation.started");
    // Path filter matches every concurrent child that shares the path.
    expect(started).toHaveLength(2);
    const one = started[0]!.payload.agent.delegationId;
    const byId = await items(runtime, one);
    expect(byId.every((item) => item.payload.agent.delegationId === one)).toBe(
      true
    );
    expect(
      byId.filter((item) => item.type === "delegation.started")
    ).toHaveLength(1);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});
