/**
 * Credentials for skills (R2c, D50) through the Runtime, against an in-memory sandboxes service:
 * session open refuses ambiguous shell credentials and a second owner on a sandbox that serves
 * secrets; a pod turn's commands see each `environment_secret` as `nylorun-managed` and each
 * `environment_variable` as its value; the vault releases the real header only for a bound host,
 * read afresh after a rotation. egress-gate's use of the release is `gates/egress-credentials`.
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
import { podName } from "../../src/sandbox/pods/name.js";
import { VaultService } from "../../src/vault/service.js";
import { fakeSandboxes, type FakeSandboxes } from "../support/fake-sandboxes.js";
import { withTestSessionStore } from "../support/store.js";
import { startTestTenant } from "../support/tenant.js";

const APP = "skill-credentials-app-key-aaaaaaaaaa";
const KEK = Buffer.alloc(32, 5).toString("base64");
const SECRET = "ghp_real_secret_value_6c1d";
const ROTATED = "ghp_rotated_secret_value_93ea";

let runtime: Awaited<ReturnType<typeof startTestTenant>>;
let fake: FakeSandboxes;
let listener: HarnessListener;
let tenantId: string;
const vaults: Record<string, string> = {};
const credentials: Record<string, string> = {};

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

async function vault(key: string, owner: string | "installation") {
  const created = await call("POST", "/v1/tenant/vaults", {
    requestId: `v-${key}`,
    idempotencyKey: `v-${key}`,
    name: key,
    ...(owner === "installation" ? { scope: "installation" } : { ownerUserId: owner }),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  vaults[key] = created.body.id;
}

async function credential(vaultKey: string, key: string, auth: Record<string, unknown>) {
  const created = await call("POST", `/v1/tenant/vaults/${vaults[vaultKey]}/credentials`, {
    requestId: `c-${key}`,
    idempotencyKey: `c-${key}`,
    name: key,
    auth,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  credentials[key] = created.body.id;
  return created.body;
}

const open = (id: string, owner: string, vaultKeys: string[], sandboxId?: string) =>
  call("PUT", `/v1/sessions/${id}`, {
    requestId: `open-${id}`,
    agentId: "bot",
    ownerUserId: owner,
    vaultIds: vaultKeys.map((key) => vaults[key]),
    ...(sandboxId ? { sandbox: { id: sandboxId } } : {}),
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
  expect((await call("PUT", "/v1/agents/bot", { requestId: "bot", manifest: agent.manifest, implementationVersion: "dev" })).status).toBe(200);

  await vault("ada", "app:ada");
  await credential("ada", "gh", { type: "environment_secret", secretName: "GH_TOKEN", secretValue: SECRET, allowedHosts: ["api.github.com", "GitHub.com"] });
  await credential("ada", "region", { type: "environment_variable", variableName: "REGION", variableValue: "eu-west-1" });
  await vault("again", "installation");
  await credential("again", "gh2", { type: "environment_secret", secretName: "GH_TOKEN", secretValue: "x", allowedHosts: ["gitlab.example.com"] });
  await vault("overlap", "installation");
  await credential("overlap", "other", { type: "environment_secret", secretName: "OTHER_TOKEN", secretValue: "y", allowedHosts: ["github.com"] });
  await vault("bao", "app:bao");
  await credential("bao", "bao", {
    type: "environment_secret",
    secretName: "BAO_KEY",
    secretValue: "bao-secret",
    allowedHosts: ["api.bao.test"],
    inject: { header: "X-Api-Key", format: "{value}" },
  });
});

afterAll(async () => {
  await listener?.close();
  await runtime?.close();
});

describe("credentials for skills (R2c)", { timeout: 90_000 }, () => {
  it("lists a secret without its value and a variable with its value", async () => {
    const listed = (await call("GET", `/v1/tenant/vaults/${vaults.ada}/credentials`)).body;
    expect(JSON.stringify(listed)).not.toContain(SECRET);
    const byName = Object.fromEntries((listed.credentials as any[]).map((entry) => [entry.name, entry]));
    expect(byName.gh).toMatchObject({
      type: "environment_secret",
      binding: {
        secretName: "GH_TOKEN",
        allowedHosts: ["api.github.com", "github.com"],
        inject: { header: "Authorization", format: "Bearer {value}" },
      },
    });
    expect(byName.region).toMatchObject({ type: "environment_variable", binding: { variableName: "REGION", variableValue: "eu-west-1" } });
  });

  it("refuses a session whose vaults set one variable twice or bind one host twice", async () => {
    for (const keys of [["ada", "again"], ["ada", "overlap"]]) {
      const refused = await open(`conflict-${keys.join("-")}`, "app:ada", keys);
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.code).toBe("credential_conflict");
    }
  });

  it("runs a pod turn with the sentinel and the variable; the gateway releases the header for a bound host only", async () => {
    const created = await until("created", () => call("PUT", "/v1/sandboxes/creds", { kind: "pod" }), (reply) => reply.status !== 409);
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const name = podName(tenantId, "creds", created.body.pod.volumeGeneration);
    await until("the pod runs", async () => fake.podUid(name), (uid) => uid !== undefined);
    const workspace = await mkdtemp(join(tmpdir(), "nylorun-creds-ws-"));
    const harnessRoot = await mkdtemp(join(tmpdir(), "nylorun-creds-harness-"));
    const joinFile = join(harnessRoot, "join-token");
    await writeFile(joinFile, fake.joinToken(name)!);
    const host = podHost(
      { sandboxId: "creds", podUid: fake.podUid(name)!, joinFile, httpUrl: listener.url.replace(/^ws/, "http").replace(/\/nylorun.*$/, ""), blocked: [] },
      { info: () => undefined, warn: () => undefined },
    );
    let service: HarnessService | undefined;
    try {
      service = startHarnessService({
        url: listener.url,
        token: () => host.token(),
        paths: { sandboxes: join(harnessRoot, "sandboxes") },
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
      expect((await open("creds-ada", "app:ada", ["ada"], "creds")).status).toBe(200);
      const sent = await call("POST", "/v1/sessions/creds-ada/commands", { type: "message", requestId: "m1", idempotencyKey: "m1", content: "go" });
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
      const done = await until("settles", async () => (await call("GET", "/v1/sessions/creds-ada")).body, (body) =>
        ["completed", "failed", "cancelled"].includes(body.status), 60_000);
      expect(done.status).toBe("completed");
      expect(await readFile(join(workspace, "env.txt"), "utf8")).toBe("nylorun-managed eu-west-1\n");
      const history = await call("GET", "/v1/sessions/creds-ada/history");
      expect(JSON.stringify(history.body)).not.toContain(SECRET);
    } finally {
      host.stop();
      await service?.stop(1_000);
      await rm(workspace, { recursive: true, force: true });
      await rm(harnessRoot, { recursive: true, force: true });
    }

    // What egress-gate reads: the header for a bound host, by any case of its name; nothing elsewhere.
    expect(await gateway((v) => v.releaseEnvironmentSecret({ sandboxId: "creds", host: "API.github.com" }))).toEqual({
      status: "released",
      header: "Authorization",
      value: `Bearer ${SECRET}`,
      credentialId: credentials.gh,
    });
    expect(await gateway((v) => v.environmentSecretBound("creds", "github.com"))).toBe(true);
    expect(await gateway((v) => v.environmentSecretBound("creds", "gist.github.com"))).toBe(false);
    expect(await gateway((v) => v.releaseEnvironmentSecret({ sandboxId: "creds", host: "example.com" }))).toEqual({ status: "none" });

    // A rotation applies to the next release; the binding stays.
    const rotated = await call("POST", `/v1/tenant/vaults/${vaults.ada}/credentials/${credentials.gh}`, {
      requestId: "rot",
      idempotencyKey: "rot",
      auth: { type: "environment_secret", secretValue: ROTATED },
    });
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(200);
    expect(JSON.stringify(rotated.body)).not.toContain(ROTATED);
    expect(await gateway((v) => v.releaseEnvironmentSecret({ sandboxId: "creds", host: "api.github.com" }))).toMatchObject({
      status: "released",
      value: `Bearer ${ROTATED}`,
    });

    // A second owner cannot join a sandbox that serves Ada's secrets, with secrets or without.
    for (const [id, keys] of [["creds-bao", ["bao"]], ["creds-bao-plain", []]] as const) {
      const refused = await open(id, "app:bao", [...keys], "creds");
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.code).toBe("credential_conflict");
    }
    // Ada's second session joins, with a vault that binds the same host to the same credential.
    expect((await open("creds-ada-2", "app:ada", ["ada"], "creds")).status).toBe(200);
  });
});
