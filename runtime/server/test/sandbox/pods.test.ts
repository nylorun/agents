/**
 * Pod Environments in the Runtime (F7.2, S3–S8, protocol 11) against an in-memory sandboxes
 * service (`fake-sandboxes.ts`): create at once, join → host token, a turn whose harness runs in
 * the pod (its own engine, the `local` backend, over the Harness API listener with a host token),
 * relaunch, stop, idle, a pod that never changes what it runs, PVC loss →
 * `environment.lost`, reset, delete.
 */
import { providerModelGate } from "../../src/gates/provider-gate.js";
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

describe("pod Environments", { timeout: 90_000 }, () => {
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
    const { name, view: created } = await createPod("join/one", { image: "node:24-slim", network: { allowedHosts: ["pypi.org"] } });
    expect(created).toMatchObject({
      kind: "pod",
      manifest: { image: "node:24-slim", network: { allowedHosts: ["pypi.org"] } },
      version: 1,
      appliedVersion: 1,
      pod: { desired: "running", volumeGeneration: 0 },
    });
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
    expect(await events("join/one")).toEqual(["environment.created", "environment.running"]);

    // Relaunch: a new pod on the same volume joins; the old pod's tokens stop working.
    const uid = fake.relaunch(name);
    const second = await joinAs("join/one", name, uid);
    expect(second.epoch).toBe(2);
    await expect(hosts.renew(first.hostToken)).rejects.toMatchObject({ status: 401 });
    await expect(hosts.verify(first.hostToken)).rejects.toBeInstanceOf(HostAuthError);
    expect((await events("join/one")).at(-1)).toBe("environment.relaunched");
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
        paths: { sandboxes: join(harnessRoot, "sandboxes") },
        modelGate: providerModelGate(podModel),
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
    expect(refused.body.code).toBe("environment_unavailable");
  });

  it("runs two sessions' turns at once in one pod's engine, their commands side by side (D66)", async () => {
    const { name } = await createPod("run/two");
    const workspace = await mkdtemp(join(tmpdir(), "nylorun-pod-ws-"));
    const harnessRoot = await mkdtemp(join(tmpdir(), "nylorun-pod-harness-"));
    const joinFile = join(harnessRoot, "join-token");
    await writeFile(joinFile, fake.joinToken(name)!);
    const host = podHost(
      { sandboxId: "run/two", podUid: fake.podUid(name)!, joinFile, httpUrl: listener.url.replace(/^ws/, "http").replace(/\/nylorun.*$/, ""), blocked: [] },
      { info: () => undefined, warn: () => undefined },
    );
    // a's command waits for the file b's command writes: it ends only if they run at once.
    const commands: Record<string, string> = {
      "pod-a": "for i in $(seq 1 200); do [ -f go ] && break; sleep 0.05; done; [ -f go ] && echo a > a.txt",
      "pod-b": "echo b > b.txt; touch go",
    };
    const twoModel: ModelProvider = async (effect) => {
      const prompt = (effect.input as { prompt?: { kind?: string }[] }).prompt ?? [];
      if (prompt.at(-1)?.kind === "tool-result") return { output: [{ type: "text", text: "done" }] };
      return { output: [{ type: "tool-call", id: `call-${effect.turnId}`, name: "bash", args: { command: commands[effect.sessionId]! } }] };
    };
    let service: HarnessService | undefined;
    try {
      service = startHarnessService({
        url: listener.url,
        token: () => host.token(),
        paths: { sandboxes: join(harnessRoot, "sandboxes") },
        modelGate: providerModelGate(twoModel),
        toolGate: {},
        sandboxBackends: [localBackend({ workspace, env: { PATH: process.env.PATH }, proxyEnv: () => host.proxyEnv() })],
        logger: { info: () => undefined, warn: () => undefined },
        name: "pod",
        backoff: { minMs: 50, maxMs: 200 },
      });
      await service.client.ready;
      expect((await open("pod-a", "run/two")).status).toBe(200);
      expect((await open("pod-b", "run/two")).status).toBe(200);
      expect((await message("pod-a")).status).toBe(200);
      // The second session's turn starts while the first runs.
      expect((await message("pod-b")).status).toBe(200);
      expect((await settled("pod-a")).status).toBe("completed");
      expect((await settled("pod-b")).status).toBe("completed");
      expect(await readFile(join(workspace, "a.txt"), "utf8")).toBe("a\n");
      expect(await readFile(join(workspace, "b.txt"), "utf8")).toBe("b\n");
    } finally {
      host.stop();
      await service?.stop(1_000);
      await rm(workspace, { recursive: true, force: true });
      await rm(harnessRoot, { recursive: true, force: true });
    }
  });

  it("stops on request and when idle, and asks the pod to run again at the next turn", async () => {
    const { name } = await createPod("idle/one");
    await joinAs("idle/one", name);
    const stopped = await call("POST", `${path("idle/one")}/stop`);
    expect(stopped.status).toBe(200);
    expect(stopped.body.pod.desired).toBe("suspended");
    await until("suspended", () => view("idle/one"), (body) => body.pod.observed === "suspended");
    expect(fake.calls.filter((item) => item.name === name).at(-1)?.spec?.mode).toBe("Suspended");
    expect(await events("idle/one")).toContain("environment.suspended");
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
    expect(types).toContain("environment.suspended");
    await until("pod gone", async () => fake.podUid(other), (uid) => uid === undefined);
  });

  it("never changes what a pod runs: a stop and the next start keep it", async () => {
    const { name } = await createPod("recipe/one", { storage: "5GiB" });
    await joinAs("recipe/one", name);
    expect((await call("PUT", path("recipe/one"), { kind: "virtual" })).status).toBe(409);
    const storage = await call("PUT", path("recipe/one"), { storage: "10GiB" });
    expect(storage.status).toBe(409);
    expect(storage.body).toMatchObject({ code: "environment_immutable", details: { fields: ["storage"] } });
    expect((await call("PUT", path("recipe/one"), { storage: "5GiB" })).body.version).toBe(1);
    // The Tenant's limits.idle (2s) is the most an Environment may ask for.
    expect((await call("PUT", path("recipe/one"), { lifecycle: { idle: "1h" } })).status).toBe(400);
    // Network and image are what it runs: refused, naming the fork.
    for (const [field, change] of [
      ["network", { network: { allowedHosts: ["pypi.org"] } }],
      ["image", { image: "node:24-slim" }],
    ] as const) {
      const refused = await call("PUT", path("recipe/one"), change);
      expect(refused.status, field).toBe(409);
      expect(refused.body).toMatchObject({ code: "environment_immutable", details: { fields: [field] } });
    }
    const before = fake.calls.filter((item) => item.method === "PUT" && item.name === name).length;
    const image = fake.calls.filter((item) => item.method === "PUT" && item.name === name).at(-1)?.spec?.image;
    expect((await call("POST", `${path("recipe/one")}/stop`)).status).toBe(200);
    await until("suspended", () => view("recipe/one"), (body) => body.pod.observed === "suspended");
    // The next turn start runs it again, as it was.
    expect((await open("recipe-s1", "recipe/one")).status).toBe(200);
    expect((await message("recipe-s1")).status).toBe(200);
    await until(
      "the pod runs again",
      async () => fake.calls.filter((item) => item.method === "PUT" && item.name === name).slice(before),
      (calls) => calls.some((item) => item.spec?.mode === "Running"),
    );
    const running = fake.calls.filter((item) => item.method === "PUT" && item.name === name).slice(before);
    expect(running.filter((item) => item.spec?.mode === "Running").every((item) => item.spec?.image === image)).toBe(true);
    expect((await view("recipe/one")).version).toBe(1);
    await call("POST", "/v1/sessions/recipe-s1/commands", { type: "cancel", requestId: "c-recipe", idempotencyKey: "c-recipe" });
    await settled("recipe-s1");
  });

  it("stops and resets only a pod: kinds virtual and none are a 400", async () => {
    for (const kind of ["virtual", "none"]) {
      const id = `kinds/${kind}`;
      expect((await call("PUT", path(id), { kind })).status).toBe(200);
      for (const action of ["stop", "reset"]) {
        const refused = await call("POST", `${path(id)}/${action}`);
        expect(refused.status, `${kind} ${action}`).toBe(400);
        expect(refused.body.message).toContain("only a pod Environment stops and resets");
      }
    }
  });

  it("is lost when its volume goes, refuses turns until a reset, which starts a new volume", async () => {
    const { name } = await createPod("lost/one");
    const joined = await joinAs("lost/one", name);
    fake.losePvc(name);
    await reconcile("lost/one");
    const lost = await view("lost/one");
    expect(lost.pod).toMatchObject({ observed: "lost", reason: "The Environment's volume is gone" });
    expect(lost.pod.hostEpoch).toBeGreaterThan(joined.epoch);
    expect(await events("lost/one")).toContain("environment.lost");
    await expect(hosts.renew(joined.hostToken)).rejects.toBeInstanceOf(HostAuthError);
    expect((await open("lost-s1", "lost/one")).status).toBe(200);
    const refused = await message("lost-s1");
    expect(refused.body.code).toBe("environment_lost");

    const reset = await call("POST", `${path("lost/one")}/reset`);
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    expect(reset.body.pod).toMatchObject({ volumeGeneration: 1, observed: "creating" });
    const next = podName(tenantId, "lost/one", 1);
    await until("new pod", async () => fake.podUid(next), (uid) => uid !== undefined);
    await until("old Sandbox deleted", async () => fake.sandboxes.has(name), (has) => !has);
    expect(fake.joinToken(next)).not.toBe(fake.joinToken(name));
    expect((await events("lost/one")).at(-1)).toBe("environment.reset");
    expect((await joinAs("lost/one", next)).epoch).toBeGreaterThan(lost.pod.hostEpoch);
  });

  it("is lost when a pod joins from a replaced volume (a deleted claim recreated empty)", async () => {
    const { name } = await createPod("lost/volume");
    const join = (podUid: string, volumeId: string) =>
      hosts.join({ sandboxId: "lost/volume", podUid, joinToken: fake.joinToken(name)!, volumeId });
    const first = await join(fake.podUid(name)!, "vol-aaaa");
    // A relaunch on the same volume joins.
    const same = await join(fake.relaunch(name), "vol-aaaa");
    expect(same.epoch).toBeGreaterThan(first.epoch);
    // A pod on a new, empty volume does not.
    await expect(join(fake.relaunch(name), "vol-bbbb")).rejects.toMatchObject({ status: 401 });
    const lost = await view("lost/volume");
    expect(lost.pod).toMatchObject({ observed: "lost", reason: "The sandbox's volume was replaced: its files are gone" });
    expect(await events("lost/volume")).toContain("environment.lost");
    await expect(hosts.renew(same.hostToken)).rejects.toBeInstanceOf(HostAuthError);
    await until("the Sandbox is deleted", async () => fake.sandboxes.has(name), (has) => !has);
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
      (await call("PUT", "/v1/tenant/sandbox", { requestId: "p1", limits: { idle: "2s" }, placement: { nylorun: { hosts: ["harness-container"] } } })).status,
    ).toBe(200);
    const refused = await open("place-s1", "place/one");
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("placement_refused");
    expect(
      (await call("PUT", "/v1/tenant/sandbox", { requestId: "p2", limits: { idle: "2s" }, placement: { "*": { hosts: ["sandbox"] } } })).status,
    ).toBe(200);
    const plain = await call("PUT", "/v1/sessions/place-s2", { requestId: "open-place-s2", agentId: "bot", ownerUserId: "app:ada" });
    expect(plain.body.code).toBe("placement_refused");
    expect((await open("place-s3", "place/one")).status).toBe(200);
    expect((await call("PUT", "/v1/tenant/sandbox", { requestId: "p3", limits: { idle: "2s" } })).status).toBe(200);
    fake.down = true;
    try {
      await new Promise((resolve) => setTimeout(resolve, 5_100)); // the readiness cache
      const down = await open("place-s4", "place/one");
      expect(down.status).toBe(409);
      expect(down.body.code).toBe("environment_unavailable");
    } finally {
      fake.down = false;
    }
  });
});
