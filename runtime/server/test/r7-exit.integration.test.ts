/**
 * The R7 exit, as the plan words it: one trace per turn in a stock OTel collector, with a span for
 * every model and tool crossing; since D67 an egress connection is the Agent's, on its stream
 * naming the turn, and has no span. Exporting the same log again, or reading it from the
 * trace route, gives the same span ids. A collector that is down costs those spans and nothing
 * else: turns run and Postgres keeps no extra WAL. No credential value or prompt appears in any
 * span.
 *
 * The collector is `otel/opentelemetry-collector` with its file exporter, in the test stack's
 * `traces` profile (`NYLORUN_TEST_PROFILES=traces npm run test:stack:up`); without it this file
 * skips. One turn crosses an MCP server (with a bearer from the Agent's vault), an HTTP
 * tool and a sandbox command, which opens a tunnel through egress-gate.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { connect, createServer as createTcpServer, type AddressInfo, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Agent, http } from "@nylorun/core/define";
import type { ModelProvider } from "../src/core/provider.js";
import { startEgressGate, storeEgressRecord, type EgressGate } from "../src/gates/egress.js";
import type { SandboxBackend } from "../src/sandbox/types.js";
import type { OtlpSpan } from "../src/traces/map.js";
import { STACK_ENABLED, stackEndpoints } from "./stack/endpoints.js";
import { deploy, openSession } from "./support/agents.js";
import { openTestSessionStore, testTenantPool } from "./support/store.js";
import { startTestTenant } from "./support/tenant.js";
import {
  confirmedOf,
  currentLsn,
  dropSlot,
  lsnAtLeast,
  otlpReceiver,
  startTestProjector,
  testSlot,
  until,
} from "./support/traces.js";

const APP = "r7-exit-app-key-aaaaaaaaaaaaaaaaaaaa";
const MCP_TOKEN = "r7-exit-mcp-bearer-5d1e9b";
const OWNER = "person-r7-exit-4c2a";
const PROMPT = "Mind the release notes (instructions-r7-exit-8e3f)";
const IDEMPOTENCY = "idem-r7-exit-0a7c";
const EGRESS_TOKEN = "egress-token-r7-exit-6b9d";
const headers = { authorization: `Bearer ${APP}`, "content-type": "application/json" };
const { otel } = stackEndpoints();
const compose = fileURLToPath(new URL("./stack/compose.yaml", import.meta.url));

/** The collector answers OTLP: the stack runs with the `traces` profile. */
async function collectorUp(): Promise<boolean> {
  try {
    const response = await fetch(otel.tracesUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resourceSpans: [] }),
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
const COLLECTOR = STACK_ENABLED && (await collectorUp());

/** Every span the collector's file exporter wrote, in its complete lines. */
function collected(): OtlpSpan[] {
  const file = join(otel.dir, "traces.jsonl");
  if (!existsSync(file)) return [];
  const spans: OtlpSpan[] = [];
  // The exporter flushes as it writes, so the text after the last newline may be a line it is still writing.
  for (const line of readFileSync(file, "utf8").split("\n").slice(0, -1))
    if (line.trim())
      for (const resource of JSON.parse(line).resourceSpans ?? [])
        for (const scope of resource.scopeSpans ?? []) spans.push(...(scope.spans ?? []));
  return spans;
}

function collector(command: "stop" | "start"): void {
  const result = spawnSync("docker", ["compose", "-f", compose, "--profile", "traces", command, "otel-collector"], {
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error(`docker compose ${command} otel-collector exited with ${result.status}`);
}

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const close of cleanups.splice(0).reverse()) await close().catch(() => undefined);
});

/** An MCP server that needs `MCP_TOKEN`, with one tool. */
async function mcpServer(): Promise<string> {
  const server = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (req.headers.authorization !== `Bearer ${MCP_TOKEN}`) return void res.writeHead(401).end();
    if (req.method !== "POST") return void res.writeHead(405).end();
    const mcp = new McpServer({ name: "notes", version: "0.0.0" });
    mcp.registerTool("lookup", { description: "Looks a note up.", inputSchema: { id: z.number().int() } }, async ({ id }) => ({
      content: [{ type: "text", text: `note ${id}` }],
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    res.on("close", () => void transport.close().catch(() => {}));
    const raw = Buffer.concat(chunks).toString();
    await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

/** An HTTP tool. */
async function hookServer(): Promise<string> {
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
}

/** Opens one tunnel through egress-gate to `releases.test:443` (an echo server), and closes it. */
async function tunnelOnce(gate: EgressGate): Promise<void> {
  const socket: Socket = connect({ host: "127.0.0.1", port: Number(new URL(gate.url).port) });
  await new Promise<void>((resolve, reject) => {
    let head = "";
    const onData = (chunk: Buffer) => {
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      if (!head.startsWith("HTTP/1.1 200")) return reject(new Error(head));
      socket.once("data", () => resolve());
      socket.write("ping");
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.write(
      `CONNECT releases.test:443 HTTP/1.1\r\nHost: releases.test:443\r\nProxy-Authorization: Bearer ${EGRESS_TOKEN}\r\n\r\n`,
    );
  });
  await new Promise<void>((resolve) => {
    socket.once("close", () => resolve());
    socket.end();
  });
}

/** Step 1: one call of each kind at once; step 2: an answer. */
const model: ModelProvider = async (effect) => {
  const prompt = (effect.input as { prompt?: { kind?: string }[] }).prompt ?? [];
  if (prompt.at(-1)?.kind === "tool-result") return { output: [{ type: "text", text: "shipped" }] };
  return {
    output: [
      { type: "tool-call", id: "c-mcp", name: "notes__lookup", args: { id: 7 } },
      { type: "tool-call", id: "c-http", name: "hook", args: { n: 1 } },
      { type: "tool-call", id: "c-bash", name: "bash", args: { command: "curl https://releases.test" } },
    ],
  };
};

describe.skipIf(!COLLECTOR)("the R7 exit", { timeout: 180_000 }, () => {
  let runtime: Awaited<ReturnType<typeof startTestTenant>>;
  let projector: Awaited<ReturnType<typeof startTestProjector>>;
  const logged: { message: string; fields?: Record<string, unknown> }[] = [];
  const slot = testSlot();
  const copy = `${slot}_copy`;
  let turns = 0;

  const turn = async (): Promise<{ turnId: string; status: string; error?: string }> => {
    turns += 1;
    const sent = await fetch(`${runtime.url}/v1/sessions/s1/commands`, {
      method: "POST",
      headers,
      body: JSON.stringify({ type: "message", requestId: `m${turns}`, idempotencyKey: `${IDEMPOTENCY}-${turns}`, content: "ship it" }),
    });
    expect(sent.ok, await sent.clone().text()).toBe(true);
    const { turnId } = (await sent.json()) as { turnId: string };
    let session: { status: string; error?: string } = { status: "" };
    await until("the turn to end", async () => {
      session = (await (await fetch(`${runtime.url}/v1/sessions/s1`, { headers })).json()) as typeof session;
      return ["completed", "failed", "cancelled"].includes(session.status);
    }, 60_000);
    return { turnId, status: session.status, ...(session.error ? { error: JSON.stringify(session.error) } : {}) };
  };
  const route = async (turnId: string): Promise<OtlpSpan[]> => {
    const body = (await (await fetch(`${runtime.url}/v1/sessions/s1/turns/${turnId}/trace`, { headers })).json()) as any;
    return body.resourceSpans[0].scopeSpans[0].spans;
  };

  beforeAll(async () => {
    const echo = createTcpServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => echo.close(() => resolve())));
    let gate: EgressGate | undefined;
    const backend = {
      name: "virtual",
      isolation: "process",
      probe: async () => ({ name: "virtual", isolation: "process", available: true, reason: "test" }),
      unmet: () => undefined,
      open: async () => ({
        // The command reaches the network through egress-gate, as a pod's would.
        async exec() {
          await tunnelOnce(gate!);
          return { exitCode: 0, stdout: "200 OK", stderr: "", killed: false, timedOut: false };
        },
        readFile: async () => undefined,
        writeFile: async () => {},
        stop: async () => {},
      }),
      remove: async () => {},
      list: async () => [],
    } as unknown as SandboxBackend;
    runtime = await startTestTenant({
      applicationKey: APP,
      modelProvider: model,
      vaultKek: Buffer.alloc(32, 7).toString("base64"),
      sandbox: { backend: "virtual", backends: [backend] },
    });
    cleanups.push(() => runtime.close());
    const store = await openTestSessionStore({ root: runtime.root, tenantId: runtime.tenantId });
    cleanups.push(() => store.close());
    gate = await startEgressGate({
      listen: { host: "127.0.0.1", port: 0 },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      verify: async (raw) =>
        raw === EGRESS_TOKEN
          ? { ok: true, claims: { tenantId: runtime.tenantId, sandboxId: "ws/s1", epoch: 1, podUid: "pod-1", expiresAt: Date.now() + 3_600_000 } }
          : { ok: false, reason: "invalid" },
      sandboxes: { live: async (id) => (id === "ws/s1" ? { epoch: 1, podUid: "pod-1", allow: ["releases.test"] } : undefined) },
      cacheMs: 0,
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      blocked: (address) => address !== "127.0.0.1",
      dial: (address) => connect({ host: address, port: (echo.address() as AddressInfo).port }),
      record: storeEgressRecord(store),
    });
    cleanups.push(() => gate!.close());

    const mcpUrl = await mcpServer();
    const manifest = Agent({ id: "bot", name: "Bot" })
      .instructions(PROMPT)
      .mcp({ notes: { name: "notes", type: "streamable-http", url: mcpUrl } })
      .tools(http({ name: "hook", input: z.object({ n: z.number() }), url: await hookServer() }))
      .build().manifest;
    await deploy(runtime.url, headers, manifest, {
      id: "ws/s1",
      runtime: { kind: "virtual" },
      secrets: { notes: { requestId: "k", type: "bearer", url: mcpUrl, value: MCP_TOKEN } },
    });
    const opened = await openSession(runtime.url, headers, "s1", { agent: "ws/s1", ownerUserId: OWNER });
    expect(opened.ok, await opened.clone().text()).toBe(true);

    cleanups.push(() => dropSlot(runtime.tenantId, slot), () => dropSlot(runtime.tenantId, copy));
    await testTenantPool(runtime.tenantId)`SELECT pg_create_logical_replication_slot(${slot}, 'pgoutput')`;
    await testTenantPool(runtime.tenantId)`SELECT pg_copy_logical_replication_slot(${slot}, ${copy})`;
    projector = await startTestProjector({
      tenantId: runtime.tenantId,
      root: runtime.root,
      slot,
      url: otel.tracesUrl,
      // Every content kind on: still no credential, prompt or person's id may leave.
      content: new Set(["user", "outputs", "tool-results", "errors"]),
      log: (message, fields) => logged.push({ message, ...(fields ? { fields } : {}) }),
    });
    cleanups.push(() => projector.close());
  });

  let first: string;

  it("puts one trace per turn in the collector, with a span for every model and tool crossing", async () => {
    const ended = await turn();
    expect(ended.status, ended.error).toBe("completed");
    first = ended.turnId;
    // egress-gate records a tunnel when it closes, after the command's answer, on the Agent's
    // stream, naming the turn that ran (D67).
    await until("the tunnel's record", async () => {
      const response = await fetch(`${runtime.url}/v1/agents/ws%2Fs1/events?types=agent.egress`, { headers });
      const { events } = (await response.json()) as { events: { payload: { runningTurns: { sessionId: string; turnId: string }[] } }[] };
      return events.some((event) => event.payload.runningTurns.some((running) => running.sessionId === "s1" && running.turnId === first));
    });
    const answered = await route(first);
    const traceId = answered[0]!.traceId;
    const names = answered.map((span) => span.name).sort();
    expect(names).toEqual(
      ["chat", "chat", "execute_tool bash", "execute_tool hook", "execute_tool notes__lookup", "invoke_agent bot"].sort(),
    );
    await until("the turn's spans in the collector", () => collected().filter((span) => span.traceId === traceId).length >= answered.length, 30_000);
    const inCollector = collected().filter((span) => span.traceId === traceId);
    expect(new Set(inCollector.map((span) => span.spanId))).toEqual(new Set(answered.map((span) => span.spanId)));
    expect(inCollector.filter((span) => !span.parentSpanId)).toHaveLength(1);
    // Every crossing that touched the world: each effect, one span.
    const items = (await (await fetch(`${runtime.url}/v1/sessions/s1/items`, { headers })).json()) as {
      items: { type: string; turnId?: string }[];
    };
    const crossings = items.items.filter((item) =>
      ["message.assistant", "tool.completed"].includes(item.type),
    );
    expect(inCollector.length).toBe(crossings.length + 1);
  });

  it("gives the same span ids when the log is exported again, or read from the route", async () => {
    const receiver = await otlpReceiver();
    cleanups.push(() => receiver.close());
    const again = await startTestProjector({ tenantId: runtime.tenantId, root: runtime.root, slot: copy, url: receiver.url, content: new Set(["user", "outputs", "tool-results", "errors"]) });
    const answered = await route(first);
    await until("the re-export", () => receiver.spans.filter((span) => span.traceId === answered[0]!.traceId).length >= answered.length);
    await again.close();
    const reexported = receiver.spans.filter((span) => span.traceId === answered[0]!.traceId);
    expect(reexported.map((span) => span.spanId)).toEqual(answered.map((span) => span.spanId));
    const collectedIds = new Set(collected().filter((span) => span.traceId === answered[0]!.traceId).map((span) => span.spanId));
    expect(new Set(reexported.map((span) => span.spanId))).toEqual(collectedIds);
  });

  it("runs turns while the collector is down, drops only their spans, and keeps no WAL for it", async () => {
    collector("stop");
    try {
      const before = await currentLsn(runtime.tenantId);
      const ended = await turn();
      expect(ended.status, ended.error).toBe("completed");
      await until("the drop to be logged", () => logged.some((entry) => entry.message === "trace_export_dropped"), 60_000);
      await until("the slot to move past the turn", async () => {
        const confirmed = await confirmedOf(runtime.tenantId, slot);
        return (
          confirmed !== null &&
          (await lsnAtLeast(runtime.tenantId, confirmed, before)) &&
          projector.projector.status().pendingTxs === 0
        );
      }, 60_000);
      expect((await route(ended.turnId)).length).toBeGreaterThan(1);
    } finally {
      collector("start");
    }
    await until("the collector to answer again", collectorUp, 60_000);
    // Later turns are exported again.
    const ended = await turn();
    const answered = await route(ended.turnId);
    await until("the next turn in the collector", () => collected().some((span) => span.traceId === answered[0]!.traceId && !span.parentSpanId), 30_000);
  });

  it("puts no credential value, prompt, person's id, key or idempotency key in any span", async () => {
    const text = readFileSync(join(otel.dir, "traces.jsonl"), "utf8");
    expect(text.length).toBeGreaterThan(0);
    for (const secret of [MCP_TOKEN, APP, OWNER, PROMPT, "instructions-r7-exit-8e3f", IDEMPOTENCY, EGRESS_TOKEN])
      expect(text).not.toContain(secret);
    // Content was opted in, so the turn's output is there: the scan reads the spans it should.
    expect(text).toContain("shipped");
  });
});
