import { describe, expect, it } from "vitest";
import type { SessionStore, Tx } from "../src/store/types.js";
import { VaultError } from "../src/vault/error.js";
import { HostModelVault } from "../src/vault/host-model.js";
import { VaultService } from "../src/vault/service.js";
import { hostModelCatalog } from "../src/model/catalog.js";
import { createTestSessionStore } from "./support/store.js";

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

async function setup() {
  const { store, inTx } = tracked(await createTestSessionStore());
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
  return { vault, hostModel, store, read, kekCalls };
}

async function bearer(
  vault: VaultService,
  ownerUserId: string,
  key: string,
  token: string,
  url = URL,
) {
  const created = await vault.createVault({
    requestId: `${key}-vault`,
    idempotencyKey: `${key}-vault`,
    name: "GitHub",
    ownerUserId,
  });
  const credential = await vault.createCredential(created.id, {
    requestId: `${key}-cred`,
    idempotencyKey: `${key}-cred`,
    name: "token",
    auth: { type: "bearer", url, token },
  });
  return { vaultId: created.id, credentialId: credential.id };
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

describe("VaultService administration", () => {
  it("creates vaults idempotently and audits the create", async () => {
    const { vault, read } = await setup();
    const body = {
      requestId: "vault-1",
      idempotencyKey: "vault-ada",
      name: "GitHub",
      ownerUserId: "ada",
      metadata: { team: "core" },
    };
    const created = await vault.createVault(body);
    expect(created).toMatchObject({
      name: "GitHub",
      ownerUserId: "ada",
      metadata: { team: "core" },
    });
    expect(await vault.createVault({ ...body, requestId: "vault-1b" })).toEqual(
      created,
    );
    expect(
      await status(vault.createVault({ ...body, requestId: "c", name: "Other" })),
    ).toBe(409);
    expect(await vault.getVault(created.id)).toEqual(created);
    expect(await vault.listVaults("ada")).toEqual([created]);
    expect(await vault.listVaults("bao")).toEqual([]);
    const audit = await read((t) => t.vaultAudit());
    expect(audit).toEqual([
      expect.objectContaining({
        actor: "application",
        action: "create",
        vaultId: created.id,
        outcome: "created",
      }),
    ]);
  });

  it("stores credentials sealed and never returns the plaintext", async () => {
    const { vault, read } = await setup();
    const { vaultId, credentialId } = await bearer(vault, "ada", "a", ADA_TOKEN);
    const info = await vault.getCredential(vaultId, credentialId);
    expect(info).toMatchObject({
      id: credentialId,
      vaultId,
      type: "bearer",
      binding: { url: URL },
    });
    expect(JSON.stringify(info)).not.toContain(ADA_TOKEN);
    expect(await vault.listCredentials(vaultId)).toEqual([info]);
    const row = await read((t) => t.getCredential(credentialId));
    expect(Buffer.from(row!.ciphertext).includes(Buffer.from(ADA_TOKEN))).toBe(
      false,
    );
    expect(JSON.stringify(row)).not.toContain(ADA_TOKEN);
    expect(await status(vault.getCredential("other", credentialId))).toBe(404);
  });

  it("rotates and deletes credentials with audit rows", async () => {
    const { vault, read } = await setup();
    const { vaultId, credentialId } = await bearer(vault, "ada", "a", ADA_TOKEN);
    const rotated = await vault.rotateCredential(vaultId, credentialId, {
      requestId: "r",
      idempotencyKey: "r",
      auth: { type: "bearer", token: "rotated-token-5511" },
    });
    expect(rotated.rotatedAt).toBeDefined();
    const session = { sessionId: "s1", vaultIds: [vaultId], credentialSelections: [] };
    expect(await vault.authorize({ ...session, url: URL })).toMatchObject({
      status: "authorized",
      headers: { authorization: "Bearer rotated-token-5511" },
    });
    expect(await vault.deleteCredential(vaultId, credentialId)).toEqual({
      id: credentialId,
    });
    expect(await status(vault.deleteCredential(vaultId, credentialId))).toBe(404);
    const actions = (await read((t) => t.vaultAudit({ vaultId }))).map(
      (row) => `${row.action}:${row.outcome}`,
    );
    expect(actions).toEqual([
      "create:created",
      "create:created",
      "rotate:rotated",
      "use:approved",
      "delete:deleted",
    ]);
  });

  it("deletes a vault with its credentials and audits each", async () => {
    const { vault, read } = await setup();
    const { vaultId, credentialId } = await bearer(vault, "ada", "a", ADA_TOKEN);
    expect(await vault.deleteVault(vaultId)).toEqual({ id: vaultId });
    expect(await status(vault.getVault(vaultId))).toBe(404);
    expect(await read((t) => t.getCredential(credentialId))).toBeUndefined();
    const deletes = (await read((t) => t.vaultAudit({ vaultId }))).filter(
      (row) => row.action === "delete",
    );
    expect(deletes.map((row) => row.credentialId)).toEqual([credentialId, null]);
  });
});

describe("VaultService attachment", () => {
  it("checks ownership, scope and selections inside the caller's transaction", async () => {
    const { vault, store } = await setup();
    const ada = await bearer(vault, "ada", "a", ADA_TOKEN);
    const bao = await bearer(vault, "bao", "b", BAO_TOKEN);
    const check = (
      vaultIds: string[],
      selections: { serverName: string; credentialId: string }[] = [],
    ) => status(store.tx((t) => vault.assertAttachment(t, "ada", vaultIds, selections)));
    expect(await check([ada.vaultId])).toBeUndefined();
    expect(await check([bao.vaultId])).toBe(403);
    expect(await check(["missing"])).toBe(404);
    expect(await check([ada.vaultId, ada.vaultId])).toBe(400);
    expect(
      await check(
        [ada.vaultId],
        [{ serverName: "github", credentialId: bao.credentialId }],
      ),
    ).toBe(400);
    expect(
      await check(
        [ada.vaultId],
        [
          { serverName: "github", credentialId: ada.credentialId },
          { serverName: "github", credentialId: ada.credentialId },
        ],
      ),
    ).toBe(400);
  });

  it("records the attachment in the caller's transaction and rolls back with it", async () => {
    const { vault, store, read } = await setup();
    const ada = await bearer(vault, "ada", "a", ADA_TOKEN);
    await expect(
      store.tx(async (t) => {
        await vault.recordAttachment(t, "s-rolled-back", [ada.vaultId]);
        throw new Error("session write failed");
      }),
    ).rejects.toThrow("session write failed");
    await store.tx((t) => vault.recordAttachment(t, "s1", [ada.vaultId]));
    const attach = (await read((t) => t.vaultAudit())).filter(
      (row) => row.action === "attach",
    );
    expect(attach).toEqual([
      expect.objectContaining({
        sessionId: "s1",
        target: ada.vaultId,
        outcome: "attached",
      }),
    ]);
  });
});

describe("VaultService authorize", () => {
  it("leaves unmatched urls unauthenticated and refuses ambiguous matches", async () => {
    const { vault, read, kekCalls } = await setup();
    const ada = await bearer(vault, "ada", "a", ADA_TOKEN);
    const second = await vault.createCredential(ada.vaultId, {
      requestId: "a2",
      idempotencyKey: "a2",
      name: "GitHub other",
      auth: { type: "bearer", url: URL, token: "ada-second-plaintext-token-22ee" },
    });
    const session = { sessionId: "s1", vaultIds: [ada.vaultId] };
    expect(
      await vault.authorize({
        ...session,
        credentialSelections: [],
        url: "https://mcp.example.com/other",
      }),
    ).toEqual({
      status: "unauthenticated",
      url: "https://mcp.example.com/other",
      headers: {},
    });
    const ambiguous = await vault.authorize({
      ...session,
      credentialSelections: [],
      url: URL,
      serverName: "github",
    });
    expect(ambiguous).toMatchObject({ status: "refused", reason: "ambiguous" });
    if (ambiguous.status === "refused")
      expect(ambiguous.credentialIds.sort()).toEqual(
        [ada.credentialId, second.id].sort(),
      );
    const mismatch = await vault.authorize({
      ...session,
      credentialSelections: [{ serverName: "github", credentialId: "nope" }],
      url: URL,
      serverName: "github",
    });
    expect(mismatch).toMatchObject({
      status: "refused",
      reason: "selection_mismatch",
    });
    const selected = await vault.authorize({
      ...session,
      credentialSelections: [{ serverName: "github", credentialId: second.id }],
      url: URL,
      serverName: "github",
    });
    expect(selected).toEqual({
      status: "authorized",
      url: URL,
      headers: { authorization: "Bearer ada-second-plaintext-token-22ee" },
    });
    const uses = (await read((t) => t.vaultAudit())).filter(
      (row) => row.action === "use",
    );
    expect(uses.map((row) => [row.outcome, row.credentialId])).toEqual([
      ["refused", null],
      ["refused", null],
      ["approved", second.id],
    ]);
    expect(JSON.stringify(uses)).not.toContain("plaintext");
    expect(kekCalls.every((inTx) => !inTx)).toBe(true);
  });

  it("refuses a missing vault and audits the refusal", async () => {
    const { vault, read } = await setup();
    const result = await vault.authorize({
      sessionId: "s1",
      vaultIds: ["gone"],
      credentialSelections: [],
      url: URL,
    });
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
    const { vault, read } = await setup();
    const ada = await bearer(vault, "ada", "a", ADA_TOKEN);
    const other = "https://mcp.example.com/other";
    await read((t) =>
      t.updateCredential(ada.vaultId, ada.credentialId, {
        bindingJson: JSON.stringify({ url: other }),
      }),
    );
    const refused = await vault.authorize({
      sessionId: "s1",
      vaultIds: [ada.vaultId],
      credentialSelections: [],
      url: other,
    });
    expect(refused).toEqual({
      status: "refused",
      url: other,
      credentialIds: [ada.credentialId],
      reason: "unreadable",
    });
    expect(JSON.stringify(refused)).not.toContain(ADA_TOKEN);
    expect((await read((t) => t.vaultAudit())).at(-1)).toMatchObject({
      action: "use",
      credentialId: ada.credentialId,
      outcome: "refused",
    });
  });
});

describe("VaultService host model", () => {
  it("keeps the host model credential out of user vaults and responses", async () => {
    const { vault, hostModel, store, read } = await setup();
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
    expect(await vault.listVaults("host")).toEqual([]);
    expect(await status(vault.getVault("host"))).toBe(404);
    expect(
      await status(store.tx((t) => vault.assertAttachment(t, "ada", ["host"], []))),
    ).toBe(400);

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
