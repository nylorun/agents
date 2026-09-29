import { describe, expect, it } from "vitest";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import { AgentsClient } from "../src/client.js";
import { CachedToken, createBrowserClient, readClaims } from "../src/browser.js";
import { createTokenEndpoint } from "../src/token-endpoint.js";
import { observeSSE } from "../src/sse.js";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims: Record<string, unknown>) =>
  `${b64({ alg: "ES256", typ: "nylorun-subject+jwt" })}.${b64(claims)}.sig`;

describe("CachedToken", () => {
  it("fetches once for concurrent callers and reuses the token until a minute before expiry", async () => {
    let now = 1_000_000;
    let fetches = 0;
    const cache = new CachedToken(async () => {
      fetches += 1;
      return { token: `t${fetches}`, expiresAt: new Date(now + 10 * 60_000).toISOString() };
    }, () => now);
    expect(await Promise.all([cache.get(), cache.get(), cache.get()])).toEqual(["t1", "t1", "t1"]);
    now += 8 * 60_000;
    expect(await cache.get()).toBe("t1");
    now += 90_000;
    expect(await cache.get()).toBe("t2");
    cache.invalidate();
    expect(await cache.get()).toBe("t3");
    expect(fetches).toBe(3);
  });

  it("reads the expiry and subject from a bare token", async () => {
    const token = jwt({ sub: "app:42", exp: Math.floor(Date.now() / 1000) + 600 });
    const cache = new CachedToken(async () => token);
    expect(await cache.subject()).toBe("app:42");
    expect(readClaims("not a token")).toEqual({});
  });

  it("does not remember a failed fetch", async () => {
    let attempt = 0;
    const cache = new CachedToken(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("offline");
      return "ok-token";
    });
    await expect(cache.get()).rejects.toThrow("offline");
    expect(await cache.get()).toBe("ok-token");
  });
});

describe("the transport with subject tokens", () => {
  it("sends the key and a token, skips /health, and retries once after 401 token_expired", async () => {
    const seen: { auth: string | null; key: string | null; tenant: string | null; path: string }[] = [];
    let issued = 0;
    const client = createBrowserClient({
      url: "http://runtime.test",
      publishableKey: "nr_pub_tn_00000000000000000000000001_" + "a".repeat(32),
      token: async () => jwt({ sub: "app:42", n: (issued += 1), exp: Math.floor(Date.now() / 1000) + 600 }),
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const headers = new Headers(init?.headers);
        seen.push({
          path: url.pathname,
          auth: headers.get("authorization"),
          key: headers.get("nylorun-key"),
          tenant: headers.get("nylorun-tenant"),
        });
        if (seen.length === 1)
          return Response.json({ code: "token_expired" }, { status: 401 });
        return Response.json({ sessions: [] });
      },
    });
    expect(await client.listSessions()).toEqual({ sessions: [] });
    expect(seen.map((s) => s.path)).toEqual(["/v1/sessions", "/v1/sessions"]);
    expect(seen[0]!.key).toMatch(/^nr_pub_/);
    expect(seen[0]!.tenant).toBeNull();
    expect(seen[0]!.auth).not.toBe(seen[1]!.auth);
    expect(issued).toBe(2);
  });

  it("does not loop on a second 401", async () => {
    let calls = 0;
    const client = createBrowserClient({
      url: "http://runtime.test",
      publishableKey: "nr_pub_tn_00000000000000000000000001_" + "a".repeat(32),
      token: async () => jwt({ sub: "app:42", exp: Math.floor(Date.now() / 1000) + 600 }),
      fetch: async () => {
        calls += 1;
        return Response.json({ code: "token_expired" }, { status: 401 });
      },
    });
    await expect(client.listSessions()).rejects.toMatchObject({ status: 401 });
    expect(calls).toBe(2);
  });

  it("creates sessions and vaults owned by the token's subject", async () => {
    const bodies: any[] = [];
    const client = createBrowserClient({
      url: "http://runtime.test",
      publishableKey: "nr_pub_tn_00000000000000000000000001_" + "a".repeat(32),
      token: async () => jwt({ sub: "app:42", exp: Math.floor(Date.now() / 1000) + 600 }),
      fetch: async (_input, init) => {
        if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
        return Response.json({ id: "x" });
      },
    });
    await client.createSession({ id: "s1", agentId: "support" });
    await client.createVault({ name: "mine", idempotencyKey: "v" });
    expect(bodies.map((b) => b.ownerUserId)).toEqual(["app:42", "app:42"]);
  });
});

describe("observeSSE", () => {
  it("reconnects at once when the Runtime closes the stream, resuming from the last event", async () => {
    const requests: (string | null)[] = [];
    const client = new AgentsClient({
      url: "http://runtime.test",
      key: "k".repeat(64),
      tenant: "tn_00000000000000000000000001",
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/health")
          return Response.json({ protocol: HOST_PROTOCOL });
        requests.push(new Headers(init?.headers).get("last-event-id"));
        const body =
          requests.length === 1
            ? 'id: c1\nevent: a\ndata: {"n":1}\n\nevent: nylorun.closed\ndata: {"reason":"token_expired"}\n\n'
            : 'id: c2\nevent: b\ndata: {"n":2}\n\n';
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });
    const controller = new AbortController();
    const events: string[] = [];
    for await (const event of observeSSE(client.transport, "/v1/sessions/s/events", {
      signal: controller.signal,
    })) {
      events.push(event.event);
      if (events.length === 2) controller.abort();
    }
    expect(events).toEqual(["a", "b"]);
    expect(requests.slice(0, 2)).toEqual([null, "c1"]);
  });
});

describe("createTokenEndpoint", () => {
  const client = {
    tokens: {
      create: async (options: { subject: string; role: string }) => ({
        token: `token-for-${options.subject}-${options.role}`,
        expiresAt: "2026-09-29T00:10:00.000Z",
        keyId: "sk_x",
      }),
    },
  } as unknown as AgentsClient;

  it("mints for the signed-in person, never cached", async () => {
    const endpoint = createTokenEndpoint({
      client,
      role: "user",
      subject: (request) => request.headers.get("x-user") ?? undefined,
    });
    const ok = await endpoint(
      new Request("http://app.test/api/token", { method: "POST", headers: { "x-user": "app:1" } })
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(await ok.json()).toEqual({
      token: "token-for-app:1-user",
      expiresAt: "2026-09-29T00:10:00.000Z",
    });
    const anonymous = await endpoint(new Request("http://app.test/api/token", { method: "POST" }));
    expect(anonymous.status).toBe(401);
    const get = await endpoint(new Request("http://app.test/api/token"));
    expect(get.status).toBe(405);
  });
});
