import { describe, expect, it } from "vitest";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import { AgentsClient } from "../src/client.js";

const TENANT = "tn_00000000000000000000000001";
const KEY = "a".repeat(64);
const RUNTIME = "http://127.0.0.1:8787";

function fake(
  features: readonly string[] = HOST_PROTOCOL.features,
  respond: (path: string, body: any) => Response = () => Response.json({})
) {
  const sent: { method: string; path: string; body?: any; auth: string | null }[] = [];
  const client = new AgentsClient({
    url: RUNTIME,
    key: KEY,
    tenant: TENANT,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/health")
        return Response.json({
          status: "ok",
          protocol: { ...HOST_PROTOCOL, features: [...features] },
        });
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      sent.push({
        method: init?.method ?? "GET",
        path: url.pathname,
        body,
        auth: new Headers(init?.headers).get("authorization"),
      });
      return respond(url.pathname, body);
    },
  });
  return { client, sent };
}

describe("client.access", () => {
  it("reads the public keys", async () => {
    const { client, sent } = fake(undefined, () => Response.json({ keys: [] }));
    expect(await client.access.jwks()).toEqual({ keys: [] });
    expect(sent.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /v1/access/jwks"]);
    expect(sent.every((r) => r.auth === `Bearer ${KEY}`)).toBe(true);
  });

  it("no longer manages signing keys or vaults: the Management API does (protocol 8)", () => {
    const { client } = fake();
    expect("signingKeys" in client.access).toBe(false);
    for (const name of [
      "createVault",
      "listVaults",
      "getVault",
      "deleteVault",
      "createCredential",
      "listCredentials",
      "getCredential",
      "rotateCredential",
      "deleteCredential",
    ])
      expect(name in client, name).toBe(false);
  });

  it("no longer mints subject tokens or manages policies and browser keys (protocol 7)", () => {
    const { client } = fake();
    expect("tokens" in client).toBe(false);
    for (const name of ["getPolicy", "putPolicy", "revokeSubject", "publishableKeys"])
      expect(name in client.access).toBe(false);
  });
});
