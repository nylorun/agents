/**
 * A computer restored mid-session (ADR-149): the harness, a service over a loopback WebSocket
 * with its own SandboxManager per computer (`harness/service.ts`), keeps the access
 * `computer.open` answered. A restore gives the computer a new volume and a new pod name
 * (`-g0` → `-g1`); the next `bash` of the same session must reach the new volume, not the last
 * one, which the gateway here still serves (as Substrate may, until the old actor is deleted).
 */
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import { localBackend } from "../../src/adapters/sandbox/local.js";
import type { ModelProvider } from "../../src/core/provider.js";
import { computerHandler } from "../../src/harness/computer.js";
import { podName } from "../../src/sandbox/pods/name.js";
import type { ExecRequest, SandboxHandle } from "../../src/sandbox/types.js";
import { fakeSandboxes, type FakeSandboxes } from "../support/fake-sandboxes.js";
import { startTestTenant } from "../support/tenant.js";
import { manifestOf, saveManifest } from "../support/agents.js";

const APP = "computer-restore-app-key-aaaaaaaaa";
const KEK = Buffer.alloc(32, 6).toString("base64");

let runtime: Awaited<ReturnType<typeof startTestTenant>>;
let fake: FakeSandboxes;
let gateway: Server;
/** Every command each computer ran, by sandbox name. */
const ran = new Map<string, string[]>();
/** Each computer's workspace on this machine, by sandbox name. */
const workspaces = new Map<string, string>();

/** The command the next turn's one `bash` call runs, and what the last one printed. */
let command = "true";
let printed = "";
const model: ModelProvider = async (effect) => {
  const prompt = (effect.input as { prompt?: { kind?: string; content?: unknown }[] }).prompt ?? [];
  const last = prompt.at(-1);
  if (last?.kind === "tool-result") {
    printed = JSON.stringify(last.content);
    return { output: [{ type: "text", text: "done" }] };
  }
  return { output: [{ type: "tool-call", id: `call-${effect.turnId}`, name: "bash", args: { command } }] };
};

const headers = { authorization: `Bearer ${APP}`, "content-type": "application/json" };
const bot = Agent({ id: "bot", name: "Bot" }).instructions("Work in the sandbox.").build();

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${runtime.url}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}
const path = (id: string) => `/v1/agents/${encodeURIComponent(id)}`;
const view = async (id: string) => (await call("GET", path(id))).body;

async function until<T>(what: string, read: () => Promise<T>, ok: (value: T) => boolean, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`${what}: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

let messages = 0;
/** Sends a message to session `sessionId` and waits for its turn to end: its status. */
async function turn(sessionId: string): Promise<string> {
  messages += 1;
  const sent = await call("POST", `/v1/sessions/${sessionId}/commands`, {
    type: "message",
    requestId: `m${messages}`,
    idempotencyKey: `m${messages}`,
    content: "run it",
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  const done = await until(
    "the turn ends",
    async () => (await call("GET", `/v1/sessions/${sessionId}`)).body,
    (body) => ["completed", "failed", "cancelled"].includes(body.status) && body.activeTurnId === null,
    30_000,
  );
  return done.status as string;
}

/** A computer's handle: a local workspace with `/workspace` and `/harness` mapped onto it. */
function computerHandle(name: string, local: SandboxHandle, root: string): SandboxHandle {
  const mapped = (file: string) =>
    file.replace(/^\/workspace(?=\/|$)/, join(root, "workspace")).replace(/^\/harness(?=\/|$)/, join(root, "harness"));
  return new Proxy(local, {
    get(target, prop) {
      if (prop === "exec")
        return async (request: ExecRequest, signal: AbortSignal) => {
          ran.set(name, [...(ran.get(name) ?? []), request.command]);
          return target.exec({ ...request, cwd: mapped(request.cwd) }, signal);
        };
      if (prop === "readFile" || prop === "readBytes" || prop === "writeFile" || prop === "listFiles")
        return (file: string, ...rest: unknown[]) => (target as any)[prop](mapped(file), ...rest);
      if (prop === "workspace") return "/workspace";
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

beforeAll(async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const handlers = new Map<string, Promise<ReturnType<typeof computerHandler>>>();
  const handlerOf = (name: string) => {
    let handler = handlers.get(name);
    if (!handler) {
      handler = (async () => {
        const root = mkdtempSync(join(tmpdir(), "computer-restore-"));
        mkdirSync(join(root, "workspace"));
        mkdirSync(join(root, "harness"));
        workspaces.set(name, join(root, "workspace"));
        const local = await localBackend({
          env: { PATH: process.env.PATH },
          workspace: join(root, "workspace"),
          harnessRoot: join(root, "harness"),
          shell: "/bin/sh",
        }).open({ key: name, cpus: 1, memoryMiB: 512, network: { preset: "none", hosts: [], suffixes: [] } });
        return computerHandler({ handle: computerHandle(name, local, root), key: publicKey, name, ready: () => true });
      })();
      handlers.set(name, handler);
    }
    return handler;
  };
  // The sandbox gateway: `/<sandbox>/<route>` to that computer's routes, the last ones included.
  gateway = createServer((request, response) => {
    const match = /^\/([^/?]+)(.*)$/.exec(request.url ?? "/");
    if (!match) return void response.writeHead(404).end();
    request.url = match[2]!.startsWith("/") ? match[2]! : `/${match[2]!}`;
    void handlerOf(match[1]!).then((handler) => handler(request, response));
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  fake = fakeSandboxes();
  runtime = await startTestTenant({
    applicationKey: APP,
    vaultKek: KEK,
    modelProvider: model,
    sandbox: { backend: "virtual" },
    // The harness as a service: its own SandboxManager per computer, no store.
    harness: "ws",
    sweepIntervalMs: 1_000,
    pods: {
      client: fake,
      harnessImage: "nylorun-runtime:test",
      computer: {
        gatewayUrl: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`,
        ticketKey: privateKey,
        // Long enough that no ticket is renewed during the test: only the restore moves it.
        ttlMs: 600_000,
      },
    },
  });
}, 60_000);

afterAll(async () => {
  await runtime?.close();
  await new Promise((resolve) => gateway?.close(resolve));
});

describe("a computer restored mid-session", { timeout: 90_000 }, () => {
  it("sends the session's next bash to the new volume, not the last one", async () => {
    const id = "restore/one";
    await saveManifest(runtime.url, headers, manifestOf(bot, { name: "restore-one", runtime: { kind: "pod" } }));
    const made = await until("created", () => call("PUT", path(id), { manifest: "restore-one" }), (reply) => reply.status !== 409);
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    const opened = await call("PUT", "/v1/sessions/restore-s1", { requestId: "open-restore-s1", agent: id, ownerUserId: "app:ada" });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);

    // The first turn opens the computer through the harness, which keeps its access.
    const first = podName(runtime.handle.envelope.id, id, 0);
    command = "echo one > first.txt";
    expect(await turn("restore-s1")).toBe("completed");
    expect(readFileSync(join(workspaces.get(first)!, "first.txt"), "utf8")).toBe("one\n");

    const snapshot = await call("POST", `${path(id)}/snapshot`);
    expect(snapshot.status, JSON.stringify(snapshot.body)).toBe(201);
    const restored = await call("POST", `${path(id)}/restore`, { version: 1 });
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(restored.body).toMatchObject({ volumeGeneration: 1 });
    await until("seeded", () => view(id), (body) => body.disk.operation === null, 30_000);

    // The same session's next bash reaches the restored volume, with the version's file on it.
    const next = podName(runtime.handle.envelope.id, id, 1);
    const before = ran.get(first)?.length ?? 0;
    command = "echo two > second.txt; cat first.txt";
    expect(await turn("restore-s1")).toBe("completed");
    expect(readFileSync(join(workspaces.get(next)!, "second.txt"), "utf8")).toBe("two\n");
    expect(printed).toContain("one");
    expect(existsSync(join(workspaces.get(first)!, "second.txt"))).toBe(false);
    expect((ran.get(first) ?? []).slice(before)).toEqual([]);
  });
});
