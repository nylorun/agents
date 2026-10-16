/**
 * Credentials for skills (R2c, D50) in an Agent's vault (protocol 16; an Environment's from D56),
 * through the Runtime against an in-memory sandboxes service: a second secret for a host is
 * refused at write, and the owner guard keeps another owner's sessions off an Agent that serves
 * secrets; a pod
 * turn's commands see each `environment_secret` as `nylorun_managed` and each
 * `environment_variable` as its value; the vault releases the real header only for a bound host,
 * read afresh after a rotation. egress-gate's use of the release is `gates/egress-credentials`.
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
import { podName } from "../../src/sandbox/pods/name.js";
import { VaultService } from "../../src/vault/service.js";
import { fakeSandboxes, type FakeSandboxes } from "../support/fake-sandboxes.js";
import { withTestSessionStore } from "../support/store.js";
import { startTestTenant } from "../support/tenant.js";
import { manifestOf, saveManifest } from "../support/agents.js";

const APP = "skill-credentials-app-key-aaaaaaaaaa";
const KEK = Buffer.alloc(32, 5).toString("base64");
const SECRET = "ghp_real_secret_value_6c1d";
const ROTATED = "ghp_rotated_secret_value_93ea";

let runtime: Awaited<ReturnType<typeof startTestTenant>>;
let fake: FakeSandboxes;
let listener: HarnessListener;
let tenantId: string;
/** Ada's pod Agent, guarded for her sessions. */
const ENV = "creds";
let created: { status: number; body: any };

/** One bash call per turn that prints what a skill's CLI would read, then a text answer. */
const podModel: ModelProvider = async (effect) => {
  const prompt = (effect.input as { prompt?: { kind?: string }[] }).prompt ?? [];
  if (prompt.at(-1)?.kind === "tool-result") return { output: [{ type: "text", text: "done" }] };
  return {
    output: [{ type: "tool-call", id: `call-${effect.turnId}`, name: "bash", args: { command: 'echo "$GH_TOKEN $REGION" > env.txt' } }],
  };
};
const coreModel: ModelProvider = async () => ({ output: [{ type: "text", text: "core" }] });

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${runtime.url}${path}`, {
    method,
    headers: {
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

async function until<T>(what: string, read: () => Promise<T>, ok: (value: T) => boolean, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`${what}: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function secret(name: string, body: Record<string, unknown>) {
  return call("PUT", `/v1/agents/${ENV}/secrets/${name}`, body);
}

const open = (id: string, owner: string) =>
  call("PUT", `/v1/sessions/${id}`, {
    requestId: `open-${id}`,
    agent: ENV,
    ownerUserId: owner,
  });

/** The vault as the gateway reads it, over the Tenant's database. */
const gateway = <T>(fn: (vault: VaultService) => Promise<T>) =>
  withTestSessionStore({ root: runtime.root, tenantId }, (store) =>
    fn(new VaultService({ store, kek: () => Buffer.from(KEK, "base64") })),
  );

beforeAll(async () => {
  fake = fakeSandboxes();
  runtime = await startTestTenant({
    applicationKey: APP,
    vaultKek: KEK,
    modelProvider: coreModel,
    sandbox: { backend: "virtual" },
    pods: { client: fake, harnessImage: "nylorun-runtime:test" },
  });
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
  await saveManifest(
    runtime.url,
    { authorization: `Bearer ${APP}`, "content-type": "application/json" },
    manifestOf(agent, { runtime: { kind: "pod" } }),
  );

  created = await until(
    "created",
    () => call("PUT", `/v1/agents/${ENV}`, { manifest: "bot", owner: "app:ada" }),
    (reply) => reply.status !== 409,
  );
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  for (const [name, body] of [
    ["GH_TOKEN", { type: "environment_secret", value: SECRET, allowedHosts: ["api.github.com", "GitHub.com"] }],
    ["REGION", { type: "environment_variable", value: "eu-west-1" }],
  ] as const) {
    const written = await secret(name, body);
    expect(written.status, JSON.stringify(written.body)).toBe(200);
  }
});

afterAll(async () => {
  await listener?.close();
  await runtime?.close();
});

describe("credentials for skills (R2c)", { timeout: 90_000 }, () => {
  it("lists a secret and a variable, never a value", async () => {
    const listed = (await call("GET", `/v1/agents/${ENV}/secrets`)).body;
    expect(JSON.stringify(listed)).not.toContain(SECRET);
    expect(JSON.stringify(listed)).not.toContain("eu-west-1");
    const byName = Object.fromEntries((listed.secrets as any[]).map((entry) => [entry.name, entry]));
    expect(byName.GH_TOKEN).toMatchObject({
      type: "environment_secret",
      binding: {
        allowedHosts: ["api.github.com", "github.com"],
        inject: { header: "Authorization", format: "Bearer {value}" },
      },
    });
    expect(byName.REGION).toEqual({ name: "REGION", type: "environment_variable", binding: {}, createdAt: expect.any(String) });
  });

  it("refuses a second secret bound to a host at write, and a variable is set once by its name", async () => {
    const refused = await secret("OTHER_TOKEN", { type: "environment_secret", value: "y", allowedHosts: ["github.com"] });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body).toMatchObject({ code: "credential_conflict", details: { host: "github.com", existing: "GH_TOKEN" } });
    // Another host is no conflict; the name is the variable, so it is set once.
    const other = await secret("BAO_KEY", {
      type: "environment_secret",
      value: "bao-secret",
      allowedHosts: ["api.bao.test"],
      inject: { header: "X-Api-Key", format: "{value}" },
    });
    expect(other.status, JSON.stringify(other.body)).toBe(200);
    expect((await call("DELETE", `/v1/agents/${ENV}/secrets/BAO_KEY`)).status).toBe(200);
    expect(((await call("GET", `/v1/agents/${ENV}/secrets`)).body.secrets as { name: string }[]).map((item) => item.name)).toEqual([
      "GH_TOKEN",
      "REGION",
    ]);
  });

  it("runs a pod turn with the sentinel and the variable; the gateway releases the header for a bound host only", async () => {
    const name = podName(tenantId, ENV, created.body.compute.pod.volumeGeneration);
    await until("the pod runs", async () => fake.podUid(name), (uid) => uid !== undefined);
    const workspace = await mkdtemp(join(tmpdir(), "nylorun-creds-ws-"));
    const harnessRoot = await mkdtemp(join(tmpdir(), "nylorun-creds-harness-"));
    const joinFile = join(harnessRoot, "join-token");
    await writeFile(joinFile, fake.joinToken(name)!);
    const host = podHost(
      { sandboxId: ENV, podUid: fake.podUid(name)!, joinFile, httpUrl: listener.url.replace(/^ws/, "http").replace(/\/nylorun.*$/, ""), blocked: [] },
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
      expect((await open("creds-ada", "app:ada")).status).toBe(200);
      const sent = await call("POST", "/v1/sessions/creds-ada/commands", { type: "message", requestId: "m1", idempotencyKey: "m1", content: "go" });
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
      const done = await until("settles", async () => (await call("GET", "/v1/sessions/creds-ada")).body, (body) =>
        ["completed", "failed", "cancelled"].includes(body.status), 60_000);
      expect(done.status).toBe("completed");
      expect(await readFile(join(workspace, "env.txt"), "utf8")).toBe("nylorun_managed eu-west-1\n");
      const history = await call("GET", "/v1/sessions/creds-ada/history");
      expect(JSON.stringify(history.body)).not.toContain(SECRET);
    } finally {
      host.stop();
      await service?.stop(1_000);
      await rm(workspace, { recursive: true, force: true });
      await rm(harnessRoot, { recursive: true, force: true });
    }

    // What egress-gate reads: the header for a bound host, by any case of its name; nothing elsewhere.
    const credentialId = await withTestSessionStore({ root: runtime.root, tenantId }, (store) =>
      store.tx(async (t) => (await t.credentialByName((await t.vaultOfEnvironment(ENV))!.id, "GH_TOKEN"))!.id),
    );
    expect(await gateway((v) => v.releaseEnvironmentSecret({ environmentId: ENV, host: "API.github.com" }))).toEqual({
      status: "released",
      header: "Authorization",
      value: `Bearer ${SECRET}`,
      credentialId,
    });
    expect(await gateway((v) => v.environmentSecretBound(ENV, "github.com"))).toBe(true);
    expect(await gateway((v) => v.environmentSecretBound(ENV, "gist.github.com"))).toBe(false);
    expect(await gateway((v) => v.releaseEnvironmentSecret({ environmentId: ENV, host: "example.com" }))).toEqual({ status: "none" });

    // A replaced value applies to the next release; the credential and its binding stay.
    const rotated = await secret("GH_TOKEN", { type: "environment_secret", value: ROTATED, allowedHosts: ["api.github.com", "github.com"] });
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(200);
    expect(JSON.stringify(rotated.body)).not.toContain(ROTATED);
    expect(await gateway((v) => v.releaseEnvironmentSecret({ environmentId: ENV, host: "api.github.com" }))).toEqual({
      status: "released",
      header: "Authorization",
      value: `Bearer ${ROTATED}`,
      credentialId,
    });

    // Another owner's session cannot open on the Agent that serves Ada's secrets.
    const refused = await open("creds-bao", "app:bao");
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.code).toBe("agent_owner_mismatch");
    // Ada's second session opens on it too.
    expect((await open("creds-ada-2", "app:ada")).status).toBe(200);
  });
});
