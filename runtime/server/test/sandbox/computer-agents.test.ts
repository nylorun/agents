/**
 * Computer Agents in the Runtime (ADR-149, ADR-154) against an in-memory sandboxes service
 * (`fake-sandboxes.ts`) and a sandbox gateway that serves each computer's routes
 * (`harness/computer.ts`) from a local workspace:
 *
 * - R3: a turn does not wake a sleeping computer; its first command does, and a failed one is
 *   still asked to run by a turn.
 * - D1: an idle suspend measures the disk first (`diskBytes` on `agent.suspended`), and a wake
 *   logs how long it waited.
 * - R13: a `virtual` Agent becomes a computer with an explicit `PUT`, keeping its sessions,
 *   memory, vault and triggers, seeded from another Agent's disk version; a save alone does not
 *   move it, and every refusal.
 * - Disk versions copy the computer's own disk (`POST /v1/disk`): a snapshot holds its files, and
 *   a restore and a seed write them onto the computer's new volume, never this machine's.
 */
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import type { RuntimeSection } from "@nylorun/core/contracts";
import { localBackend } from "../../src/adapters/sandbox/local.js";
import { computerHandler } from "../../src/harness/computer.js";
import { DISK_MEASURE_COMMAND } from "../../src/sandbox/computer.js";
import { podName } from "../../src/sandbox/pods/name.js";
import type { ExecRequest, SandboxHandle } from "../../src/sandbox/types.js";
import type { Logger } from "../../src/tenant/types.js";
import { fakeSandboxes, type FakeSandboxes } from "../support/fake-sandboxes.js";
import { startTestTenant } from "../support/tenant.js";
import { testTenantPool } from "../support/store.js";
import { manifestOf, saveManifest } from "../support/agents.js";

const APP = "computer-agents-app-key-aaaaaaaaaaa";
const KEK = Buffer.alloc(32, 5).toString("base64");

let runtime: Awaited<ReturnType<typeof startTestTenant>>;
/** While set, model calls wait for it: a turn that keeps running. */
let gate: Promise<void> | undefined;
let fake: FakeSandboxes;
let gateway: Server;
/** Every command each computer ran, by sandbox name. */
const ran = new Map<string, string[]>();
/** Each computer's workspace on this machine, by sandbox name. */
const workspaces = new Map<string, string>();
const logged: { message: string; fields?: Record<string, unknown> }[] = [];
const logger: Logger = {
  info: (message, fields) => void logged.push({ message, ...(fields ? { fields } : {}) }),
  warn: (message, fields) => void logged.push({ message, ...(fields ? { fields } : {}) }),
  error: () => undefined,
};

const headers = { authorization: `Bearer ${APP}`, "content-type": "application/json" };
const bot = Agent({ id: "bot", name: "Bot" }).instructions("Answer.").build();
const save = (name: string, section: RuntimeSection, options: { memory?: boolean } = {}) =>
  saveManifest(
    runtime.url,
    headers,
    manifestOf(bot, {
      name,
      runtime: section,
      ...(options.memory ? { memory: { access: "read_write" as const, instructions: "Keep notes." } } : {}),
    }),
  );

async function call(method: string, path: string, body?: unknown, management = false): Promise<{ status: number; body: any }> {
  const response = await fetch(`${runtime.url}${path}`, {
    method,
    headers: { ...headers, ...(management ? { authorization: `Bearer ${runtime.managementKey}` } : {}) },
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
const events = async (id: string) =>
  ((await call("GET", `${path(id)}/events`)).body.events as { type: string; payload: any }[]);

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
async function send(sessionId: string): Promise<void> {
  messages += 1;
  const sent = await call("POST", `/v1/sessions/${sessionId}/commands`, {
    type: "message",
    requestId: `m${messages}`,
    idempotencyKey: `m${messages}`,
    content: "hello",
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
}
async function message(sessionId: string): Promise<void> {
  await send(sessionId);
  await until("the turn ends", async () => (await call("GET", `/v1/sessions/${sessionId}`)).body, (body) =>
    ["completed", "failed", "cancelled"].includes(body.status) && body.activeTurnId === null, 30_000);
}
async function open(sessionId: string, agent: string): Promise<void> {
  const opened = await call("PUT", `/v1/sessions/${sessionId}`, { requestId: `open-${sessionId}`, agent, ownerUserId: "app:ada" });
  expect(opened.status, JSON.stringify(opened.body)).toBe(200);
}
const bash = (sessionId: string, command: string) => call("POST", `/v1/sessions/${sessionId}/sandbox/bash`, { command });

/** A computer's handle: a local workspace, with `/workspace` mapped onto it and the disk measure answered. */
function computerHandle(name: string, local: SandboxHandle, root: string): SandboxHandle {
  const mapped = (path: string) => path.replace(/^\/workspace(?=\/|$)/, join(root, "workspace")).replace(/^\/harness(?=\/|$)/, join(root, "harness"));
  return new Proxy(local, {
    get(target, prop) {
      if (prop === "exec")
        return async (request: ExecRequest, signal: AbortSignal) => {
          ran.set(name, [...(ran.get(name) ?? []), request.command]);
          if (request.command === DISK_MEASURE_COMMAND)
            return { exitCode: 0, stdout: "12\t/workspace\n4\t/skills\n", stderr: "", killed: false, timedOut: false };
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
        const root = mkdtempSync(join(tmpdir(), "computer-agent-"));
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
  // The sandbox gateway: `/<sandbox>/<route>` to that computer's routes.
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
    modelProvider: async () => {
      await gate;
      return { output: [{ type: "text", text: "no command" }] };
    },
    sandbox: { backend: "virtual" },
    logger,
    // The Tenant sweep writes pending seeds, through each computer's own disk route.
    sweepIntervalMs: 1_000,
    pods: {
      client: fake,
      harnessImage: "nylorun-runtime:test",
      computer: {
        gatewayUrl: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`,
        ticketKey: privateKey,
        ttlMs: 600_000,
      },
    },
  });
  expect((await call("PUT", "/v1/tenant/sandbox", { requestId: "cfg", limits: { idle: "2s" } }, true)).status).toBe(200);
}, 60_000);

afterAll(async () => {
  await runtime?.close();
  await new Promise((resolve) => gateway?.close(resolve));
});

/** A computer Agent `id`, running, then suspended as idle (the Tenant's idle is 2 s). */
async function sleepingComputer(id: string, manifest: string): Promise<string> {
  await save(manifest, { kind: "pod" });
  const made = await until("created", () => call("PUT", path(id), { manifest }), (reply) => reply.status !== 409);
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  await until("idle suspended", () => view(id), (body) => body.compute.pod.desired === "suspended" && body.compute.pod.observed === "suspended", 30_000);
  return nameOf(id);
}
/** The sandbox name of Agent `id`'s first computer. */
const nameOf = (id: string) => podName(runtime.handle.envelope.id, id, 0);

describe("a computer wakes on its first command (R3)", { timeout: 90_000 }, () => {
  it("measures the disk before an idle suspend (D1)", async () => {
    await sleepingComputer("wake/one", "wake-one");
    const suspended = (await events("wake/one")).find((event) => event.type === "agent.suspended");
    expect(suspended?.payload).toEqual({ reason: "idle", diskBytes: 16 * 1024 });
    expect(logged.find((line) => line.message === "computer suspended")?.fields).toEqual({ agentId: "wake/one", diskBytes: 16 * 1024 });
  });

  it("runs a turn without waking a sleeping computer, and wakes it for its first command", async () => {
    await open("wake-s1", "wake/one");
    const before = (await events("wake/one")).length;
    await message("wake-s1");
    expect((await call("GET", "/v1/sessions/wake-s1")).body.status).toBe("completed");
    const slept = await view("wake/one");
    expect(slept.compute.pod).toMatchObject({ desired: "suspended", observed: "suspended" });
    expect((await events("wake/one")).slice(before).map((event) => event.type)).not.toContain("agent.running");

    // The first command wakes it, and the wake is logged with how long it waited.
    const answer = await bash("wake-s1", "echo awake > woke.txt; cat woke.txt");
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(JSON.stringify(answer.body)).toContain("awake");
    expect((await view("wake/one")).compute.pod).toMatchObject({ desired: "running", observed: "running" });
    const ready = logged.find((line) => line.message === "computer ready" && line.fields?.agentId === "wake/one");
    expect(ready?.fields?.waitedMs).toEqual(expect.any(Number));

    // Running, a turn counts as use: it stays running.
    await message("wake-s1");
    expect((await view("wake/one")).compute.pod.desired).toBe("running");
  });

  it("asks a failed computer to run at the next turn", async () => {
    await sleepingComputer("wake/failed", "wake-failed");
    await testTenantPool(runtime.tenantId)`UPDATE nylorun.agents SET observed = 'failed', reason = 'Crashed: test' WHERE id = 'wake/failed'`;
    await open("wake-s2", "wake/failed");
    await message("wake-s2");
    await until("asked to run", () => view("wake/failed"), (body) => body.compute.pod.desired === "running");
  });
});

describe("disk versions of a computer", { timeout: 90_000 }, () => {
  it("snapshots the computer's own disk, and restores it onto its new volume", async () => {
    await sleepingComputer("disk/computer", "disk-computer");
    await open("disk-computer-s", "disk/computer");
    const wrote = await bash("disk-computer-s", "mkdir -p app && echo kept > app/notes.txt && chmod 640 app/notes.txt");
    expect(wrote.status, JSON.stringify(wrote.body)).toBe(200);
    const name = nameOf("disk/computer");
    writeFileSync(join(dirname(workspaces.get(name)!), "harness", "volume-id"), `${name}\n`);

    const snapshot = await call("POST", `${path("disk/computer")}/snapshot`);
    expect(snapshot.status, JSON.stringify(snapshot.body)).toBe(201);
    expect(snapshot.body).toMatchObject({ version: 1, files: 1, unchanged: false });
    const tree = JSON.stringify((await call("GET", `/v1/artifacts/${snapshot.body.artifactId}/versions/1/tree`)).body);
    expect(tree).toContain("workspace/app/notes.txt");
    expect(tree).not.toContain("volume-id");

    // A file written after the version is gone once it is restored onto the new volume.
    expect((await bash("disk-computer-s", "echo later > later.txt")).status).toBe(200);
    const restored = await call("POST", `${path("disk/computer")}/restore`, { version: 1 });
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(restored.body).toMatchObject({ restored: 1, status: "pending", volumeGeneration: 1 });
    await until("seeded", () => view("disk/computer"), (body) => body.disk.operation === null, 30_000);
    const next = podName(runtime.handle.envelope.id, "disk/computer", 1);
    const workspace = workspaces.get(next)!;
    expect(readFileSync(join(workspace, "app", "notes.txt"), "utf8")).toBe("kept\n");
    expect(statSync(join(workspace, "app", "notes.txt")).mode & 0o777).toBe(0o640);
    expect(existsSync(join(workspace, "later.txt"))).toBe(false);
  });
});

describe("a virtual Agent becomes a computer (R13)", { timeout: 90_000 }, () => {
  /** A virtual Agent `id` of manifest `manifest`, with a session, a memory, a secret and a trigger. */
  async function virtualAgent(id: string, manifest: string): Promise<void> {
    await save(manifest, { kind: "virtual" }, { memory: true });
    expect((await call("PUT", path(id), { manifest, owner: "app:ada" })).status).toBe(200);
    expect((await call("PUT", `${path(id)}/memories/notes.md`, { content: "remember this" })).status).toBe(200);
    expect((await call("PUT", `${path(id)}/secrets/REGION`, { type: "environment_variable", value: "eu-west-1" })).status).toBe(200);
    const trigger = await call("PUT", `${path(id)}/triggers/weekly`, { schedule: "0 9 * * 1", session: "new", prompt: "Report." });
    expect(trigger.status, JSON.stringify(trigger.body)).toBe(200);
  }

  it("keeps its sessions, memory, vault and triggers, seeded from another Agent's disk version", async () => {
    // The source: a virtual Agent with a file in its disk's version 1.
    await save("move-source", { kind: "virtual" });
    expect((await call("PUT", path("move/source"), { manifest: "move-source", owner: "app:ada" })).status).toBe(200);
    await open("move-src-s", "move/source");
    expect((await call("POST", "/v1/sessions/move-src-s/sandbox/write", { path: "seeded.txt", content: "from the source\n" })).status).toBe(200);
    expect((await call("POST", `${path("move/source")}/snapshot`)).status).toBe(201);

    await virtualAgent("move/bot", "move-bot");
    await open("move-s1", "move/bot");
    await message("move-s1");

    // A save of a pod version moves nothing: the Agent stays virtual on version 1.
    await save("move-bot", { kind: "pod" }, { memory: true });
    expect((await view("move/bot")).kind).toBe("virtual");
    expect((await view("move/bot")).resolvedVersion).toBe(1);

    const moved = await call("PUT", path("move/bot"), { manifest: "move-bot", from: { agent: "move/source", version: 1 } });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body).toMatchObject({ kind: "pod", resolvedVersion: 2, compute: { pod: { desired: "running" } } });
    expect(moved.body.disk.operation).toMatchObject({ kind: "seed", version: 1 });
    const changed = (await events("move/bot")).find((event) => event.type === "agent.version_changed");
    expect(changed?.payload).toEqual({ from: 1, to: 2, kindFrom: "virtual", kindTo: "pod" });

    // What it keeps.
    expect((await call("GET", "/v1/sessions/move-s1")).body.agentId).toBe("move/bot");
    expect((await call("GET", `${path("move/bot")}/memories/notes.md`)).body.content).toBe("remember this");
    expect((await call("GET", `${path("move/bot")}/secrets`)).body.secrets.map((secret: { name: string }) => secret.name)).toEqual(["REGION"]);
    expect((await call("GET", `${path("move/bot")}/triggers`)).body.triggers.map((trigger: { id: string }) => trigger.id)).toContain("weekly");

    // The seed is written onto the computer's own disk (the sweep, or its first open in a harness).
    const name = nameOf("move/bot");
    expect(fake.sandboxes.has(name)).toBe(true);
    await until("seeded", () => view("move/bot"), (body) => body.disk.operation === null);
    expect(readFileSync(join(workspaces.get(name)!, "seeded.txt"), "utf8")).toBe("from the source\n");

    // Its session's next command runs on the computer.
    const answer = await bash("move-s1", "echo on the computer");
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(JSON.stringify(answer.body)).toContain("on the computer");
    expect(ran.get(name)).toContain("echo on the computer");
    await message("move-s1");
    expect((await call("GET", "/v1/sessions/move-s1")).body.status).toBe("completed");
  });

  it("refuses while a turn runs, another kind change, and a from of another owner", async () => {
    await virtualAgent("move/busy", "move-busy");
    await save("move-busy", { kind: "pod" }, { memory: true });
    await open("move-busy-s", "move/busy");
    let release!: () => void;
    gate = new Promise((resolve) => (release = resolve));
    try {
      await send("move-busy-s");
      await until("the turn runs", async () => (await call("GET", "/v1/sessions/move-busy-s")).body, (body) => body.activeTurnId !== null);
      const busy = await call("PUT", path("move/busy"), { manifest: "move-busy" });
      expect(busy.status).toBe(409);
      expect(busy.body.code).toBe("agent_busy");
      expect((await view("move/busy")).kind).toBe("virtual");
    } finally {
      release();
      gate = undefined;
    }
    await until("the turn ends", async () => (await call("GET", "/v1/sessions/move-busy-s")).body, (body) => body.activeTurnId === null);
    expect((await call("PUT", path("move/busy"), { manifest: "move-busy" })).body.kind).toBe("pod");

    // From a pod back to virtual: fixed.
    await sleepingComputer("move/pod", "move-pod");
    await save("move-pod", { kind: "virtual" });
    const back = await call("PUT", path("move/pod"), { manifest: "move-pod@2" });
    expect(back.status).toBe(409);
    expect(back.body).toMatchObject({ code: "agent_fixed_field", details: { fields: [{ field: "kind", from: "pod", to: "virtual" }] } });

    // A disk version of an Agent with another owner.
    await save("move-other", { kind: "virtual" });
    expect((await call("PUT", path("move/other"), { manifest: "move-other", owner: "app:bob" })).status).toBe(200);
    await virtualAgent("move/guarded", "move-guarded");
    await save("move-guarded", { kind: "pod" }, { memory: true });
    const other = await call("PUT", path("move/guarded"), { manifest: "move-guarded", from: { agent: "move/source", version: 1 } });
    expect(other.status).toBe(200);
    await virtualAgent("move/guarded2", "move-guarded2");
    await save("move-guarded2", { kind: "pod" }, { memory: true });
    await call("PUT", "/v1/sessions/move-other-s", { requestId: "open-move-other-s", agent: "move/other", ownerUserId: "app:bob" });
    await call("POST", "/v1/sessions/move-other-s/sandbox/write", { path: "x.txt", content: "x" });
    expect((await call("POST", `${path("move/other")}/snapshot`)).status).toBe(201);
    const refused = await call("PUT", path("move/guarded2"), { manifest: "move-guarded2", from: { agent: "move/other", version: 1 } });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("agent_owner_mismatch");
    expect((await view("move/guarded2")).kind).toBe("virtual");

    // from on an existing Agent whose kind does not change.
    const plain = await call("PUT", path("move/source"), { manifest: "move-source", from: { agent: "move/bot", version: 1 } });
    expect(plain.status).toBe(409);
  });
});
