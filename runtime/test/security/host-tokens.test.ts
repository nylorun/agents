/**
 * Host tokens (F7.2, D42): what a pod sandbox's join token and host token reach, and what they
 * do not. The join is bound to the token's hash and the Sandbox's current pod; a host token is
 * accepted only by the Harness API listener, for a connection that hosts its sandbox alone; an
 * older epoch, an egress token, a run token or a forged token is refused; a host connection
 * never takes another sandbox's or a non-pod session's work, nor claims its events.
 */
import { createChannel, type HarnessChannel } from "@nylorun/core/harness-api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Agent } from "@nylorun/core/define";
import { HARNESS_API_HEADER, wsPort } from "../../src/harness/ws-port.js";
import { startHarnessListener, HOST_JOIN_PATH, HOST_RENEW_PATH, type HarnessListener } from "../../src/harness-api/ws-server.js";
import { HostAuthError, type HostAuthority } from "../../src/sandbox/join.js";
import { podName } from "../../src/sandbox/pods/name.js";
import { fakeSandboxes, type FakeSandboxes } from "../support/fake-sandboxes.js";
import { startTestTenant } from "../support/tenant.js";

const APP = "host-tokens-app-key-aaaaaaaaaaaaaa";
const KEK = Buffer.alloc(32, 5).toString("base64");

let runtime: Awaited<ReturnType<typeof startTestTenant>>;
let fake: FakeSandboxes;
let hosts: HostAuthority;
let listener: HarnessListener;
let base: string;
let tenantId: string;
const open: HarnessChannel[] = [];

async function call(method: string, path: string, body?: unknown, bearer = APP) {
  const response = await fetch(`${runtime.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}

async function until<T>(read: () => Promise<T> | T, ok: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const value = await read();
    if (ok(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out");
}

async function pod(id: string) {
  expect((await call("PUT", `/v1/sandboxes/${encodeURIComponent(id)}`, { kind: "pod" })).status).toBe(200);
  const name = podName(tenantId, id, 0);
  await until(() => fake.podUid(name), (uid) => uid !== undefined);
  return name;
}

/** Upgrades with `bearer`; the HTTP status of a refusal, or the open channel. */
function connect(bearer: string): Promise<{ status: number; channel?: HarnessChannel }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(listener.url, { headers: { authorization: `Bearer ${bearer}`, [HARNESS_API_HEADER]: "1" } });
    socket.once("open", () => {
      const channel = createChannel(wsPort(socket), { validate: true });
      open.push(channel);
      resolve({ status: 101, channel });
    });
    socket.once("unexpected-response", (_request, response) => {
      resolve({ status: response.statusCode ?? 0 });
      response.resume();
      socket.terminate();
    });
    socket.once("error", () => resolve({ status: 0 }));
  });
}

const hello = (channel: HarnessChannel) =>
  channel.request("hello", { api: 1, name: "probe", version: "0", capabilities: { workspace: { backends: ["local"] } } });

beforeAll(async () => {
  fake = fakeSandboxes();
  runtime = await startTestTenant({
    applicationKey: APP,
    vaultKek: KEK,
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
  base = listener.url.replace(/^ws/, "http").replace(/\/nylorun.*$/, "");
  const agent = Agent({ id: "bot", name: "Bot" }).instructions("x").build();
  await call("PUT", "/v1/agents/bot", { requestId: "bot", manifest: agent.manifest, implementationVersion: "dev" });
});

afterAll(async () => {
  for (const channel of open) channel.close("done");
  await listener?.close();
  await runtime?.close();
});

describe("host tokens", { timeout: 60_000 }, () => {
  it("joins only with the sandbox's token, from its current pod, over the listener's join route", async () => {
    const a = await pod("ht/a");
    const b = await pod("ht/b");
    const post = (path: string, body: unknown, bearer?: string) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
        body: JSON.stringify(body),
      });
    // Replay from another pod UID, and A's token for B: the same 401.
    for (const attempt of [
      { sandboxId: "ht/a", podUid: "11111111-2222-3333-4444-555555555555", joinToken: fake.joinToken(a) },
      { sandboxId: "ht/b", podUid: fake.podUid(b), joinToken: fake.joinToken(a) },
      { sandboxId: "ht/missing", podUid: fake.podUid(a), joinToken: fake.joinToken(a) },
    ]) {
      const refused = await post(HOST_JOIN_PATH, attempt);
      expect(refused.status).toBe(401);
      expect(await refused.json()).toEqual({ error: { code: "unauthorized", message: "The join was refused" } });
    }
    expect((await post(HOST_JOIN_PATH, { nope: 1 })).status).toBe(400);
    const joined = await post(HOST_JOIN_PATH, { sandboxId: "ht/a", podUid: fake.podUid(a), joinToken: fake.joinToken(a) });
    expect(joined.status).toBe(200);
    const grant = (await joined.json()) as { hostToken: string; egressToken: string; epoch: number };
    expect(grant.epoch).toBe(1);
    const renewed = await post(HOST_RENEW_PATH, {}, grant.hostToken);
    expect(renewed.status).toBe(200);
    // Neither the egress token nor the join token renews.
    expect((await post(HOST_RENEW_PATH, {}, grant.egressToken)).status).toBe(401);
    expect((await post(HOST_RENEW_PATH, {}, fake.joinToken(a))).status).toBe(401);
  });

  it("is no bearer of the Tenant API, and the egress token no host token", async () => {
    const a = podName(tenantId, "ht/a", 0);
    const grant = await hosts.join({ sandboxId: "ht/a", podUid: fake.podUid(a)!, joinToken: fake.joinToken(a)! });
    for (const bearer of [grant.hostToken, grant.egressToken]) {
      const answer = await call("GET", "/v1/sandboxes", undefined, bearer);
      expect(answer.status).not.toBe(200);
    }
    await expect(hosts.verify(grant.egressToken)).rejects.toBeInstanceOf(HostAuthError);
    expect((await connect(grant.egressToken)).status).toBe(401);
    // A forged signature, and no harness token at all on this listener.
    const [head, body] = grant.hostToken.split(".");
    expect((await connect(`${head}.${body}.${"A".repeat(86)}`)).status).toBe(401);
    expect((await connect("ab".repeat(32))).status).toBe(401);
  });

  it("connects a host for its sandbox only, and an older epoch not at all", async () => {
    const a = podName(tenantId, "ht/a", 0);
    const first = await hosts.join({ sandboxId: "ht/a", podUid: fake.podUid(a)!, joinToken: fake.joinToken(a)! });
    const connected = await connect(first.hostToken);
    expect(connected.status).toBe(101);
    const channel = connected.channel!;
    await hello(channel);
    // It claims no event of a session it holds no run or request for.
    await expect(
      channel.request("event", { sessionId: "someone-else", turnId: null, type: "sandbox.exec", payload: {} }),
    ).rejects.toMatchObject({ code: "run_not_held" });
    // A session on another pod sandbox is not served by this host.
    expect((await call("PUT", "/v1/sessions/ht-b", { requestId: "ht-b", agentId: "bot", ownerUserId: "app:ada", sandbox: { id: "ht/b" } })).status).toBe(200);
    const refused = await call("POST", "/v1/sessions/ht-b/sandbox/read", { path: "x" });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("sandbox_unavailable");
    // A session without a pod sandbox is never served by a host either: the in-process harness
    // holds those workspaces.
    expect((await call("PUT", "/v1/sessions/ht-plain", { requestId: "ht-plain", agentId: "bot", ownerUserId: "app:ada", sandbox: {} })).status).toBe(200);
    expect((await call("POST", "/v1/sessions/ht-plain/sandbox/bash", { command: "echo hi" })).status).toBe(200);
    // Nor does it lease a turn of one: the host's lease waits while the turn completes elsewhere.
    let leased = false;
    void channel.request("lease", {}).then(() => (leased = true), () => undefined);
    expect((await call("POST", "/v1/sessions/ht-plain/commands", { type: "message", requestId: "m1", idempotencyKey: "m1", content: "hi" })).status).toBe(200);
    await until(async () => (await call("GET", "/v1/sessions/ht-plain")).body.status, (status) => status === "completed");
    expect(leased).toBe(false);

    // A new join moves the epoch: the old connection is closed, its token refused.
    const closed = new Promise<string>((resolve) => channel.onClose(resolve));
    const second = await hosts.join({ sandboxId: "ht/a", podUid: fake.podUid(a)!, joinToken: fake.joinToken(a)! });
    expect(second.epoch).toBeGreaterThan(first.epoch);
    expect(await closed).toContain("epoch");
    expect((await connect(first.hostToken)).status).toBe(401);
    expect((await connect(second.hostToken)).status).toBe(101);
    // Stopping the sandbox moves it again.
    expect((await call("POST", "/v1/sandboxes/ht%2Fa/stop")).status).toBe(200);
    await expect(hosts.renew(second.hostToken)).rejects.toBeInstanceOf(HostAuthError);
  });
});
