/**
 * Signing keys at rest: the private key is sealed with the vault KEK (no column holds it in
 * the clear), and a Tenant whose only ciphertext is signing keys is still quarantined
 * `kek-missing` when the KEK is gone.
 */
import { rm } from "node:fs/promises";
import { expect, it } from "vitest";
import { withTestSessionStore } from "./support/store.js";
import { startTestTenant } from "./support/tenant.js";

const APP = "signing-keys-app-token-aaaaaaaaaaaa";
const KEK = Buffer.alloc(32, 9).toString("base64");

it("seals signing keys and quarantines the Tenant without its KEK", async () => {
  const runtime = await startTestTenant({
    applicationKey: APP,
    vaultKek: KEK,
    retainRoot: true,
  });
  const { root, tenantId } = runtime;
  try {
    const headers = {
      authorization: `Bearer ${APP}`,
      "content-type": "application/json",
    };
    const keys = await fetch(`${runtime.url}/v1/access/signing-keys`, { headers });
    expect(keys.status).toBe(200);
    const body = (await keys.json()) as { keys: { state: string; publicKey: object }[] };
    expect(body.keys.map((k) => k.state).sort()).toEqual(["current", "standby"]);
    for (const key of body.keys) expect(key.publicKey).not.toHaveProperty("d");
  } finally {
    await runtime.close();
  }
  try {
    const rows = await withTestSessionStore({ root, tenantId }, (store) =>
      store.tx((t) => t.signingKeys())
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(JSON.parse(row.publicJwk)).not.toHaveProperty("d");
      expect(Buffer.from(row.ciphertext).includes(Buffer.from("PRIVATE KEY"))).toBe(false);
      expect(row.kekId).toMatch(/^[0-9a-f]{64}$/);
    }
    const keyless = () =>
      startTestTenant({
        applicationKey: APP,
        vaultKek: null,
        hostRoot: root,
        tenantId,
        retainRoot: true,
      });
    if (process.env.NYLORUN_TEST_MODEL_GATE === "http") {
      // The runtime never reads the vault key (F4.2), so it opens without one; the gateway,
      // which alone holds the key, refuses to sign or rotate with the sealed keys.
      const runtime = await keyless();
      try {
        const rotate = await fetch(`${runtime.url}/v1/access/signing-keys/rotate`, {
          method: "POST",
          headers: { authorization: `Bearer ${APP}`, "content-type": "application/json" },
          body: JSON.stringify({ requestId: "rotate", force: true }),
        });
        expect(rotate.status).toBe(500);
      } finally {
        await runtime.close();
      }
    } else {
      await expect(keyless()).rejects.toThrow(/key-encryption key|kek-missing/i);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("creates one current key when the first uses race", async () => {
  const runtime = await startTestTenant({ applicationKey: APP, vaultKek: KEK });
  try {
    const headers = { authorization: `Bearer ${APP}` };
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        fetch(`${runtime.url}/v1/access/signing-keys`, { headers })
      )
    );
    expect(responses.map((r) => r.status)).toEqual(Array(8).fill(200));
    const keys = (await responses[0]!.json()) as { keys: { id: string; state: string }[] };
    expect(keys.keys.map((k) => k.state).sort()).toEqual(["current", "standby"]);
    for (const response of responses.slice(1))
      expect(((await response.json()) as typeof keys).keys).toEqual(keys.keys);
  } finally {
    await runtime.close();
  }
});
