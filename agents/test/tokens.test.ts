import { describe, expect, it } from "vitest";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import { AgentsClient, IncompatibleRuntimeError, RuntimeError } from "../src/client.js";

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

describe("client.tokens", () => {
  it("mints with the application key", async () => {
    const { client, sent } = fake(undefined, () =>
      Response.json({ token: "t", expiresAt: "2026-09-29T00:10:00.000Z" })
    );
    const minted = await client.tokens.create({
      subject: "app:42",
      role: "user",
      agents: ["support"],
      ttlSeconds: 300,
    });
    expect(minted.token).toBe("t");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      method: "POST",
      path: "/v1/tokens",
      auth: `Bearer ${KEY}`,
      body: { subject: "app:42", role: "user", agents: ["support"], ttlSeconds: 300 },
    });
    expect(typeof sent[0]!.body.requestId).toBe("string");
  });

  it("sends nothing to a Runtime without subject-tokens", async () => {
    const { client, sent } = fake(
      HOST_PROTOCOL.features.filter((f) => f !== "subject-tokens")
    );
    await expect(
      client.tokens.create({ subject: "app:42", role: "user" })
    ).rejects.toBeInstanceOf(IncompatibleRuntimeError);
    expect(sent).toHaveLength(0);
  });

  it("surfaces the Runtime's refusal", async () => {
    const { client } = fake(undefined, () =>
      Response.json(
        { status: "rejected", code: "invalid_request", message: "Role ghost is not in the access policy" },
        { status: 400 }
      )
    );
    const error = await client.tokens
      .create({ subject: "app:42", role: "ghost" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RuntimeError);
    expect((error as RuntimeError).status).toBe(400);
  });
});

describe("client.access", () => {
  it("reads and writes the policy, revokes subjects and rotates keys", async () => {
    const policy = {
      version: 1 as const,
      roles: { user: { scopes: ["sessions:own" as const], agents: "*" as const } },
      anon: { scopes: [], agents: [] },
      tokens: { maxTtlSeconds: 600 },
    };
    const { client, sent } = fake(undefined, (path, body) => {
      if (path === "/v1/access/policy") return Response.json({ policy: body?.policy ?? policy });
      if (path === "/v1/access/revocations") return Response.json({ subject: body.subject, epoch: 1 });
      if (path.startsWith("/v1/access/signing-keys")) return Response.json({ keys: [] });
      return Response.json({ keys: [] });
    });
    expect(await client.access.putPolicy(policy)).toEqual(policy);
    expect(await client.access.getPolicy()).toEqual(policy);
    expect(await client.access.revokeSubject("app:42")).toEqual({ subject: "app:42", epoch: 1 });
    expect(await client.access.signingKeys.rotate({ force: true })).toEqual([]);
    expect(sent.map((r) => `${r.method} ${r.path}`)).toEqual([
      "PUT /v1/access/policy",
      "GET /v1/access/policy",
      "POST /v1/access/revocations",
      "POST /v1/access/signing-keys/rotate",
    ]);
    expect(sent[3]!.body.force).toBe(true);
  });
});
