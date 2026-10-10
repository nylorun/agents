/**
 * The harness service over WebSocket (F6.2): the Harness API listener accepts only the harness
 * credential, on its path, with its header and an allowed Host; and a harness process with its
 * own sandbox and no store runs a turn with `bash`, claims its sandbox events, serves the
 * session's sandbox routes, and leaves them `503` once it is gone.
 */
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Agent } from "@nylorun/core/define";
import type { ModelProvider } from "../../src/core/provider.js";
import type { ModelGate } from "../../src/gates/model-gate.js";
import { startHarnessListener, type HarnessListener } from "../../src/harness-api/ws-server.js";
import { startHarnessService, type HarnessService } from "../../src/harness/service.js";
import { withTestSessionStore } from "../support/store.js";
import { APP, boot, server, type Started } from "../host/execution-support.js";

const TOKEN = "ab".repeat(32);
const logger = { info() {}, warn() {} };

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(runtime: Started | undefined): Promise<HarnessListener> {
  const listener = await startHarnessListener({
    host: "127.0.0.1",
    port: 0,
    allowedHosts: ["runtime:4200"],
    token: TOKEN,
    attach: async () => (runtime ? (channel, peer) => runtime.handle.attachHarness!(channel, peer) : undefined),
    logger,
  });
  cleanups.push(() => listener.close());
  return listener;
}

/** The status of an upgrade: 101 when the socket opened. */
function upgrade(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("open", () => {
      socket.close();
      resolve(101);
    });
    socket.once("unexpected-response", (_request, response) => {
      resolve(response.statusCode ?? 0);
      socket.terminate();
    });
    socket.once("error", (error) => {
      if (socket.readyState !== WebSocket.CLOSED) reject(error);
    });
  });
}

const good = { authorization: `Bearer ${TOKEN}`, "nylorun-harness-api": "1" };

it("accepts only the harness credential, on its path, with its header and an allowed Host", async () => {
  const runtime = await boot({ harness: "remote" });
  cleanups.push(() => runtime.close());
  const listener = await listen(runtime);
  const base = listener.url.replace(/\/nylorun\/harness\/v1$/, "");

  expect(await upgrade(listener.url, good)).toBe(101);
  expect(await upgrade(listener.url, { "nylorun-harness-api": "1" })).toBe(401);
  expect(await upgrade(listener.url, { ...good, authorization: `Bearer ${"cd".repeat(32)}` })).toBe(401);
  // The Tenant's own credentials are not the harness's.
  expect(await upgrade(listener.url, { ...good, authorization: `Bearer ${APP}` })).toBe(401);
  expect(await upgrade(listener.url, { authorization: good.authorization })).toBe(426);
  expect(await upgrade(`${base}/v1/sessions`, good)).toBe(404);
  expect(await upgrade(listener.url, { ...good, host: "evil.example:4200" })).toBe(421);
  expect(await upgrade(listener.url, { ...good, host: "runtime:4200" })).toBe(101);
  // A plain request gets nothing.
  expect(
    (await fetch(`${base.replace(/^ws/, "http")}/v1/sessions`, { headers: { authorization: good.authorization } })).status
  ).toBe(426);

  // The Tenant API knows nothing of the harness credential.
  for (const path of ["/v1/sessions", "/v1/tenant"])
    expect((await fetch(`${runtime.url}${path}`, { headers: { authorization: good.authorization } })).status).toBe(
      401
    );

  // Without an open Tenant the listener answers 503.
  const closed = await listen(undefined);
  expect(await upgrade(closed.url, good)).toBe(503);
});

/** A model that runs `bash` once, then answers with the result it saw. */
const bashOnce: ModelProvider = async (effect) => {
  const prompt = (effect.input as { prompt?: { kind?: string }[] }).prompt ?? [];
  if (prompt.at(-1)?.kind === "tool-result") return { output: [{ type: "text", text: "done" }] };
  return {
    output: [{ type: "tool-call", id: "call-1", name: "bash", args: { command: "echo hi > note.txt && cat note.txt" } }],
  };
};

it("runs a turn with bash in a harness service with its own sandbox and no store", async () => {
  const runtime = await boot({ harness: "remote", modelProvider: bashOnce });
  cleanups.push(() => runtime.close());
  const listener = await listen(runtime);
  const root = await mkdtemp(join(tmpdir(), "nylorun-harness-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const paths = { sandboxes: join(root, "sandboxes") };
  const service: HarnessService = startHarnessService({
    url: listener.url,
    token: TOKEN,
    paths,
    modelGate: {} as ModelGate,
    modelProvider: bashOnce,
    useVaultModel: false,
    toolGate: { recovers: false },
    logger,
  });
  let stopped = false;
  cleanups.push(() => (stopped ? undefined : service.stop(1_000)));
  await service.client.ready;

  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${runtime.url}${path}`, {
      method,
      // The Tenant's status is the Management API's (protocol 8).
      headers: path.startsWith("/v1/tenant") ? runtime.managementHeaders() : server,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const status = await api("GET", "/v1/tenant");
  expect(status.body.harness).toEqual({ mode: "remote", connected: 1, workspace: true });

  const agent = Agent({ id: "bot", name: "Bot" }).instructions("Use the sandbox.").build();
  expect((await api("PUT", "/v1/agents/bot", { requestId: "a", manifest: agent.manifest, implementationVersion: "dev" })).status).toBe(200);
  expect((await api("PUT", "/v1/sessions/s1", { requestId: "s", agentId: "bot", ownerUserId: "u", sandbox: {} })).status).toBe(200);
  await api("POST", "/v1/sessions/s1/commands", { type: "message", requestId: "m", idempotencyKey: "m", content: "go" });
  let view: any;
  for (let i = 0; i < 400; i += 1) {
    view = (await api("GET", "/v1/sessions/s1")).body;
    if (["completed", "failed", "uncertain"].includes(view.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(view.status).toBe("completed");

  // The harness's sandbox events are in the session's log, and its workspace's row in core's table.
  const items = (await api("GET", "/v1/sessions/s1/items")).body.items as { type: string; payload: any }[];
  expect(items.filter((item) => item.type === "sandbox.state").map((item) => item.payload.state)).toEqual([
    "creating",
    "running",
  ]);
  expect(items.find((item) => item.type === "sandbox.exec")?.payload).toMatchObject({ tool: "bash", outcome: "completed" });
  const rows = await withTestSessionStore(runtime, (store) => store.tx((t) => t.listSandboxes<any>()));
  expect(rows).toEqual([expect.objectContaining({ sessionId: "s1", state: "running", backend: "virtual" })]);

  // The workspace lives in the harness's directory; the Runtime's own holds none.
  expect(existsSync(join(paths.sandboxes, "records.json"))).toBe(true);
  expect(readdirSync(paths.sandboxes).filter((name) => name.startsWith("nylorun-"))).toEqual([rows[0].key]);
  const runtimeSandboxes = join(runtime.root, "tenant", "sandboxes");
  expect(existsSync(runtimeSandboxes) ? readdirSync(runtimeSandboxes) : []).toEqual([]);

  // The session's sandbox route goes to the harness's workspace.
  const read = await api("POST", "/v1/sessions/s1/sandbox/read", { path: "note.txt" });
  expect(read.status).toBe(200);
  expect(JSON.stringify(read.body)).toContain("hi");

  // The Tenant sweep keeps the workspace of a session that exists.
  await (runtime.handle as { worker?: { sweep(): Promise<void> } }).worker!.sweep();
  expect(readdirSync(paths.sandboxes).filter((name) => name.startsWith("nylorun-"))).toEqual([rows[0].key]);

  // Without a harness serving workspaces, the route is refused.
  await service.stop(1_000);
  stopped = true;
  for (let i = 0; i < 100 && (await api("GET", "/v1/tenant")).body.harness.connected > 0; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 20));
  const refused = await api("POST", "/v1/sessions/s1/sandbox/read", { path: "note.txt" });
  expect(refused.status).toBe(503);
  expect(refused.body).toMatchObject({ code: "request_rejected" });
});
