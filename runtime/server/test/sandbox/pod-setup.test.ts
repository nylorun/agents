/**
 * R2d step 2 against an in-memory sandboxes service: a pod Environment's `setup` and `files`.
 * The join hands the engine its disk's plan; input files come only through the host routes,
 * indexed into the applied recipe; a failed setup fails the pod (and stays failed while the pod
 * is ready) until a turn start asks it to run again; a session's artifact or a missing version
 * is refused at the `PUT`, and so is setup on a virtual Environment.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import type { ModelProvider } from "../../src/core/provider.js";
import { startHarnessListener, type HarnessListener } from "../../src/harness-api/ws-server.js";
import type { HostAuthority } from "../../src/sandbox/join.js";
import { podName } from "../../src/sandbox/pods/name.js";
import { fakeSandboxes, type FakeSandboxes } from "../support/fake-sandboxes.js";
import { startTestTenant } from "../support/tenant.js";

const APP = "sandbox-setup-app-key-aaaaaaaaaaaa";
const KEK = Buffer.alloc(32, 9).toString("base64");

let runtime: Awaited<ReturnType<typeof startTestTenant>>;
let fake: FakeSandboxes;
let hosts: HostAuthority;
let listener: HarnessListener;
let tenantId: string;
let artifactId: string;

const model: ModelProvider = async () => ({ output: [{ type: "text", text: "core" }] });

async function call(method: string, path: string, body?: unknown, key = APP) {
  const response = await fetch(`${runtime.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
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

async function createPod(id: string, body: Record<string, unknown>) {
  const created = await until("created", () => call("PUT", path(id), { kind: "pod", ...body }), (reply) => reply.status !== 409);
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const name = podName(tenantId, id, created.body.pod.volumeGeneration);
  await until("the pod runs", async () => fake.podUid(name), (uid) => uid !== undefined);
  return { name, view: created.body };
}

beforeAll(async () => {
  fake = fakeSandboxes();
  runtime = await startTestTenant({
    applicationKey: APP,
    vaultKek: KEK,
    modelProvider: model,
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
  const uploaded = await fetch(`${runtime.url}/v1/artifacts?name=seed.txt`, {
    method: "POST",
    headers: { authorization: `Bearer ${APP}`, "content-type": "text/plain" },
    body: "seed bytes\n",
  });
  expect(uploaded.status, await uploaded.clone().text()).toBe(201);
  artifactId = ((await uploaded.json()) as { artifact: { artifactId: string } }).artifact.artifactId;
});

afterAll(async () => {
  await listener?.close();
  await runtime?.close();
});

describe("a pod Environment's setup and input files", { timeout: 90_000 }, () => {
  it("refuses setup and files on a virtual Environment, and a missing artifact version", async () => {
    const virtual = await call("PUT", path("setup/virtual"), { kind: "virtual", setup: [{ command: "true" }] });
    expect(virtual.status).toBe(400);
    expect(virtual.body.message).toMatch(/setup is for kind pod/);
    const missing = await call("PUT", path("setup/missing"), {
      kind: "pod",
      files: [{ artifactId, version: 9, path: "/workspace/seed.txt" }],
    });
    expect(missing.status).toBe(400);
    expect(missing.body.message).toMatch(/has no version 9/);
    const outside = await call("PUT", path("setup/outside"), {
      kind: "pod",
      files: [{ artifactId, version: 1, path: "/etc/passwd" }],
    });
    expect(outside.status).toBe(400);
  });

  it("hands the plan to the engine at join, and serves only the recipe's input files", async () => {
    const { name, view } = await createPod("setup/one", {
      setup: [{ command: "npm ci", cwd: "/workspace/app", timeout: "15m" }, { command: "echo ready" }],
      files: [{ artifactId, version: 1, path: "/workspace/seed.txt" }],
    });
    expect(view.recipe.setup).toHaveLength(2);
    expect(view.recipe.files).toEqual([{ artifactId, version: 1, path: "/workspace/seed.txt" }]);
    await call("PUT", `${path("setup/one")}/secrets/REGION`, { type: "environment_variable", value: "eu-west-1" });
    const joined = await hosts.join({ sandboxId: "setup/one", podUid: fake.podUid(name)!, joinToken: fake.joinToken(name)! });
    expect(joined.setup).toEqual({
      recipeVersion: 1,
      commands: [
        { command: "npm ci", cwd: "/workspace/app", timeoutMs: 15 * 60_000 },
        { command: "echo ready", cwd: "/workspace", timeoutMs: 10 * 60_000 },
      ],
      files: [{ index: 0, path: "/workspace/seed.txt" }],
      environment: { REGION: "eu-west-1" },
    });

    const base = listener.url.replace(/^ws/, "http");
    const get = (suffix: string, token = joined.hostToken) =>
      fetch(`${base}/host/${suffix}`, { headers: { authorization: `Bearer ${token}` } });
    const file = await get("files/0");
    expect(file.status).toBe(200);
    expect(file.headers.get("x-nylorun-artifact-kind")).toBe("file");
    expect(await file.text()).toBe("seed bytes\n");
    expect((await get("files/1")).status).toBe(404);
    expect((await get("files/0/inside")).status).toBe(404);
    expect((await get("files/0", "not-a-token")).status).toBe(401);
    const state = (await (await get("setup")).json()) as { retry: boolean };
    expect(state.retry).toBe(true);
  });

  it("a failed setup fails the pod and stays failed while the pod is ready, until a turn start", async () => {
    const { name } = await createPod("setup/fails", { setup: [{ command: "exit 3" }] });
    const joined = await hosts.join({ sandboxId: "setup/fails", podUid: fake.podUid(name)!, joinToken: fake.joinToken(name)! });
    await hosts.reportSetup(joined.hostToken, { status: "failed", index: 0, exitCode: 3, output: "boom\n" });
    const failed = (await call("GET", path("setup/fails"))).body;
    expect(failed.pod).toMatchObject({ observed: "failed" });
    expect(failed.pod.reason).toMatch(/^setup: command 1 \(exit 3\) exited 3: boom/);
    const events = (await call("GET", `${path("setup/fails")}/events`)).body.events as { type: string; payload: any }[];
    expect(events.at(-1)).toMatchObject({
      type: "environment.failed",
      payload: { setup: { index: 0, exitCode: 3, output: "boom\n" } },
    });
    // A reconcile with the pod ready keeps the failure.
    await runtime.handle.worker!.sandbox!("setup/fails", "reconcile", new AbortController().signal);
    expect((await call("GET", path("setup/fails"))).body.pod.observed).toBe("failed");
    expect((await hosts.setup(joined.hostToken)).retry).toBe(false);
    // A success clears nothing by itself.
    await hosts.reportSetup(joined.hostToken, { status: "ok" });
    expect((await call("GET", path("setup/fails"))).body.pod.observed).toBe("failed");

    // A turn start asks the pod to run again: the engine is told to run its setup again.
    const agent = Agent({ id: "bot" }).instructions("Work.").build();
    expect((await call("PUT", "/v1/agents/bot", { requestId: "bot", manifest: agent.manifest, implementationVersion: "dev" })).status).toBe(200);
    expect(
      (await call("PUT", "/v1/sessions/setup-s1", { requestId: "s1", agentId: "bot", ownerUserId: "app:ada", environment: "setup/fails" })).status,
    ).toBe(200);
    const sent = await call("POST", "/v1/sessions/setup-s1/commands", {
      type: "message",
      requestId: "m1",
      idempotencyKey: "m1",
      content: "go",
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    const again = await until("retry", () => hosts.setup(joined.hostToken), (state) => state.retry);
    expect(again.setup?.commands).toEqual([{ command: "exit 3", cwd: "/workspace", timeoutMs: 10 * 60_000 }]);
  });
});
