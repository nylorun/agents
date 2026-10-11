import { rm } from "node:fs/promises";
import { TenantRuntime } from "../src/tenant/runtime.js";
import { openTestSessionStore, withTestSessionStore } from "./support/store.js";
import { expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import { startTestTenant } from "./support/tenant.js";
import { putEnvironment, putSecret, writeSecret } from "./support/environment-secrets.js";

const KEK = Buffer.alloc(32, 9).toString("base64");
const ADA_TOKEN = "ada-vault-plaintext-token-7f3c9a2e";
const BAO_TOKEN = "bao-vault-plaintext-token-91ab44c0";
const URL = "https://mcp.example.com/github";
const APP = "server-token-value-aaaaaaaa";
const MANAGEMENT = "management-token-value-aaaaaaaa";

const server = {
  authorization: `Bearer ${APP}`,
  "content-type": "application/json",
};
/** The Management API's key (protocol 8): the Tenant's settings. */
const management = {
  authorization: `Bearer ${MANAGEMENT}`,
  "content-type": "application/json",
};
/** The application acting for another person: secret writes and Tenant routes refuse it. */
const actingForBao = {
  ...server,
  "nylorun-subject": "bao",
  "nylorun-scopes": "sessions:own",
};

type BootOpts = {
  vaultKek?: string | null;
  hostRoot?: string;
  tenantId?: string;
  retainRoot?: boolean;
};

async function boot(options: BootOpts = {}) {
  const runtime = await startTestTenant({
    applicationKey: APP,
    managementKey: MANAGEMENT,
    vaultKek: options.vaultKek === undefined ? KEK : options.vaultKek,
    ...(options.hostRoot ? { hostRoot: options.hostRoot } : {}),
    ...(options.tenantId ? { tenantId: options.tenantId } : {}),
    ...(options.retainRoot ? { retainRoot: true } : {}),
  });
  const handle = runtime.handle as TenantRuntime;
  return {
    url: runtime.url,
    close: () => runtime.close(),
    applicationKey: runtime.applicationKey,
    tenantId: runtime.tenantId,
    root: runtime.root,
    // With `NYLORUN_TEST_MODEL_GATE=http` the gateway authorizes remote MCP servers (F4.1):
    // the runtime never holds the vault key that unseals the credentials.
    authorize: runtime.gate
      ? runtime.gate.authorizeMcp
      : handle.authorize.bind(handle),
  };
}

async function json(response: Response) {
  return { status: response.status, body: await response.json() };
}

it("stores bearer credentials without returning or persisting the plaintext", async () => {
  const runtime = await boot();
  try {
    await putEnvironment(runtime.url, server, "ada");
    const credential = await writeSecret(runtime.url, server, "ada", "github", {
      type: "bearer",
      url: URL,
      value: ADA_TOKEN,
    });
    expect(credential.status).toBe(200);
    expect(JSON.stringify(credential.body)).not.toContain(ADA_TOKEN);
    expect(credential.body).toMatchObject({ name: "github", type: "bearer", binding: { url: URL } });
    const read = await json(
      await fetch(`${runtime.url}/v1/environments/ada/secrets/github`, { headers: server }),
    );
    expect(read.status).toBe(200);
    expect(JSON.stringify(read.body)).not.toContain(ADA_TOKEN);
    expect(read.body).toEqual(credential.body);
    const listed = await json(await fetch(`${runtime.url}/v1/environments/ada/secrets`, { headers: server }));
    expect(listed.body).toEqual({ secrets: [credential.body] });
    // The same name and type replaces the value; the answer never carries either.
    const replaced = await writeSecret(runtime.url, server, "ada", "github", {
      type: "bearer",
      url: URL,
      value: BAO_TOKEN,
    });
    expect(replaced.status).toBe(200);
    expect(replaced.body).toMatchObject({ name: "github", rotatedAt: expect.any(String) });
    expect(JSON.stringify(replaced.body)).not.toContain(BAO_TOKEN);
    // A second credential for the URL is refused at write.
    const conflict = await writeSecret(runtime.url, server, "ada", "github-other", {
      type: "bearer",
      url: URL,
      value: "ada-second-plaintext-token-22ee",
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ code: "credential_conflict" });
    // Acting for a person without environments:write, and with the management key: refused.
    expect(
      (await writeSecret(runtime.url, actingForBao, "ada", "x", { type: "bearer", url: URL, value: "t" })).status,
    ).toBe(403);
    expect(
      [401, 403],
    ).toContain((await writeSecret(runtime.url, management, "ada", "x", { type: "bearer", url: URL, value: "t" })).status);
    expect((await fetch(`${runtime.url}/v1/environments/ada/secrets/x`, { headers: server })).status).toBe(404);
  } finally {
    await runtime.close();
    await rm(runtime.root, { recursive: true, force: true });
  }
});

/** Puts agent `bot` and Ada's session `s-ada`, naming Environment `environmentId`. */
async function attach(runtime: { url: string }, environmentId: string) {
  const agent = Agent({ id: "bot", name: "Bot" }).build();
  expect(
    (
      await fetch(`${runtime.url}/v1/agents/bot`, {
        method: "PUT",
        headers: server,
        body: JSON.stringify({
          requestId: "agent",
          manifest: agent.manifest,
          implementationVersion: "dev",
        }),
      })
    ).ok,
  ).toBe(true);
  expect(
    (
      await fetch(`${runtime.url}/v1/sessions/s-ada`, {
        method: "PUT",
        headers: server,
        body: JSON.stringify({
          requestId: "session",
          agentId: "bot",
          ownerUserId: "ada",
          environment: environmentId,
        }),
      })
    ).ok,
  ).toBe(true);
}

it("keeps ciphertext unreadable without the key-encryption key", async () => {
  const runtime = await boot({ retainRoot: true });
  const { root, tenantId } = runtime;
  let vaultId = "";
  try {
    await putEnvironment(runtime.url, server, "ada");
    await putSecret(runtime.url, server, "ada", "token", { type: "bearer", url: URL, value: ADA_TOKEN });
    await attach(runtime, "ada");
  } finally {
    await runtime.close();
  }
  // No stored column holds the plaintext.
  const rows = await withTestSessionStore({ root, tenantId }, (store) =>
    store.tx(async (t) => {
      vaultId = (await t.vaultOfEnvironment("ada"))!.id;
      return t.credentialsForVault(vaultId);
    }),
  );
  expect(rows).toHaveLength(1);
  const credentialId = rows[0]!.id;
  for (const value of Object.values(rows[0]!))
    expect(
      Buffer.from(
        value instanceof Uint8Array ? value : String(value),
      ).includes(Buffer.from(ADA_TOKEN)),
    ).toBe(false);
  if (process.env.NYLORUN_TEST_MODEL_GATE === "http") {
    // The runtime never reads the vault key (F4.2), so it opens without one; the gateway,
    // which alone holds the key, refuses to unseal the credential.
    const keyless = await boot({ hostRoot: root, tenantId, vaultKek: null });
    try {
      await expect(keyless.authorize("s-ada", { url: URL })).rejects.toThrow(
        /key-encryption key|kek-missing/i,
      );
    } finally {
      await keyless.close();
    }
  } else {
    await expect(
      boot({ hostRoot: root, tenantId, vaultKek: null }),
    ).rejects.toThrow(/key-encryption key|kek-missing/i);
  }
  const db = await openTestSessionStore({ root, tenantId });
  await db.tx(async (t) => {
    await t.updateCredential(vaultId, credentialId, {
      bindingJson: JSON.stringify({ url: "https://mcp.example.com/other" }),
    });
  });
  await db.close();
  const again = await boot({ hostRoot: root, tenantId });
  try {
    const refused = await again.authorize("s-ada", {
      url: "https://mcp.example.com/other",
    });
    expect(refused.status).toBe("refused");
    expect(JSON.stringify(refused)).not.toContain(ADA_TOKEN);
  } finally {
    await again.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("sends the credentials of the Environment a session names, behind its owner guard", async () => {
  const runtime = await boot();
  try {
    const agent = Agent({ id: "bot", name: "Bot" }).build();
    expect(
      (
        await fetch(`${runtime.url}/v1/agents/bot`, {
          method: "PUT",
          headers: server,
          body: JSON.stringify({
            requestId: "agent",
            manifest: agent.manifest,
            implementationVersion: "dev",
          }),
        })
      ).ok,
    ).toBe(true);
    await putEnvironment(runtime.url, server, "users/ada", { kind: "none", ownerUserId: "ada" });
    await putSecret(runtime.url, server, "users/ada", "token", { type: "bearer", url: URL, value: ADA_TOKEN });
    await putEnvironment(runtime.url, server, "users/bao", { kind: "none", ownerUserId: "bao" });
    await putSecret(runtime.url, server, "users/bao", "token", { type: "bearer", url: URL, value: BAO_TOKEN });
    const foreign = await json(
      await fetch(`${runtime.url}/v1/sessions/s-ada`, {
        method: "PUT",
        headers: server,
        body: JSON.stringify({
          requestId: "s",
          agentId: "bot",
          ownerUserId: "ada",
          environment: "users/bao",
        }),
      }),
    );
    expect(foreign.status).toBe(403);
    expect(foreign.body).toMatchObject({ code: "environment_owner_mismatch" });
    const session = await json(
      await fetch(`${runtime.url}/v1/sessions/s-ada`, {
        method: "PUT",
        headers: server,
        body: JSON.stringify({
          requestId: "s2",
          agentId: "bot",
          ownerUserId: "ada",
          environment: "users/ada",
        }),
      }),
    );
    expect(session.status).toBe(200);
    expect(session.body).toMatchObject({ environment: { id: "users/ada", version: 1 } });
    expect(
      await runtime.authorize("s-ada", { url: "https://mcp.example.com/other" }),
    ).toMatchObject({ status: "unauthenticated", headers: {} });
    expect(await runtime.authorize("s-ada", { url: URL, serverName: "github" })).toMatchObject({
      status: "authorized",
      headers: { authorization: `Bearer ${ADA_TOKEN}` },
    });
    // A replaced value is used from the next request.
    await putSecret(runtime.url, server, "users/ada", "token", {
      type: "bearer",
      url: URL,
      value: "ada-second-plaintext-token-22ee",
    });
    expect(await runtime.authorize("s-ada", { url: URL, serverName: "github" })).toMatchObject({
      status: "authorized",
      headers: { authorization: "Bearer ada-second-plaintext-token-22ee" },
    });
    const baoSession = await json(
      await fetch(`${runtime.url}/v1/sessions/s-bao`, {
        method: "PUT",
        headers: server,
        body: JSON.stringify({
          requestId: "bao",
          agentId: "bot",
          ownerUserId: "bao",
          environment: "users/bao",
        }),
      }),
    );
    expect(baoSession.status).toBe(200);
    expect(await runtime.authorize("s-bao", { url: URL })).toMatchObject({
      status: "authorized",
      headers: { authorization: `Bearer ${BAO_TOKEN}` },
    });
    // A session that names no Environment sends nothing.
    const bare = await json(
      await fetch(`${runtime.url}/v1/sessions/s-bare`, {
        method: "PUT",
        headers: server,
        body: JSON.stringify({ requestId: "bare", agentId: "bot", ownerUserId: "ada" }),
      }),
    );
    expect(bare.status).toBe(200);
    expect(bare.body).toMatchObject({ environment: null });
    expect(await runtime.authorize("s-bare", { url: URL })).toMatchObject({
      status: "unauthenticated",
      headers: {},
    });
  } finally {
    await runtime.close();
    await rm(runtime.root, { recursive: true, force: true });
  }
});

it("keeps the host model credential out of Environment vaults and responses", async () => {
  const runtime = await boot({ retainRoot: true });
  const secret = "host-model-plaintext-key-77ab";
  try {
    const agent = Agent({ id: "bot", name: "Bot" }).build();
    expect(
      (
        await fetch(`${runtime.url}/v1/agents/bot`, {
          method: "PUT",
          headers: server,
          body: JSON.stringify({
            requestId: "agent",
            manifest: agent.manifest,
            implementationVersion: "dev",
          }),
        })
      ).ok,
    ).toBe(true);
    expect(
      (await json(await fetch(`${runtime.url}/v1/tenant/model`, { headers: management })))
        .body,
    ).toEqual({ configured: false });
    expect(
      (
        await fetch(`${runtime.url}/v1/tenant/model`, { headers: actingForBao })
      ).status,
    ).toBe(403);
    const body = {
      requestId: "host-1",
      idempotencyKey: "host-model",
      provider: "custom",
      model: "fixture",
      baseUrl: "https://models.example.test/v1",
      auth: { type: "api_key", key: secret },
    };
    const saved = await json(
      await fetch(`${runtime.url}/v1/tenant/model`, {
        method: "PUT",
        headers: management,
        body: JSON.stringify(body),
      }),
    );
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      configured: true,
      provider: "custom",
      model: "fixture",
      authType: "api_key",
      baseUrl: "https://models.example.test/v1",
    });
    expect(JSON.stringify(saved.body)).not.toContain(secret);
    const replay = await json(
      await fetch(`${runtime.url}/v1/tenant/model`, {
        method: "PUT",
        headers: management,
        body: JSON.stringify({ ...body, requestId: "host-2" }),
      }),
    );
    expect(replay.body).toEqual(saved.body);
    const conflict = await json(
      await fetch(`${runtime.url}/v1/tenant/model`, {
        method: "PUT",
        headers: management,
        body: JSON.stringify({ ...body, model: "other" }),
      }),
    );
    expect(conflict.status).toBe(409);
    const catalog = await json(
      await fetch(`${runtime.url}/v1/tenant/models`, { headers: management }),
    );
    expect(JSON.stringify(catalog.body)).not.toContain(secret);
    // The host vault is no Environment's.
    expect(
      (await fetch(`${runtime.url}/v1/environments/host/secrets`, { headers: server })).status,
    ).toBe(404);
    const listed = await json(
      await fetch(`${runtime.url}/v1/tenant/providers`, { headers: management }),
    );
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({
      providers: [
        {
          id: "custom",
          name: "Custom OpenAI-compatible",
          model: "fixture",
          authType: "api_key",
          active: true,
        },
      ],
    });
    expect(JSON.stringify(listed.body)).not.toContain(secret);
    const second = await json(
      await fetch(`${runtime.url}/v1/tenant/model`, {
        method: "PUT",
        headers: management,
        body: JSON.stringify({
          requestId: "host-3",
          idempotencyKey: "host-model-second",
          provider: "custom",
          model: "other-fixture",
          baseUrl: "https://models.example.test/v2",
          auth: { type: "api_key", key: `${secret}-2` },
        }),
      }),
    );
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      configured: true,
      provider: "custom",
      model: "other-fixture",
    });
    const afterSecond = await json(
      await fetch(`${runtime.url}/v1/tenant/providers`, { headers: management }),
    );
    expect(afterSecond.body).toMatchObject({
      providers: [
        {
          id: "custom",
          model: "other-fixture",
          active: true,
        },
      ],
    });
    const openai = await json(
      await fetch(`${runtime.url}/v1/tenant/model`, {
        method: "PUT",
        headers: management,
        body: JSON.stringify({
          requestId: "host-4",
          idempotencyKey: "host-model-openai",
          provider: "openai",
          model: (
            (catalog.body as { providers: { id: string; models: { id: string }[] }[] })
              .providers.find((provider) => provider.id === "openai")
              ?.models[0]?.id ?? "gpt-4o-mini"
          ),
          auth: { type: "api_key", key: `${secret}-openai` },
        }),
      }),
    );
    expect(openai.status).toBe(200);
    expect(openai.body).toMatchObject({
      configured: true,
      provider: "openai",
    });
    const both = await json(
      await fetch(`${runtime.url}/v1/tenant/providers`, { headers: management }),
    );
    expect(
      (both.body as { providers: { id: string; active: boolean }[] }).providers
        .map((provider) => provider.id)
        .sort(),
    ).toEqual(["custom", "openai"]);
    expect(
      (both.body as { providers: { id: string; active: boolean }[] }).providers.find(
        (provider) => provider.id === "openai",
      )?.active,
    ).toBe(true);
    const selected = await json(
      await fetch(`${runtime.url}/v1/tenant/model/selection`, {
        method: "PUT",
        headers: management,
        body: JSON.stringify({
          requestId: "host-5",
          idempotencyKey: "host-model-select-custom",
          provider: "custom",
          model: "other-fixture",
          baseUrl: "https://models.example.test/v2",
        }),
      }),
    );
    expect(selected.status).toBe(200);
    expect(selected.body).toMatchObject({
      configured: true,
      provider: "custom",
      model: "other-fixture",
    });
    expect(JSON.stringify(selected.body)).not.toContain(secret);
    const attached = await json(
      await fetch(`${runtime.url}/v1/sessions/s-host`, {
        method: "PUT",
        headers: server,
        body: JSON.stringify({
          requestId: "session",
          agentId: "bot",
          ownerUserId: "ada",
          environment: "host",
        }),
      }),
    );
    expect(attached.status).toBe(404);
  } finally {
    await runtime.close();
    const db = await openTestSessionStore(runtime);
    const stored = JSON.stringify(
      (await db.tx((t) => t.credentialsForVault("host"))).map((row) => ({
        binding_json: row.bindingJson,
        ciphertext: row.ciphertext,
      })),
    );
    await db.close();
    expect(stored).toContain("binding_json");
    expect(stored).not.toContain(secret);
    await rm(runtime.root, { recursive: true, force: true });
  }
});
