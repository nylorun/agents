import { afterEach, describe, expect, it } from "vitest";
import type { PutEnvironmentSecretRequest } from "@nylorun/core/contracts";
import type { Environment, SessionStore, Tx } from "../src/store/types.js";
import { VaultError } from "../src/vault/error.js";
import { HostModelVault } from "../src/vault/host-model.js";
import { VaultService } from "../src/vault/service.js";
import { sessionCredentials } from "../src/vault/sources.js";
import { hostModelCatalog } from "../src/model/catalog.js";
import { createTestSessionStore, dropTestTenant } from "./support/store.js";

const KEK = Buffer.alloc(32, 9);
const ADA_TOKEN = "ada-vault-plaintext-token-7f3c9a2e";
const BAO_TOKEN = "bao-vault-plaintext-token-91ab44c0";
const URL = "https://mcp.example.com/github";

/** Wraps a store so tests can see whether a transaction is open. */
function tracked(inner: SessionStore) {
  let open = 0;
  const store: SessionStore = {
    tenantId: inner.tenantId,
    tx: async (fn) => {
      return inner.tx(async (t) => {
        open += 1;
        try {
          return await fn(t);
        } finally {
          open -= 1;
        }
      });
    },
    onCommit: (listener) => inner.onCommit(listener),
    health: () => inner.health(),
    close: () => inner.close(),
  };
  return { store, inTx: () => open > 0 };
}

/** An Environment row of kind `none`, as `putEnvironment` writes one. */
function environmentRow(id: string): Environment {
  const now = new Date().toISOString();
  const recipe = { harness: "nylorun", lifecycle: {} };
  return {
    id,
    kind: "none",
    labels: {},
    recipe,
    applied: recipe,
    version: 1,
    appliedVersion: 1,
    lastUsedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

/** Each test's store: closed and its database dropped after the test, not all at the file's end. */
const opened: SessionStore[] = [];
afterEach(async () => {
  for (const store of opened.splice(0)) {
    await store.close();
    await dropTestTenant(store.tenantId);
  }
});

async function setup() {
  const inner = await createTestSessionStore();
  opened.push(inner);
  const { store, inTx } = tracked(inner);
  const kekCalls: boolean[] = [];
  const vault = new VaultService({
    store,
    kek: () => {
      kekCalls.push(inTx());
      return KEK;
    },
  });
  const read = <T>(fn: (t: Tx) => Promise<T>) => store.tx(fn);
  // What only the Model Gate holds: the host model's secret in plaintext.
  const hostModel = new HostModelVault({
    store,
    kek: () => {
      kekCalls.push(inTx());
      return KEK;
    },
  });
  /** Creates Environment `id` and its vault, as `PUT /v1/environments/{id}` does. */
  const environment = async (id: string) => {
    await store.tx(async (t) => {
      expect(await t.createEnvironment(environmentRow(id), 100)).toBe("created");
      await vault.createEnvironmentVault(t, id, "application");
    });
    return (await read((t) => t.vaultOfEnvironment(id)))!.id;
  };
  return { vault, hostModel, store, read, kekCalls, environment };
}

/** Environment `environmentId` with a `bearer` secret `name` for `url`. */
async function bearer(
  vault: VaultService,
  environment: (id: string) => Promise<string>,
  environmentId: string,
  token: string,
  url = URL,
  name = "token",
) {
  const vaultId = await environment(environmentId);
  await vault.putEnvironmentSecret(environmentId, name, { type: "bearer", url, value: token }, "application");
  return { vaultId, environmentId, name };
}

async function status(promise: Promise<unknown>): Promise<number | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    if (error instanceof VaultError) return error.status;
    throw error;
  }
}

async function rejection(promise: Promise<unknown>): Promise<VaultError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof VaultError) return error;
    throw error;
  }
  throw new Error("expected a VaultError");
}

/** The id of the credential named `name` in vault `vaultId`. */
async function credentialId(read: <T>(fn: (t: Tx) => Promise<T>) => Promise<T>, vaultId: string, name: string) {
  return (await read((t) => t.credentialByName(vaultId, name)))!.id;
}

describe("VaultService administration", () => {
  it("creates an Environment's vault in the caller's transaction, audits it, and rolls back with it", async () => {
    const { vault, store, read, environment } = await setup();
    await expect(
      store.tx(async (t) => {
        await t.createEnvironment(environmentRow("rolled-back"), 100);
        await vault.createEnvironmentVault(t, "rolled-back", "application");
        throw new Error("environment write failed");
      }),
    ).rejects.toThrow("environment write failed");
    expect(await read((t) => t.vaultOfEnvironment("rolled-back"))).toBeUndefined();
    expect(await read((t) => t.vaultAudit())).toEqual([]);

    const vaultId = await environment("ada/github");
    expect(await read((t) => t.getVault(vaultId))).toMatchObject({ environmentId: "ada/github" });
    expect(await vault.listEnvironmentSecrets("ada/github")).toEqual([]);
    expect(await status(vault.listEnvironmentSecrets("bao/github"))).toBe(404);
    expect(await read((t) => t.vaultAudit())).toEqual([
      expect.objectContaining({
        actor: "application",
        action: "create",
        vaultId,
        target: "ada/github",
        outcome: "created",
      }),
    ]);
  });

  it("stores secrets sealed and never returns the plaintext", async () => {
    const { vault, read, environment } = await setup();
    const { vaultId } = await bearer(vault, environment, "ada", ADA_TOKEN);
    const info = await vault.getEnvironmentSecret("ada", "token");
    expect(info).toMatchObject({ name: "token", type: "bearer", binding: { url: URL } });
    expect(info.rotatedAt).toBeUndefined();
    expect(JSON.stringify(info)).not.toContain(ADA_TOKEN);
    expect(await vault.listEnvironmentSecrets("ada")).toEqual([info]);
    const row = await read((t) => t.credentialByName(vaultId, "token"));
    expect(Buffer.from(row!.ciphertext).includes(Buffer.from(ADA_TOKEN))).toBe(false);
    expect(JSON.stringify(row)).not.toContain(ADA_TOKEN);
    await environment("bao");
    expect(await status(vault.getEnvironmentSecret("bao", "token"))).toBe(404);
    expect(await status(vault.getEnvironmentSecret("missing", "token"))).toBe(404);
  });

  it("replaces a secret by name, deletes it, and audits each", async () => {
    const { vault, read, environment } = await setup();
    const { vaultId } = await bearer(vault, environment, "ada", ADA_TOKEN);
    const id = await credentialId(read, vaultId, "token");
    const rotated = await vault.putEnvironmentSecret(
      "ada",
      "token",
      { type: "bearer", url: URL, value: "rotated-token-5511" },
      "u:ada",
    );
    expect(rotated.rotatedAt).toBeDefined();
    // The same name and type keeps the credential.
    expect(await credentialId(read, vaultId, "token")).toBe(id);
    expect(await vault.authorize({ sessionId: "s1", environmentId: "ada", url: URL })).toMatchObject({
      status: "authorized",
      headers: { authorization: "Bearer rotated-token-5511" },
    });
    expect(await vault.deleteEnvironmentSecret("ada", "token", "u:ada")).toEqual({ id: "token" });
    expect(await status(vault.deleteEnvironmentSecret("ada", "token", "u:ada"))).toBe(404);
    expect(await vault.authorize({ sessionId: "s1", environmentId: "ada", url: URL })).toEqual({
      status: "unauthenticated",
      url: URL,
      headers: {},
    });
    const audit = await read((t) => t.vaultAudit({ vaultId }));
    expect(audit.map((row) => `${row.action}:${row.outcome}`)).toEqual([
      "create:created",
      "create:created",
      "rotate:rotated",
      "use:approved",
      "delete:deleted",
    ]);
    expect(audit.slice(2).filter((row) => row.action !== "use").map((row) => row.actor)).toEqual(["u:ada", "u:ada"]);
    expect(audit.slice(1).every((row) => row.credentialId === id)).toBe(true);
  });

  it("replaces a secret of another type under the same name with a new credential", async () => {
    const { vault, read, environment } = await setup();
    const { vaultId } = await bearer(vault, environment, "ada", ADA_TOKEN);
    const id = await credentialId(read, vaultId, "token");
    const replaced = await vault.putEnvironmentSecret(
      "ada",
      "token",
      { type: "headers", url: URL, headers: { "X-Api-Key": BAO_TOKEN } },
      "application",
    );
    expect(replaced).toMatchObject({ type: "headers", headerNames: ["x-api-key"] });
    expect(replaced.rotatedAt).toBeUndefined();
    const next = await credentialId(read, vaultId, "token");
    expect(next).not.toBe(id);
    expect(await read((t) => t.getCredential(id))).toBeUndefined();
    expect(await vault.authorize({ environmentId: "ada", url: URL })).toMatchObject({
      status: "authorized",
      headers: { "x-api-key": BAO_TOKEN },
    });
    expect(
      (await read((t) => t.vaultAudit({ vaultId }))).map((row) => [row.action, row.credentialId]),
    ).toEqual([
      ["create", null],
      ["create", id],
      ["delete", id],
      ["create", next],
      ["use", next],
    ]);
  });

  it("refuses a second credential for a URL or a host (credential_conflict), and writes nothing", async () => {
    const { vault, read, environment } = await setup();
    const { vaultId } = await bearer(vault, environment, "ada", ADA_TOKEN);
    // The same URL, normalized: the default port and the case of the host do not make another.
    for (const [name, url] of [
      ["second", URL],
      ["third", "https://MCP.example.com:443/github"],
    ] as const) {
      const refused = await rejection(
        vault.putEnvironmentSecret("ada", name, { type: "headers", url, headers: { "x-api-key": "k" } }, "application"),
      );
      expect(refused.status).toBe(409);
      expect(refused.rejection).toEqual({ code: "credential_conflict", details: { url: URL, existing: "token" } });
    }
    // Another path is another URL.
    await vault.putEnvironmentSecret(
      "ada",
      "other",
      { type: "bearer", url: "https://mcp.example.com/other", value: BAO_TOKEN },
      "application",
    );

    await vault.putEnvironmentSecret(
      "ada",
      "GH_TOKEN",
      { type: "environment_secret", value: "gh-secret-value", allowedHosts: ["api.github.com", "uploads.github.com"] },
      "application",
    );
    const overlap = await rejection(
      vault.putEnvironmentSecret(
        "ada",
        "GITHUB_TOKEN",
        { type: "environment_secret", value: "another-value", allowedHosts: ["UPLOADS.github.com"] } as PutEnvironmentSecretRequest,
        "application",
      ),
    );
    expect(overlap.status).toBe(409);
    expect(overlap.rejection).toEqual({
      code: "credential_conflict",
      details: { host: "uploads.github.com", existing: "GH_TOKEN" },
    });
    // Replacing the one bound to the host is no conflict with itself.
    await vault.putEnvironmentSecret(
      "ada",
      "GH_TOKEN",
      { type: "environment_secret", value: "gh-secret-rotated", allowedHosts: ["uploads.github.com"] },
      "application",
    );
    // Another Environment's vault is another vault.
    await bearer(vault, environment, "bao", BAO_TOKEN);
    expect((await vault.listEnvironmentSecrets("ada")).map((secret) => secret.name)).toEqual([
      "GH_TOKEN",
      "other",
      "token",
    ]);
    expect(
      (await read((t) => t.vaultAudit({ vaultId }))).map((row) => `${row.action}:${row.outcome}`),
    ).toEqual(["create:created", "create:created", "create:created", "create:created", "rotate:rotated"]);
  });

  it("deletes an Environment's vault with its credentials and audits each", async () => {
    const { vault, store, read, environment } = await setup();
    const { vaultId } = await bearer(vault, environment, "ada", ADA_TOKEN);
    const id = await credentialId(read, vaultId, "token");
    await store.tx((t) => vault.deleteEnvironmentVault(t, "ada", "u:ada"));
    expect(await read((t) => t.getVault(vaultId))).toBeUndefined();
    expect(await read((t) => t.getCredential(id))).toBeUndefined();
    const deletes = (await read((t) => t.vaultAudit({ vaultId }))).filter((row) => row.action === "delete");
    expect(deletes.map((row) => [row.credentialId, row.actor, row.target])).toEqual([
      [id, "u:ada", "ada"],
      [null, "u:ada", "ada"],
    ]);
    // A session that names it sends nothing and is refused: its vault is gone.
    expect(await vault.authorize({ sessionId: "s1", environmentId: "ada", url: URL })).toMatchObject({
      status: "refused",
      reason: "vault_missing",
    });
    // Deleting it again is a no-op.
    await store.tx((t) => vault.deleteEnvironmentVault(t, "ada", "u:ada"));
  });

  it("refuses a name its type does not allow, and a reserved variable", async () => {
    const { vault, environment } = await setup();
    await environment("ada");
    expect(
      await status(vault.putEnvironmentSecret("ada", "has space", { type: "bearer", url: URL, value: "t" }, "application")),
    ).toBe(400);
    expect(
      await status(vault.putEnvironmentSecret("ada", "1BAD", { type: "environment_variable", value: "v" }, "application")),
    ).toBe(400);
    expect(
      await status(vault.putEnvironmentSecret("ada", "PATH", { type: "environment_variable", value: "v" }, "application")),
    ).toBe(400);
    expect(await vault.listEnvironmentSecrets("ada")).toEqual([]);
  });
});

describe("VaultService authorize", () => {
  it("leaves unmatched urls and sessions without an Environment unauthenticated", async () => {
    const { vault, read, kekCalls, environment } = await setup();
    const { vaultId } = await bearer(vault, environment, "ada", ADA_TOKEN);
    const id = await credentialId(read, vaultId, "token");
    expect(
      await vault.authorize({ sessionId: "s1", environmentId: "ada", url: "https://mcp.example.com/other" }),
    ).toEqual({
      status: "unauthenticated",
      url: "https://mcp.example.com/other",
      headers: {},
    });
    expect(await vault.authorize({ sessionId: "s1", url: URL })).toEqual({
      status: "unauthenticated",
      url: URL,
      headers: {},
    });
    expect(await vault.authorize({ sessionId: "s1", environmentId: "ada", url: URL })).toEqual({
      status: "authorized",
      url: URL,
      headers: { authorization: `Bearer ${ADA_TOKEN}` },
    });
    const uses = (await read((t) => t.vaultAudit())).filter((row) => row.action === "use");
    expect(uses.map((row) => [row.outcome, row.credentialId, row.sessionId])).toEqual([
      ["approved", id, "s1"],
    ]);
    expect(JSON.stringify(uses)).not.toContain("plaintext");
    expect(kekCalls.every((inTx) => !inTx)).toBe(true);
  });

  it("refuses a missing vault and audits the refusal", async () => {
    const { vault, read } = await setup();
    const result = await vault.authorize({ sessionId: "s1", environmentId: "gone", url: URL });
    expect(result).toEqual({
      status: "refused",
      url: URL,
      credentialIds: [],
      reason: "vault_missing",
    });
    expect(await read((t) => t.vaultAudit())).toEqual([
      expect.objectContaining({ action: "use", sessionId: "s1", outcome: "refused" }),
    ]);
  });

  it("refuses a credential whose binding no longer matches its ciphertext", async () => {
    const { vault, read, environment } = await setup();
    const { vaultId } = await bearer(vault, environment, "ada", ADA_TOKEN);
    const id = await credentialId(read, vaultId, "token");
    const other = "https://mcp.example.com/other";
    await read((t) => t.updateCredential(vaultId, id, { bindingJson: JSON.stringify({ url: other }) }));
    const refused = await vault.authorize({ sessionId: "s1", environmentId: "ada", url: other });
    expect(refused).toEqual({
      status: "refused",
      url: other,
      credentialIds: [id],
      reason: "unreadable",
    });
    expect(JSON.stringify(refused)).not.toContain(ADA_TOKEN);
    expect((await read((t) => t.vaultAudit())).at(-1)).toMatchObject({
      action: "use",
      credentialId: id,
      outcome: "refused",
    });
  });
});

describe("VaultService header and gateway credentials (R2b C2)", () => {
  const DD_API = "datadog-api-key-plaintext-0f9e8d7c";
  const DD_APP = "datadog-app-key-plaintext-6b5a4f3e";
  const GATEWAY = "https://gateway.example.com/mcp/datadog";

  it("creates, lists and authorizes a header map with via and an identity header, sealed", async () => {
    const { vault, read, environment } = await setup();
    const vaultId = await environment("shared");
    const info = await vault.putEnvironmentSecret(
      "shared",
      "datadog",
      {
        type: "headers",
        url: URL,
        headers: { "DD-API-KEY": DD_API, "DD-APPLICATION-KEY": DD_APP },
        via: GATEWAY,
        identity: { header: "X-User-Id" },
      },
      "application",
    );
    expect(info).toMatchObject({
      name: "datadog",
      type: "headers",
      binding: { url: URL },
      headerNames: ["dd-api-key", "dd-application-key"],
      via: GATEWAY,
      identity: { header: "x-user-id" },
    });
    expect(await vault.listEnvironmentSecrets("shared")).toEqual([info]);
    for (const secret of [DD_API, DD_APP]) {
      expect(JSON.stringify(info)).not.toContain(secret);
      const row = await read((t) => t.credentialByName(vaultId, "datadog"));
      expect(JSON.stringify(row)).not.toContain(secret);
      expect(Buffer.from(row!.ciphertext).includes(Buffer.from(secret))).toBe(false);
    }
    // Matched by the manifest's URL, never by `via`.
    const session = { sessionId: "s1", environmentId: "shared" };
    expect(await vault.authorize({ ...session, url: GATEWAY })).toMatchObject({
      status: "unauthenticated",
    });
    expect(await vault.authorize({ ...session, url: URL })).toEqual({
      status: "authorized",
      url: URL,
      headers: { "dd-api-key": DD_API, "dd-application-key": DD_APP },
      via: GATEWAY,
      identity: { header: "x-user-id" },
    });
  });

  it("replaces the secret with its routing: via and identity are what the last write sent", async () => {
    const { vault, environment } = await setup();
    await environment("shared");
    const put = (body: Record<string, unknown>) =>
      vault.putEnvironmentSecret(
        "shared",
        "datadog",
        { type: "headers", url: URL, ...body } as PutEnvironmentSecretRequest,
        "application",
      );
    await put({ headers: { "x-api-key": DD_API }, via: GATEWAY, identity: { header: "x-user-id" } });
    const session = { sessionId: "s1", environmentId: "shared", url: URL };
    const kept = await put({
      headers: { "x-api-key": "rotated-api-key-1234", "x-account": "acct-0001" },
      via: GATEWAY,
      identity: { header: "x-user-id" },
    });
    expect(kept).toMatchObject({ via: GATEWAY, identity: { header: "x-user-id" }, headerNames: ["x-api-key", "x-account"] });
    expect(kept.rotatedAt).toBeDefined();
    expect(await vault.authorize(session)).toMatchObject({
      headers: { "x-api-key": "rotated-api-key-1234", "x-account": "acct-0001" },
      via: GATEWAY,
    });
    const moved = await put({ headers: { "x-api-key": "rotated-api-key-5678" }, via: "https://other.example.com/mcp" });
    expect(moved.via).toBe("https://other.example.com/mcp");
    expect(moved.identity).toBeUndefined();
    const direct = await put({ headers: { "x-api-key": "rotated-api-key-9999" } });
    expect(direct.via).toBeUndefined();
    expect(await vault.authorize(session)).toEqual({
      status: "authorized",
      url: URL,
      headers: { "x-api-key": "rotated-api-key-9999" },
    });
  });

  it("accepts a bearer token with via and an identity header", async () => {
    const { vault, environment } = await setup();
    await bearer(vault, environment, "ada", ADA_TOKEN, "https://mcp.example.com/unused");
    const created = await vault.putEnvironmentSecret(
      "ada",
      "own",
      { type: "bearer", url: URL, value: BAO_TOKEN, via: GATEWAY, identity: { header: "x-user-id" } },
      "application",
    );
    expect(created).toMatchObject({ type: "bearer", via: GATEWAY, identity: { header: "x-user-id" } });
    expect(created.headerNames).toBeUndefined();
    expect(await vault.authorize({ sessionId: "s1", environmentId: "ada", url: URL })).toMatchObject({
      headers: { authorization: `Bearer ${BAO_TOKEN}` },
      via: GATEWAY,
    });
  });

  it("refuses the transport's headers and Nylorun-* in the map and as the identity header", async () => {
    const { vault, environment } = await setup();
    await environment("shared");
    const create = (key: string, auth: Record<string, unknown>) =>
      status(
        vault.putEnvironmentSecret(
          "shared",
          key,
          { type: "headers", url: URL, headers: { "x-api-key": "k" }, ...auth } as PutEnvironmentSecretRequest,
          "application",
        ),
      );
    for (const name of ["Content-Type", "mcp-session-id", "Host", "Nylorun-Session-Id", "idempotency-key"])
      expect(await create(`h-${name}`, { headers: { [name]: "v" } }), name).toBe(400);
    for (const header of ["nylorun-subject", "accept", "x-api-key", "X-API-KEY"])
      expect(await create(`i-${header}`, { identity: { header } }), header).toBe(400);
    expect(
      await status(
        vault.putEnvironmentSecret(
          "shared",
          "b",
          { type: "bearer", url: URL, value: "t", identity: { header: "Authorization" } },
          "application",
        ),
      ),
    ).toBe(400);
    expect(await vault.listEnvironmentSecrets("shared")).toEqual([]);
  });
});

describe("sessionCredentials identity header (R2b C2)", () => {
  it("names a person's session owner, and nobody for an installation session", async () => {
    const { vault, environment } = await setup();
    await environment("shared");
    await vault.putEnvironmentSecret(
      "shared",
      "gateway",
      { type: "bearer", url: URL, value: ADA_TOKEN, via: "https://gateway.example.com/mcp", identity: { header: "X-User-Id" } },
      "application",
    );
    const person = await sessionCredentials(vault, { id: "s1", ownerUserId: "u:ada", environmentId: "shared" }, { url: URL });
    expect(person).toMatchObject({
      status: "authorized",
      headers: { authorization: `Bearer ${ADA_TOKEN}`, "x-user-id": "u:ada" },
      via: "https://gateway.example.com/mcp",
    });
    const scheduled = await sessionCredentials(
      vault,
      { id: "s2", ownerUserId: "installation", environmentId: "shared" },
      { url: URL },
    );
    expect(scheduled.status === "authorized" && scheduled.headers).toEqual({ authorization: `Bearer ${ADA_TOKEN}` });
    // A session that names no Environment sends nothing.
    expect(await sessionCredentials(vault, { id: "s3", ownerUserId: "u:ada" }, { url: URL })).toEqual({
      status: "unauthenticated",
      url: URL,
      headers: {},
    });
  });
});

describe("VaultService host model", () => {
  it("keeps the host model credential out of Environment vaults and responses", async () => {
    const { vault, hostModel, read } = await setup();
    const secret = "host-model-plaintext-key-77ab";
    expect(await vault.getHostModel()).toEqual({ configured: false });
    expect(await hostModel.readHostModel()).toBeUndefined();
    const body = {
      requestId: "host-1",
      idempotencyKey: "host-model",
      provider: "custom",
      model: "fixture",
      baseUrl: "https://models.example.test/v1",
      auth: { type: "api_key" as const, key: secret },
    };
    const saved = await vault.putHostModel(body);
    expect(saved).toEqual({
      configured: true,
      provider: "custom",
      model: "fixture",
      authType: "api_key",
      baseUrl: "https://models.example.test/v1",
    });
    expect(await vault.putHostModel({ ...body, requestId: "host-2" })).toEqual(saved);
    expect(await status(vault.putHostModel({ ...body, model: "other" }))).toBe(409);
    expect(await hostModel.readHostModel()).toEqual({
      provider: "custom",
      model: "fixture",
      baseUrl: "https://models.example.test/v1",
      authType: "api_key",
      credential: { type: "api_key", key: secret },
    });
    // The host vault is no Environment's: no secret route and no session reaches it.
    expect(await status(vault.listEnvironmentSecrets("host"))).toBe(404);
    expect(await status(vault.getEnvironmentSecret("host", "custom"))).toBe(404);
    expect(await vault.authorize({ sessionId: "s1", environmentId: "host", url: "https://models.example.test/v1" })).toMatchObject({
      status: "refused",
      reason: "vault_missing",
    });

    const openaiModel =
      hostModelCatalog().providers.find((provider) => provider.id === "openai")
        ?.models[0]?.id ?? "gpt-4o-mini";
    expect(
      await vault.putHostModel({
        requestId: "host-3",
        idempotencyKey: "host-model-openai",
        provider: "openai",
        model: openaiModel,
        auth: { type: "api_key", key: `${secret}-openai` },
      }),
    ).toMatchObject({ configured: true, provider: "openai" });
    const both = await vault.listHostProviders();
    expect(both.providers.map((provider) => [provider.id, provider.active])).toEqual(
      expect.arrayContaining([
        ["custom", false],
        ["openai", true],
      ]),
    );
    expect(JSON.stringify(both)).not.toContain(secret);

    expect(
      await vault.selectHostModel({
        requestId: "host-4",
        idempotencyKey: "host-model-select-custom",
        provider: "custom",
        model: "other-fixture",
        baseUrl: "https://models.example.test/v2",
      }),
    ).toMatchObject({ configured: true, provider: "custom", model: "other-fixture" });
    expect((await hostModel.readHostModel())?.credential).toEqual({
      type: "api_key",
      key: secret,
    });

    await hostModel.updateHostCredential({ type: "api_key", key: `${secret}-new` });
    expect((await hostModel.readHostModel())?.credential).toEqual({
      type: "api_key",
      key: `${secret}-new`,
    });

    const rows = await read((t) => t.credentialsForVault("host"));
    expect(rows.map((row) => row.type)).toEqual(["model", "model"]);
    expect(JSON.stringify(rows)).not.toContain(secret);
    for (const row of rows)
      expect(Buffer.from(row.ciphertext).includes(Buffer.from(secret))).toBe(false);
  });

  it("keeps a custom endpoint's model settings, also across a model selection", async () => {
    const { vault, hostModel } = await setup();
    const settings = {
      contextWindow: 16_384,
      maxTokens: 2_048,
      reasoning: true,
      compat: { thinkingFormat: "qwen-chat-template" },
    };
    expect(
      await vault.putHostModel({
        requestId: "settings-1",
        idempotencyKey: "settings-1",
        provider: "custom",
        model: "qwen3-8b",
        baseUrl: "http://127.0.0.1:8000/v1",
        settings,
        auth: { type: "api_key", key: "local" },
      }),
    ).toMatchObject({ configured: true, settings });
    expect((await hostModel.readHostModel())?.settings).toEqual(settings);
    await vault.selectHostModel({
      requestId: "settings-2",
      idempotencyKey: "settings-2",
      provider: "custom",
      model: "qwen3-14b",
      baseUrl: "http://127.0.0.1:8000/v1",
    });
    expect(await hostModel.readHostModel()).toMatchObject({ model: "qwen3-14b", settings });
    expect((await vault.listHostProviders()).providers[0]?.settings).toEqual(settings);
  });

  it("refuses model settings for a catalog provider", async () => {
    const { vault, hostModel } = await setup();
    const openaiModel =
      hostModelCatalog().providers.find((provider) => provider.id === "openai")
        ?.models[0]?.id ?? "gpt-4o-mini";
    expect(
      await status(
        vault.putHostModel({
          requestId: "settings-3",
          idempotencyKey: "settings-3",
          provider: "openai",
          model: openaiModel,
          settings: { contextWindow: 8_192 },
          auth: { type: "api_key", key: "k" },
        }),
      ),
    ).toBe(400);
  });

  it("validates providers before writing", async () => {
    const { vault, hostModel, read } = await setup();
    expect(
      await status(
        vault.putHostModel({
          requestId: "x",
          idempotencyKey: "x",
          provider: "custom",
          model: "m",
          auth: { type: "api_key", key: "k" },
        }),
      ),
    ).toBe(400);
    expect(
      await status(
        vault.selectHostModel({
          requestId: "y",
          idempotencyKey: "y",
          provider: "custom",
          model: "m",
          baseUrl: "https://models.example.test/v1",
        }),
      ),
    ).toBe(404);
    expect(
      await status(hostModel.updateHostCredential({ type: "api_key", key: "k" })),
    ).toBe(404);
    expect(await read((t) => t.vaultAudit())).toEqual([]);
    expect(await read((t) => t.getVault("host"))).toBeUndefined();
  });
});
