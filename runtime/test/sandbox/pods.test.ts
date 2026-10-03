/**
 * Pod sandboxes in the Runtime (F7.2, S3–S8) against an in-memory sandboxes service
 * (`fake-sandboxes.ts`): create at once, join → host token, a turn whose harness runs in the
 * pod (its own engine, the `local` backend, over the Harness API listener with a host token),
 * relaunch, stop, idle, TTL and revival, PVC loss → `sandbox.lost`, reset, delete.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

const APP = "sandbox-pods-app-key-aaaaaaaaaaaaa";
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
    headers: { authorization: `Bearer ${APP}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}
const path = (id: string) => `/v1/sandboxes/${encodeURIComponent(id)}`;

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
async function open(id: string, sandboxId: string) {
  return call("PUT", `/v1/sessions/${id}`, { requestId: `open-${id}`, agentId: "bot", ownerUserId: "app:ada", sandbox: { id: sandboxId } });
}
async function settled(sessionId: string): Promise<any> {
  return until("session settles", async () => (await call("GET", `/v1/sessions/${sessionId}`)).body, (body) =>
    ["completed", "failed", "cancelled"].includes(body.status), 60_000);
}

/** Creates a pod sandbox and waits until the fake runs its pod. */
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
    (await call("PUT", "/v1/tenant/sandbox", { requestId: "cfg", limits: { idle: "2s", ttl: "1h" } })).status,
  ).toBe(200);
});

afterAll(async () => {
  await listener?.close();
  await runtime?.close();
});

describe("pod sandboxes", { timeout: 90_000 }, () => {
  it("reports the cluster", async () => {
    const tenant = (await call("GET", "/v1/tenant/sandbox")).body;
    expect(tenant.cluster).toEqual({
      namespace: "nylorun-sbx-test",
      context: "fake",
      ready: true,
      controllerVersion: "v1.0.5",
      networkPolicy: { enforced: true, probedAt: new Date(0).toISOString() },
    });
    expect(tenant.config.placement).toEqual({ "*": { hosts: ["harness-container", "sandbox"] } });
  });

  it("creates a pod at once; its join token becomes a host token bound to the pod", async () => {
    const { name, view: created } = await createPod("join/one", { image: "node:24-slim", network: { allow: ["pypi.org"] } });
    expect(created).toMatchObject({ kind: "pod", spec: { image: "node:24-slim" }, pod: { desired: "running", volumeGeneration: 0 } });
    const put = fake.calls.find((item) => item.method === "PUT" && item.name === name)!;
    expect(put.spec).toMatchObject({ mode: "Running", image: "node:24-slim", harnessImage: "nylorun-runtime:test", env: { NYLORUN_SANDBOX_ID: "join/one" } });
    expect(put.spec!.joinToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    await expect(hosts.join({ sandboxId: "join/one", podUid: fake.podUid(name)!, joinToken: "wrong" })).rejects.toBeInstanceOf(HostAuthError);
    // A token copied to another pod is refused: the UID must be the Sandbox's current pod.
    await expect(joinAs("join/one", name, "another-pod")).rejects.toMatchObject({ status: 401 });
    const first = await joinAs("join/one", name);
    expect(first.epoch).toBe(1);
    expect((await hosts.renew(first.hostToken)).epoch).toBe(1);
    await until("observed running", () => view("join/one"), (body) => body.pod.observed === "running");
    expect(await events("join/one")).toEqual(["sandbox.created", "sandbox.running"]);

    // Relaunch: a new pod on the same volume joins; the old pod's tokens stop working.
    const uid = fake.relaunch(name);
    const second = await joinAs("join/one", name, uid);
    expect(second.epoch).toBe(2);
    await expect(hosts.renew(first.hostToken)).rejects.toMatchObject({ status: 401 });
    await expect(hosts.verify(first.hostToken)).rejects.toBeInstanceOf(HostAuthError);
    expect((await events("join/one")).at(-1)).toBe("sandbox.relaunched");
  });

  it("runs a turn in the pod's engine, never in the Runtime's harness", async () => {
    const { name } = await createPod("run/one");
    const workspace = await mkdtemp(join(tmpdir(), "nylorun-pod-ws-"));
    const harnessRoot = await mkdtemp(join(tmpdir(), "nylorun-pod-harness-"));
    const joinFile = join(harnessRoot, "join-token");
    await writeFile(joinFile, fake.joinToken(name)!);
    const host = podHost(
      { sandboxId: "run/one", podUid: fake.podUid(name)!, joinFile, httpUrl: listener.url.replace(/^ws/, "http").replace(/\/nylorun.*$/, ""), blocked: [] },
      { info: () => undefined, warn: () => undefined },
    );
    let service: HarnessService | undefined;
    try {
      service = startHarnessService({
        url: listener.url,
        token: () => host.token(),
        paths: { sandboxes: join(harnessRoot, "sandboxes"), pluginData: join(harnessRoot, "plugin-data") },
        childEnv: {},
        modelGate: { call: async () => ({ kind: "failed", message: "no gate" }) as never },
        modelProvider: podModel,
        useVaultModel: false,
        toolGate: {},
        sandboxBackends: [localBackend({ workspace, env: { PATH: process.env.PATH }, proxyEnv: () => host.proxyEnv() })],
        logger: { info: () => undefined, warn: () => undefined },
        name: "pod",
        backoff: { minMs: 50, maxMs: 200 },
      });
      await service.client.ready;
      expect(host.epoch).toBeGreaterThan(0);
      expect((await open("pod-s1", "run/one")).status).toBe(200);
      expect((await message("pod-s1")).status).toBe(200);
      const done = await settled("pod-s1");
      expect(done.status).toBe("completed");
      expect(await readFile(join(workspace, "from-pod.txt"), "utf8")).toBe("pod\n");
      // The sandbox tool route reaches the pod's workspace too.
      const read = await call("POST", "/v1/sessions/pod-s1/sandbox/read", { path: "from-pod.txt" });
      expect(read.status, JSON.stringify(read.body)).toBe(200);
      expect(JSON.stringify(read.body)).toContain("pod");
    } finally {
      host.stop();
      await service?.stop(1_000);
      await rm(workspace, { recursive: true, force: true });
      await rm(harnessRoot, { recursive: true, force: true });
    }
    // With the pod gone, its workspace is unavailable rather than served elsewhere.
    const refused = await call("POST", "/v1/sessions/pod-s1/sandbox/read", { path: "from-pod.txt" });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("sandbox_unavailable");
  });

  it("stops on request and when idle, and asks the pod to run again at the next turn", async () => {
    const { name } = await createPod("idle/one");
    await joinAs("idle/one", name);
    const stopped = await call("POST", `${path("idle/one")}/stop`);
    expect(stopped.status).toBe(200);
    expect(stopped.body.pod.desired).toBe("suspended");
    await until("suspended", () => view("idle/one"), (body) => body.pod.observed === "suspended");
    expect(fake.calls.filter((item) => item.name === name).at(-1)?.spec?.mode).toBe("Suspended");
    expect(await events("idle/one")).toContain("sandbox.suspended");
    // The next turn start asks for Running again.
    expect((await open("idle-s1", "idle/one")).status).toBe(200);
    expect((await message("idle-s1")).status).toBe(200);
    await until("resumed", async () => fake.podUid(name), (uid) => uid !== undefined);
    await call("POST", "/v1/sessions/idle-s1/commands", { type: "cancel", requestId: "c-idle", idempotencyKey: "c-idle" });
    await settled("idle-s1");

    // Idle (the Tenant's limits.idle is 2 s): suspended with reason idle.
    const { name: other } = await createPod("idle/two");
    await until("idle suspended", () => view("idle/two"), (body) => body.pod.desired === "suspended", 30_000);
    const types = await events("idle/two");
    expect(types).toContain("sandbox.suspended");
    await until("pod gone", async () => fake.podUid(other), (uid) => uid === undefined);
  });

  it("expires at its TTL, refuses turns, and revives with a longer TTL", async () => {
    const { name } = await createPod("ttl/one", { lifecycle: { ttl: "2s" } });
    expect(fake.calls.find((item) => item.name === name)?.spec?.shutdownTime).toBeDefined();
    await until("expired", () => view("ttl/one"), (body) => body.pod.observed === "expired", 30_000);
    expect(await events("ttl/one")).toContain("sandbox.expired");
    expect((await open("ttl-s1", "ttl/one")).status).toBe(200);
    const refused = await message("ttl-s1");
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("sandbox_expired");
    // Longer than the Tenant allows: refused.
    expect((await call("PUT", path("ttl/one"), { lifecycle: { ttl: "2h" } })).status).toBe(400);
    const revived = await call("PUT", path("ttl/one"), { lifecycle: { ttl: "30m" } });
    expect(revived.status, JSON.stringify(revived.body)).toBe(200);
    expect(revived.body.pod.desired).toBe("running");
    await until("revived", () => view("ttl/one"), (body) => body.pod.observed === "running");
    const last = fake.calls.filter((item) => item.name === name).at(-1)!.spec!;
    expect(Date.parse(last.shutdownTime!)).toBeGreaterThan(Date.now() + 20 * 60_000);
  });

  it("is lost when its volume goes, refuses turns until a reset, which starts a new volume", async () => {
    const { name } = await createPod("lost/one");
    const joined = await joinAs("lost/one", name);
    fake.losePvc(name);
    await reconcile("lost/one");
    const lost = await view("lost/one");
    expect(lost.pod).toMatchObject({ observed: "lost", reason: "The sandbox's volume is gone" });
    expect(lost.pod.hostEpoch).toBeGreaterThan(joined.epoch);
    expect(await events("lost/one")).toContain("sandbox.lost");
    await expect(hosts.renew(joined.hostToken)).rejects.toBeInstanceOf(HostAuthError);
    expect((await open("lost-s1", "lost/one")).status).toBe(200);
    const refused = await message("lost-s1");
    expect(refused.body.code).toBe("sandbox_lost");

    const reset = await call("POST", `${path("lost/one")}/reset`);
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    expect(reset.body.pod).toMatchObject({ volumeGeneration: 1, observed: "creating" });
    const next = podName(tenantId, "lost/one", 1);
    await until("new pod", async () => fake.podUid(next), (uid) => uid !== undefined);
    await until("old Sandbox deleted", async () => fake.sandboxes.has(name), (has) => !has);
    expect(fake.joinToken(next)).not.toBe(fake.joinToken(name));
    expect((await events("lost/one")).at(-1)).toBe("sandbox.reset");
    expect((await joinAs("lost/one", next)).epoch).toBeGreaterThan(lost.pod.hostEpoch);
  });

  it("deletes the Sandbox, then the row", async () => {
    const { name } = await createPod("gone/one");
    expect((await call("DELETE", path("gone/one"))).body).toEqual({ id: "gone/one", deleted: true });
    expect((await call("GET", path("gone/one"))).status).toBe(404);
    await until("Sandbox deleted", async () => fake.sandboxes.has(name), (has) => !has);
    await until("created again", () => call("PUT", path("gone/one"), { kind: "pod" }), (reply) => reply.status === 200);
  });

  it("places sessions as the Tenant allows, and needs the sandboxes service up", async () => {
    await createPod("place/one");
    expect(
      (await call("PUT", "/v1/tenant/sandbox", { requestId: "p1", limits: { idle: "2s", ttl: "1h" }, placement: { nylorun: { hosts: ["harness-container"] } } })).status,
    ).toBe(200);
    const refused = await open("place-s1", "place/one");
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("placement_refused");
    expect(
      (await call("PUT", "/v1/tenant/sandbox", { requestId: "p2", limits: { idle: "2s", ttl: "1h" }, placement: { "*": { hosts: ["sandbox"] } } })).status,
    ).toBe(200);
    const plain = await call("PUT", "/v1/sessions/place-s2", { requestId: "open-place-s2", agentId: "bot", ownerUserId: "app:ada" });
    expect(plain.body.code).toBe("placement_refused");
    expect((await open("place-s3", "place/one")).status).toBe(200);
    expect((await call("PUT", "/v1/tenant/sandbox", { requestId: "p3", limits: { idle: "2s", ttl: "1h" } })).status).toBe(200);
    fake.down = true;
    try {
      await new Promise((resolve) => setTimeout(resolve, 5_100)); // the readiness cache
      const down = await open("place-s4", "place/one");
      expect(down.status).toBe(409);
      expect(down.body.code).toBe("sandbox_unavailable");
    } finally {
      fake.down = false;
    }
  });
});
