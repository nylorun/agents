/**
 * Disk versions of a pod Environment (R2d step 3) against an in-memory sandboxes service: a
 * snapshot copies the volume through the pod's engine (`/workspace` and `/harness`, not the
 * engine's own files); a restore gives the pod a new volume, seeded from the version once its
 * engine connects, and turns wait for it; a lost volume with a version is recovered from the
 * latest one instead of refusing turns.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import type { ModelProvider } from "../../src/core/provider.js";
import { localBackend } from "../../src/adapters/sandbox/local.js";
import { startHarnessListener, type HarnessListener } from "../../src/harness-api/ws-server.js";
import { podHost } from "../../src/harness/pod.js";
import { startHarnessService, type HarnessService } from "../../src/harness/service.js";
import { HostAuthError, type HostAuthority } from "../../src/sandbox/join.js";
import { podName } from "../../src/sandbox/pods/name.js";
import { fakeSandboxes, type FakeSandboxes } from "../support/fake-sandboxes.js";
import { startTestTenant } from "../support/tenant.js";

const APP = "disk-pods-app-key-aaaaaaaaaaaaaaa";
const KEK = Buffer.alloc(32, 7).toString("base64");

let runtime: Awaited<ReturnType<typeof startTestTenant>>;
let fake: FakeSandboxes;
let hosts: HostAuthority;
let listener: HarnessListener;
let tenantId: string;

/** The pod engine's model: one bash call per turn, then a text answer with what it printed. */
const podModel: ModelProvider = async (effect) => {
  const prompt = (effect.input as { prompt?: { kind?: string; content?: unknown }[] }).prompt ?? [];
  const last = prompt.at(-1);
  if (last?.kind === "tool-result") return { output: [{ type: "text", text: `ran: ${JSON.stringify(last.content)}` }] };
  return {
    output: [{ type: "tool-call", id: `call-${effect.turnId}`, name: "bash", args: { command: "echo pod > from-pod.txt; pwd" } }],
  };
};
/** The Runtime's own harness answers without tools: a turn it ran would write nothing. */
const coreModel: ModelProvider = async () => ({ output: [{ type: "text", text: "core" }] });

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${runtime.url}${path}`, {
    method,
    headers: {
      // The Tenant's settings are the Management API's (protocol 8).
      authorization: `Bearer ${path.startsWith("/v1/tenant") ? runtime.managementKey : APP}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}
const path = (id: string) => `/v1/environments/${encodeURIComponent(id)}`;

async function until<T>(what: string, read: () => Promise<T>, ok: (value: T) => boolean, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`${what}: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
const view = async (id: string) => (await call("GET", path(id))).body;
const events = async (id: string) =>
  ((await call("GET", `${path(id)}/events`)).body.events as { type: string; payload: any }[]).map((event) => event.type);
const reconcile = (id: string) => runtime.handle.worker!.sandbox!(id, "reconcile", new AbortController().signal);

let messages = 0;
async function message(sessionId: string) {
  messages += 1;
  return call("POST", `/v1/sessions/${sessionId}/commands`, {
    type: "message",
    requestId: `m${messages}`,
    idempotencyKey: `m${messages}`,
    content: "go",
  });
}
async function open(id: string, environmentId: string) {
  return call("PUT", `/v1/sessions/${id}`, { requestId: `open-${id}`, agentId: "bot", ownerUserId: "app:ada", environment: environmentId });
}
async function settled(sessionId: string): Promise<any> {
  return until("session settles", async () => (await call("GET", `/v1/sessions/${sessionId}`)).body, (body) =>
    ["completed", "failed", "cancelled"].includes(body.status), 60_000);
}

/** Creates a pod Environment and waits until the fake runs its pod. */
async function createPod(id: string, body: Record<string, unknown> = {}) {
  const created = await until("created", () => call("PUT", path(id), { kind: "pod", ...body }), (reply) => reply.status !== 409);
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const name = podName(tenantId, id, created.body.pod.volumeGeneration);
  await until("the pod runs", async () => fake.podUid(name), (uid) => uid !== undefined);
  return { name, view: created.body };
}

async function joinAs(id: string, name: string, podUid = fake.podUid(name)!) {
  return hosts.join({ sandboxId: id, podUid, joinToken: fake.joinToken(name)! });
}

beforeAll(async () => {
  fake = fakeSandboxes();
  runtime = await startTestTenant({
    applicationKey: APP,
    vaultKek: KEK,
    modelProvider: coreModel,
    sandbox: { backend: "virtual" },
    pods: { client: fake, harnessImage: "nylorun-runtime:test" },
  });
  hosts = runtime.handle.hostAuthority!()!;
  tenantId = runtime.handle.envelope.id;
  listener = await startHarnessListener({
    host: "127.0.0.1",
    port: 0,
    allowedHosts: [],
    attach: async () => (channel, peer) => runtime.handle.attachHarness!(channel, peer),
    hosts: async () => runtime.handle.hostAuthority?.(),
    logger: { info: () => undefined, warn: () => undefined },
  });
  const agent = Agent({ id: "bot", name: "Bot" }).instructions("Work in the sandbox.").build();
  expect((await call("PUT", "/v1/agents/bot", { requestId: "bot", manifest: agent.manifest, implementationVersion: "dev" })).status).toBe(200);
  expect(
    (await call("PUT", "/v1/tenant/sandbox", { requestId: "cfg", limits: { idle: "2s" } })).status,
  ).toBe(200);
});

afterAll(async () => {
  await listener?.close();
  await runtime?.close();
});

/** A pod's engine on fresh directories: its workspace and `/harness`. */
async function engine(id: string, name: string) {
  const workspace = await mkdtemp(join(tmpdir(), "nylorun-disk-ws-"));
  const harnessRoot = await mkdtemp(join(tmpdir(), "nylorun-disk-harness-"));
  // The join token is mounted outside the volume (`NYLORUN_SANDBOX_JOIN_FILE`).
  const secrets = await mkdtemp(join(tmpdir(), "nylorun-disk-join-"));
  const joinFile = join(secrets, "join-token");
  await writeFile(joinFile, fake.joinToken(name)!);
  await writeFile(join(harnessRoot, "volume-id"), `${name}\n`);
  const host = podHost(
    { sandboxId: id, podUid: fake.podUid(name)!, joinFile, httpUrl: listener.url.replace(/^ws/, "http").replace(/\/nylorun.*$/, ""), blocked: [] },
    { info: () => undefined, warn: () => undefined },
  );
  const service: HarnessService = startHarnessService({
    url: listener.url,
    token: () => host.token(),
    paths: { sandboxes: join(harnessRoot, "sandboxes") },
    modelGate: { call: async () => ({ kind: "failed", message: "no gate" }) as never },
    modelProvider: podModel,
    useVaultModel: false,
    toolGate: {},
    sandboxBackends: [localBackend({ workspace, harnessRoot, env: { PATH: process.env.PATH }, proxyEnv: () => host.proxyEnv() })],
    logger: { info: () => undefined, warn: () => undefined },
    name: "pod",
    backoff: { minMs: 50, maxMs: 200 },
  });
  await service.client.ready;
  return {
    workspace,
    harnessRoot,
    host,
    async stop() {
      host.stop();
      await service.stop(1_000);
      await rm(workspace, { recursive: true, force: true });
      await rm(harnessRoot, { recursive: true, force: true });
      await rm(secrets, { recursive: true, force: true });
    },
  };
}

describe("disk versions of a pod Environment", { timeout: 90_000 }, () => {
  it("snapshots through the engine, restores on a new seeded volume, and recovers a lost volume", async () => {
    const { name } = await createPod("disk/pod");
    const first = await engine("disk/pod", name);
    let second: Awaited<ReturnType<typeof engine>> | undefined;
    let third: Awaited<ReturnType<typeof engine>> | undefined;
    try {
      expect((await open("disk-pod-s1", "disk/pod")).status).toBe(200);
      expect((await message("disk-pod-s1")).status).toBe(200);
      expect((await settled("disk-pod-s1")).status).toBe("completed");
      await writeFile(join(first.workspace, "notes.txt"), "v1\n");
      await mkdir(join(first.harnessRoot, "codex"), { recursive: true });
      await writeFile(join(first.harnessRoot, "codex", "state.json"), "{}\n");

      const snapshot = await call("POST", `${path("disk/pod")}/snapshot`);
      expect(snapshot.status, JSON.stringify(snapshot.body)).toBe(201);
      expect(snapshot.body).toMatchObject({ version: 1, files: 3, unchanged: false });
      const tree = JSON.stringify((await call("GET", `/v1/artifacts/${snapshot.body.artifactId}/versions/1/tree`)).body);
      expect(tree).toContain("workspace/from-pod.txt");
      expect(tree).toContain("harness/codex/state.json");
      for (const own of ["volume-id", "sandboxes"]) expect(tree).not.toContain(`harness/${own}`);

      await writeFile(join(first.workspace, "notes.txt"), "v2\n");
      const restored = await call("POST", `${path("disk/pod")}/restore`, { version: 1 });
      expect(restored.status, JSON.stringify(restored.body)).toBe(200);
      expect(restored.body).toMatchObject({ restored: 1, status: "pending", volumeGeneration: 1 });
      expect((await view("disk/pod")).disk.operation).toMatchObject({ kind: "seed", version: 1 });
      // Its seed is not deleted while it is read.
      expect((await call("DELETE", `${path("disk/pod")}/versions/1`)).status).toBe(409);
      await first.stop();

      // A turn waits for the seed.
      expect((await message("disk-pod-s1")).status).toBe(200);
      const next = podName(tenantId, "disk/pod", 1);
      await until("the new pod runs", async () => fake.podUid(next), (uid) => uid !== undefined);
      second = await engine("disk/pod", next);
      expect(second.host.seeded).toBe(true);
      await until("seeded", () => view("disk/pod"), (body) => body.disk.operation === undefined);
      expect(await readFile(join(second.workspace, "notes.txt"), "utf8")).toBe("v1\n");
      expect(await readFile(join(second.workspace, "from-pod.txt"), "utf8")).toBe("pod\n");
      expect(await readFile(join(second.harnessRoot, "codex", "state.json"), "utf8")).toBe("{}\n");
      expect(await readFile(join(second.harnessRoot, "volume-id"), "utf8")).toBe(`${next}\n`);
      expect((await settled("disk-pod-s1")).status).toBe("completed");

      // A lost volume with a version: a new volume seeded from the latest, no reset needed.
      fake.losePvc(next);
      await reconcile("disk/pod");
      const recovered = await until("recovered", () => view("disk/pod"), (body) => body.pod.volumeGeneration === 2);
      expect(recovered.disk.operation).toMatchObject({ kind: "seed", version: 1 });
      expect(recovered.pod.observed).not.toBe("lost");
      await second.stop();
      second = undefined;
      const last = podName(tenantId, "disk/pod", 2);
      await until("the third pod runs", async () => fake.podUid(last), (uid) => uid !== undefined);
      third = await engine("disk/pod", last);
      await until("seeded again", () => view("disk/pod"), (body) => body.disk.operation === undefined);
      expect(await readFile(join(third.workspace, "notes.txt"), "utf8")).toBe("v1\n");
      await expect(stat(join(third.workspace, "missing"))).rejects.toThrow();
    } finally {
      await second?.stop();
      await third?.stop();
    }
  });
});
