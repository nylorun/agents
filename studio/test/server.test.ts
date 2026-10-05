import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PROTOCOL_FEATURES,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
} from "@nylorun/agents";
import { deriveStudioToken } from "@nylorun/admin";
import {
  EMBED_SESSION_TTL_MS,
  LOGIN_TOKEN_TTL_MS,
  DEFAULT_SESSION_COOKIE as SESSION_COOKIE,
  SESSION_TTL_MS,
  parseAllowedHosts,
  parseAnalyticsId,
  parseRuntimeUrl,
  parseSessionCookieName,
  readAdminKeyFile,
  safeNextPath,
  startStudioServer,
} from "../dist/server.js";

const ADMIN_KEY = "a".repeat(64);
const TENANT_A = "tn_00000000000000000000000001";
const TENANT_B = "tn_00000000000000000000000002";

type Seen = { method: string; path: string; headers: IncomingHttpHeaders; body: string };
type Reply = { status: number; headers: IncomingHttpHeaders; body: string };

type FakeTenant = {
  id: string;
  name: string;
  state: "open" | "unavailable";
};

/**
 * Fake Runtime: /health, `GET /v1/tenant` for Studio's key (the opaque 404
 * while the Tenant is unavailable), `GET /v1/me` for the bearers in `me` (any
 * other is 401), and an echoing Tenant API.
 */
async function startFakeRuntime() {
  const seen: Seen[] = [];
  const tenant: FakeTenant = { id: TENANT_A, name: "orders", state: "open" };
  const me = new Map<string, { status: number; body: unknown }>();
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method ?? "GET", path: req.url ?? "", headers: req.headers, body });
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") {
      res.end(
        JSON.stringify({
          status: "ok",
          protocol: {
            min: PROTOCOL_VERSION,
            max: PROTOCOL_VERSION,
            features: [...PROTOCOL_FEATURES],
          },
        }),
      );
      return;
    }
    if (req.url === "/v1/tenant") {
      if (
        req.headers.authorization !== `Bearer ${deriveStudioToken(ADMIN_KEY)}` ||
        tenant.state !== "open"
      ) {
        res.statusCode = 404;
        res.end(JSON.stringify({ code: "not_found", message: "Not found" }));
        return;
      }
      res.end(
        JSON.stringify({
          tenant: { id: tenant.id, name: tenant.name, createdAt: "t", updatedAt: "t", schemaVersion: 1 },
        }),
      );
      return;
    }
    if (req.url === "/v1/me") {
      const token = (req.headers.authorization ?? "").replace(/^Bearer /u, "");
      const reply = me.get(token) ?? {
        status: 401,
        body: { code: "unauthorized", message: "Invalid bearer token" },
      };
      res.statusCode = reply.status;
      res.end(JSON.stringify(reply.body));
      return;
    }
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    seen,
    tenant,
    me,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

async function webRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nylorun-studio-web-"));
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "index.html"), "<!doctype html><title>studio-spa</title>");
  await writeFile(join(root, "assets", "app.js"), "console.log('studio')");
  return root;
}

function send(
  port: number,
  options: {
    method?: string;
    path: string;
    host?: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: options.path,
        headers: {
          host: options.host ?? `localhost:${port}`,
          ...options.headers,
        },
      },
      async (res: IncomingMessage) => {
        let body = "";
        for await (const chunk of res) body += chunk;
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

async function withStudio(
  run: (context: {
    port: number;
    runtime: Awaited<ReturnType<typeof startFakeRuntime>>;
    clock: { now: number };
  }) => Promise<void>,
  extra: {
    publicPort?: number;
    allowedHosts?: readonly string[];
    sessionCookie?: string;
    adminKey?: string;
    clock?: { now: number };
    frameAncestors?: readonly string[];
    analyticsId?: string;
    log?: (entry: Readonly<Record<string, unknown>>) => void;
  } = {},
) {
  const runtime = await startFakeRuntime();
  const root = await webRoot();
  const { clock = { now: 1_000_000 }, ...options } = extra;
  const studio = await startStudioServer({
    runtimeUrl: runtime.url,
    adminKey: ADMIN_KEY,
    port: 0,
    webRoot: root,
    now: () => clock.now,
    ...options,
  });
  try {
    await run({ port: studio.port, runtime, clock });
  } finally {
    await studio.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function mint(port: number): Promise<{ token: string; url: string }> {
  const reply = await send(port, {
    method: "POST",
    path: "/_studio/login-tokens",
    headers: { authorization: `Bearer ${ADMIN_KEY}` },
  });
  assert.equal(reply.status, 201, reply.body);
  return JSON.parse(reply.body) as { token: string; url: string };
}

async function session(port: number): Promise<string> {
  const { token } = await mint(port);
  const reply = await send(port, { path: `/login?token=${token}` });
  assert.equal(reply.status, 303);
  const cookie = String(reply.headers["set-cookie"]?.[0] ?? "");
  return cookie.split(";")[0]!;
}

function assertNoCors(reply: Reply) {
  for (const name of Object.keys(reply.headers))
    assert.ok(!name.startsWith("access-control-"), `unexpected CORS header ${name}`);
}

function assertNoKeys(reply: Reply) {
  const text = JSON.stringify(reply.headers) + reply.body;
  assert.ok(!text.includes(ADMIN_KEY), "admin key leaked");
  assert.ok(!text.includes(deriveStudioToken(ADMIN_KEY)), "Studio key leaked");
}

test("login tokens need the admin key and are 256-bit, single-use", async () => {
  await withStudio(async ({ port }) => {
    for (const authorization of [undefined, "Bearer wrong", `Basic ${ADMIN_KEY}`]) {
      const denied = await send(port, {
        method: "POST",
        path: "/_studio/login-tokens",
        headers: authorization ? { authorization } : {},
      });
      assert.equal(denied.status, 401);
    }
    const { token, url } = await mint(port);
    assert.equal(Buffer.from(token, "base64url").length, 32);
    assert.equal(url, `http://localhost:${port}/login?token=${token}`);

    const first = await send(port, { path: `/login?token=${token}` });
    assert.equal(first.status, 303);
    assert.equal(first.headers.location, "/");
    const cookie = String(first.headers["set-cookie"]?.[0]);
    assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=v1\\.\\d+\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43};`));
    assert.match(cookie, /; HttpOnly/);
    assert.match(cookie, /; SameSite=Strict/);
    assert.match(cookie, /; Path=\//);
    assert.match(cookie, new RegExp(`; Max-Age=${SESSION_TTL_MS / 1000}$`));

    const again = await send(port, { path: `/login?token=${token}` });
    assert.equal(again.status, 401);
    assert.equal(again.headers["set-cookie"], undefined);
    const missing = await send(port, { path: "/login" });
    assert.equal(missing.status, 401);
  });
});

test("login tokens expire after two minutes", async () => {
  await withStudio(async ({ port, clock }) => {
    const early = await mint(port);
    clock.now += LOGIN_TOKEN_TTL_MS - 1;
    assert.equal((await send(port, { path: `/login?token=${early.token}` })).status, 303);

    const late = await mint(port);
    clock.now += LOGIN_TOKEN_TTL_MS;
    const reply = await send(port, { path: `/login?token=${late.token}` });
    assert.equal(reply.status, 401);
    assert.equal(reply.headers["set-cookie"], undefined);
  });
});

/** A Host behind a sign-in proxy: unlike loopback, it needs a session. */
const PROXIED = "studio.acme.dev";

test("a session survives a Studio restart and lasts 30 days", async () => {
  const clock = { now: 1_000_000 };
  let cookie = "";
  await withStudio(async ({ port }) => {
    cookie = await session(port);
  }, { clock });
  // A new Studio process with the same admin key accepts the cookie.
  await withStudio(async ({ port }) => {
    const hello = () => send(port, { path: "/_studio/hello", host: PROXIED, headers: { cookie } });
    clock.now += SESSION_TTL_MS - 1;
    assert.equal((await hello()).status, 200);
    clock.now += 1;
    assert.equal((await hello()).status, 401);
  }, { clock, allowedHosts: [PROXIED] });
});

test("a session ends when the admin key changes, and cannot be forged", async () => {
  const clock = { now: 1_000_000 };
  let cookie = "";
  await withStudio(async ({ port }) => {
    cookie = await session(port);
  }, { clock });
  await withStudio(async ({ port }) => {
    assert.equal((await send(port, { path: "/_studio/hello", host: PROXIED, headers: { cookie } })).status, 401);
  }, { clock, adminKey: "b".repeat(64), allowedHosts: [PROXIED] });
  await withStudio(async ({ port }) => {
    const [name, value] = cookie.split("=") as [string, string];
    const [version, issuedAt, nonce, signature] = value.split(".");
    const forged = [
      `${name}=${version}.${Number(issuedAt) + 1}.${nonce}.${signature}`,
      `${name}=${version}.${issuedAt}.${nonce}.${signature!.slice(0, -1)}${signature!.endsWith("A") ? "B" : "A"}`,
      `${name}=v2.${issuedAt}.${nonce}.${signature}`,
      `${name}=${version}.${clock.now + 10 * 60 * 1000}.${nonce}.${signature}`,
    ];
    for (const attempt of forged)
      assert.equal((await send(port, { path: "/_studio/hello", host: PROXIED, headers: { cookie: attempt } })).status, 401, attempt);
    assert.equal((await send(port, { path: "/_studio/hello", host: PROXIED, headers: { cookie } })).status, 200);
  }, { clock, allowedHosts: [PROXIED] });
});

test("login redirects only to same-origin paths", async () => {
  await withStudio(async ({ port }) => {
    const { token } = await mint(port);
    const reply = await send(port, {
      path: `/login?token=${token}&next=${encodeURIComponent(`/tenants/${TENANT_A}`)}`,
    });
    assert.equal(reply.headers.location, `/tenants/${TENANT_A}`);
  });
  assert.equal(safeNextPath(null), "/");
  assert.equal(safeNextPath("/tenants/tn_1/agents/a"), "/tenants/tn_1/agents/a");
  for (const unsafe of [
    "//evil.example/",
    "/\\evil.example",
    "https://evil.example/",
    "tenants/x",
    "/ evil",
    "/login?token=x",
    "/_studio/tenants",
    "javascript:alert(1)",
  ])
    assert.equal(safeNextPath(unsafe), "/", unsafe);
});

test("dashboard files need no session; every /_studio route does, except on loopback", async () => {
  await withStudio(async ({ port }) => {
    for (const path of ["/_studio/hello", `/_studio/tenants/${TENANT_A}/runtime/v1/agents`, "/_studio/unknown"]) {
      const anonymous = await send(port, { path, host: PROXIED });
      assert.equal(anonymous.status, 401, path);
      assert.match(JSON.parse(anonymous.body).message, /sign-in proxy/);
      const forged = await send(port, { path, host: PROXIED, headers: { cookie: `${SESSION_COOKIE}=${"x".repeat(43)}` } });
      assert.equal(forged.status, 401, path);
    }
    // The shell carries no data; the dashboard shows its own sign-in page.
    for (const path of [`/tenants/${TENANT_A}`, `/tenants/${TENANT_A}/vault`, "/assets/app.js"]) {
      const anonymous = await send(port, { path });
      assert.equal(anonymous.status, 200, path);
    }
    // `/` leads to the installation's one Tenant.
    const root = await send(port, { path: "/" });
    assert.equal(root.status, 302);
    assert.equal(root.headers.location, `/tenants/${TENANT_A}`);
    assert.equal((await send(port, { path: "/assets/missing.js" })).status, 404);
    assert.equal((await send(port, { method: "POST", path: "/", headers: { origin: `http://localhost:${port}` } })).status, 405);
    const health = await send(port, { path: "/healthz" });
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { status: "ok" });

    const cookie = await session(port);
    const index = await send(port, { path: `/tenants/${TENANT_A}`, headers: { cookie } });
    assert.equal(index.status, 200);
    assert.match(index.body, /studio-spa/);
    const spa = await send(port, { path: `/tenants/${TENANT_A}/vault`, headers: { cookie: `other=1; ${cookie}` } });
    assert.equal(spa.status, 200);
    assert.match(spa.body, /studio-spa/);
    assert.equal((await send(port, { path: "/_studio/hello", host: PROXIED, headers: { cookie } })).status, 200);
  }, { allowedHosts: [PROXIED], log: () => {} });
});

test("Studio on loopback needs no sign-in: the whole Tenant, no subject (AP19)", async () => {
  const entries: Readonly<Record<string, unknown>>[] = [];
  await withStudio(async ({ port, runtime }) => {
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`]) {
      const hello = await send(port, { path: "/_studio/hello", host });
      assert.equal(hello.status, 200, host);
      assert.equal(hello.headers["set-cookie"], undefined);
      assert.deepEqual(JSON.parse(hello.body).tenant, { id: TENANT_A, name: "orders", state: "open" });
      const agents = await send(port, { path: `/_studio/tenants/${TENANT_A}/runtime/v1/agents`, host });
      assert.equal(agents.status, 200, host);
      assertNoKeys(agents);
    }
    const upstream = runtime.seen.at(-1)!;
    assert.equal(upstream.headers.authorization, `Bearer ${deriveStudioToken(ADMIN_KEY)}`);
    assert.equal(upstream.headers["nylorun-subject"], undefined);
    assert.equal(upstream.headers["nylorun-scopes"], undefined);
    // Any session, then another Tenant: the opaque answer.
    assert.equal((await send(port, { path: `/_studio/tenants/${TENANT_B}/runtime/v1/agents` })).status, 404);

    // State changes still need this origin's Origin header.
    const write = (headers: Record<string, string>) =>
      send(port, {
        method: "PUT",
        path: `/_studio/tenants/${TENANT_A}/runtime/v1/sessions/s1`,
        body: JSON.stringify({ agentId: "a" }),
        headers: { "content-type": "application/json", ...headers },
      });
    assert.equal((await write({})).status, 403);
    assert.equal((await write({ origin: "http://evil.example" })).status, 403);
    assert.equal((await write({ origin: `http://localhost:${port}` })).status, 200);

    // A bearer that is not a Studio session is still refused, never widened to the loopback session.
    const refused = await send(port, { path: "/_studio/hello", headers: { authorization: "Bearer v2.x.y" } });
    assert.equal(refused.status, 401);
    assert.match(JSON.parse(refused.body).message, /invalid or has expired/);

    // Login links still work there; a used one says no sign-in is needed.
    const { token } = await mint(port);
    assert.equal((await send(port, { path: `/login?token=${token}` })).status, 303);
    const used = await send(port, { path: `/login?token=${token}` });
    assert.equal(used.status, 401);
    assert.match(used.body, /needs no sign-in/);
  }, { allowedHosts: [PROXIED], log: (entry) => entries.push(entry) });
  // The loopback session has no subject: its writes are not logged.
  assert.deepEqual(entries, []);
});

test("Host must be the published loopback address (DNS rebinding)", async () => {
  await withStudio(async ({ port }) => {
    const cookie = await session(port);
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      assert.equal((await send(port, { path: "/", host, headers: { cookie } })).status, 302, host);
      assert.equal((await send(port, { path: `/tenants/${TENANT_A}`, host, headers: { cookie } })).status, 200, host);
    }
    for (const host of [`rebind.attacker.example:${port}`, `localhost:${port + 1}`, `[::1]:${port}`, "localhost", `LOCALHOST.evil:${port}`]) {
      for (const path of ["/", `/tenants/${TENANT_A}`, "/_studio/hello", "/login?token=x"])
        assert.equal((await send(port, { path, host, headers: { cookie } })).status, 421, `${host} ${path}`);
      const minted = await send(port, {
        method: "POST",
        path: "/_studio/login-tokens",
        host,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      });
      assert.equal(minted.status, 421, host);
    }
    const refused = await send(port, { path: "/", host: `rebind.attacker.example:${port}` });
    assert.equal(
      JSON.parse(refused.body).message,
      `Studio only serves http://localhost:${port} and http://127.0.0.1:${port}.`,
    );
    // Container-internal names on the listen port reach /healthz only.
    assert.equal((await send(port, { path: "/healthz", host: `studio:${port}` })).status, 200);
    assert.equal((await send(port, { path: "/", host: `studio:${port}`, headers: { cookie } })).status, 421);
    assert.equal((await send(port, { path: "/healthz", host: "rebind.attacker.example:1" })).status, 421);
  });
});

test("the Host check uses the published port, not the listen port", async () => {
  const publicPort = 49_999;
  await withStudio(
    async ({ port }) => {
      const minted = await send(port, {
        method: "POST",
        path: "/_studio/login-tokens",
        host: `localhost:${publicPort}`,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      });
      assert.equal(minted.status, 201);
      assert.match(JSON.parse(minted.body).url, new RegExp(`^http://localhost:${publicPort}/login\\?token=`));
      assert.equal((await send(port, { path: "/" })).status, 421);
      assert.equal((await send(port, { path: "/healthz" })).status, 200);
    },
    { publicPort },
  );
});

test("the session cookie has the configured name, and only that name is read", async () => {
  const name = "nylorun_studio_shop";
  await withStudio(async ({ port }) => {
    const { token } = await mint(port);
    const login = await send(port, { path: `/login?token=${token}` });
    assert.equal(login.status, 303);
    const cookie = String(login.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
    assert.match(cookie, new RegExp(`^${name}=v1\\.`));
    const value = cookie.slice(name.length + 1);
    // Another Studio's cookie on the same host is not this Studio's session.
    const hello = (cookie: string) => send(port, { path: "/_studio/hello", host: PROXIED, headers: { cookie } });
    assert.equal((await hello(`${SESSION_COOKIE}=${value}`)).status, 401);
    assert.equal((await hello(`nylorun_studio_api=${value}`)).status, 401);
    assert.equal((await hello(`nylorun_studio_api=x; ${cookie}`)).status, 200);
    // State changes read the same cookie.
    const command = await send(port, {
      method: "POST",
      path: `/_studio/tenants/${TENANT_A}/runtime/v1/sessions/s1/commands`,
      body: JSON.stringify({ type: "message", content: "hi" }),
      headers: { cookie, origin: `http://localhost:${port}`, "content-type": "application/json" },
    });
    assert.equal(command.status, 200, command.body);
  }, { sessionCookie: name, allowedHosts: [PROXIED] });

  assert.equal(SESSION_COOKIE, "nylorun_studio_session");
  assert.equal(parseSessionCookieName(""), SESSION_COOKIE);
  assert.equal(parseSessionCookieName(" nylorun_studio_my-app "), "nylorun_studio_my-app");
  for (const bad of ["a b", "a=b", "a;b", "a.b", "studio\u00e9", '"x"'])
    assert.throws(() => parseSessionCookieName(bad), /not a cookie name/, bad);
  const runtime = await startFakeRuntime();
  try {
    await assert.rejects(
      startStudioServer({ runtimeUrl: runtime.url, adminKey: ADMIN_KEY, port: 0, sessionCookie: "a;b" }),
      /not a cookie name/,
    );
  } finally {
    await runtime.close();
  }
});

test("the login URL is on the request's own origin", async () => {
  await withStudio(async ({ port }) => {
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`]) {
      const minted = await send(port, {
        method: "POST",
        path: "/_studio/login-tokens",
        host,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      });
      assert.equal(minted.status, 201, host);
      const { url, token } = JSON.parse(minted.body) as { url: string; token: string };
      assert.equal(url, `http://${host}/login?token=${token}`);
      assert.equal((await send(port, { path: `/login?token=${token}`, host })).status, 303, host);
    }
  });
});

test("state changes need this origin's Origin header", async () => {
  await withStudio(async ({ port, runtime }) => {
    const cookie = await session(port);
    const path = `/_studio/tenants/${TENANT_A}/runtime/v1/sessions/s1/commands`;
    const body = JSON.stringify({ type: "message", content: "hi" });
    const json = { cookie, "content-type": "application/json" };
    for (const origin of [undefined, "http://evil.example", `http://127.0.0.1:${port}`, "null"]) {
      const reply = await send(port, {
        method: "POST",
        path,
        body,
        headers: origin ? { ...json, origin } : json,
      });
      assert.equal(reply.status, 403, String(origin));
      assertNoCors(reply);
    }
    assert.equal(runtime.seen.filter((s) => s.path.includes("/commands")).length, 0);
    const ok = await send(port, {
      method: "POST",
      path,
      body,
      headers: { ...json, origin: `http://localhost:${port}` },
    });
    assert.equal(ok.status, 200, ok.body);

    const crossMint = await send(port, {
      method: "POST",
      path: "/_studio/login-tokens",
      headers: { authorization: `Bearer ${ADMIN_KEY}`, origin: "http://evil.example" },
    });
    assert.equal(crossMint.status, 403);
  });
});

test("Studio never sends CORS headers", async () => {
  await withStudio(async ({ port }) => {
    const cookie = await session(port);
    const replies = [
      await send(port, { method: "OPTIONS", path: "/_studio/hello", headers: { origin: "http://evil.example", "access-control-request-method": "GET" } }),
      await send(port, { method: "OPTIONS", path: "/_studio/hello", headers: { cookie, origin: `http://localhost:${port}` } }),
      await send(port, { path: "/_studio/hello", headers: { cookie, origin: "http://evil.example" } }),
      await send(port, { path: `/_studio/tenants/${TENANT_A}/runtime/v1/agents`, headers: { cookie, origin: "http://evil.example" } }),
      await send(port, { path: "/", headers: { origin: "http://evil.example" } }),
      await send(port, { path: "/healthz", headers: { origin: "http://evil.example" } }),
    ];
    for (const reply of replies) assertNoCors(reply);
  });
});

test("the proxy uses the Tenant's derived Studio key, names no Tenant, and never leaks keys", async () => {
  await withStudio(async ({ port, runtime }) => {
    const cookie = await session(port);
    // A bearer that is not a Studio session is refused, never forwarded, even
    // beside a valid cookie.
    const supplied = await send(port, {
      path: `/_studio/tenants/${TENANT_A}/runtime/v1/agents`,
      headers: { cookie, authorization: "Bearer browser-supplied" },
    });
    assert.equal(supplied.status, 401);
    const reply = await send(port, {
      path: `/_studio/tenants/${TENANT_A}/runtime/v1/agents`,
      headers: { cookie },
    });
    assert.equal(reply.status, 200, reply.body);
    assertNoKeys(reply);
    const upstream = runtime.seen.at(-1)!;
    assert.equal(upstream.path, "/v1/agents");
    assert.equal(upstream.headers.authorization, `Bearer ${deriveStudioToken(ADMIN_KEY)}`);
    assert.equal(upstream.headers["nylorun-tenant"], undefined);
    assert.equal(upstream.headers[PROTOCOL_HEADER.toLowerCase()], String(PROTOCOL_VERSION));
    assert.equal(upstream.headers.cookie, undefined);
    assert.equal(upstream.headers.origin, undefined);

    // Another Tenant id is a Tenant that does not exist.
    const before404 = runtime.seen.length;
    const other = await send(port, { path: `/_studio/tenants/${TENANT_B}/runtime/v1/agents`, headers: { cookie } });
    assert.equal(other.status, 404);
    assert.equal(JSON.parse(other.body).message, "Unknown Tenant");
    assert.equal(runtime.seen.length, before404);

    const put = await send(port, {
      method: "PUT",
      path: `/_studio/tenants/${TENANT_A}/runtime/v1/sessions/s1`,
      body: JSON.stringify({ agentId: "a", ownerUserId: "someone-else" }),
      headers: { cookie, origin: `http://localhost:${port}`, "content-type": "application/json" },
    });
    assert.equal(put.status, 200);
    assert.equal(JSON.parse(runtime.seen.at(-1)!.body).ownerUserId, "local-developer");

    const before = runtime.seen.length;
    for (const path of [
      `/_studio/tenants/${TENANT_A}/runtime/v1/admin/tenants`,
      `/_studio/tenants/${TENANT_A}/runtime/v1/host/model`,
      "/_studio/tenants/bad%2Fid/runtime/v1/agents",
      "/_studio/runtime/v1/agents",
    ]) {
      const reply = await send(port, { path, headers: { cookie } });
      assert.equal(reply.status, 404, path);
    }
    const command = await send(port, {
      method: "POST",
      path: `/_studio/tenants/${TENANT_A}/runtime/v1/sessions/s1/commands`,
      body: JSON.stringify({ type: "approve" }),
      headers: { cookie, origin: `http://localhost:${port}`, "content-type": "application/json" },
    });
    assert.equal(command.status, 400);
    assert.equal(runtime.seen.length, before);
  });
});

test("the Tenant comes from GET /v1/tenant with Studio's key, never the admin key", async () => {
  await withStudio(async ({ port, runtime }) => {
    const root = await send(port, { path: "/?embed=1" });
    assert.equal(root.status, 302);
    assert.equal(root.headers.location, `/tenants/${TENANT_A}?embed=1`);
    assert.equal(root.headers["cache-control"], "no-store");
    assertNoKeys(root);
    const upstream = runtime.seen.find((s) => s.path === "/v1/tenant")!;
    assert.equal(upstream.headers.authorization, `Bearer ${deriveStudioToken(ADMIN_KEY)}`);
    assert.equal(upstream.headers["nylorun-subject"], undefined);
    assert.ok(!runtime.seen.some((s) => s.path.startsWith("/v1/admin")));
    assert.ok(!runtime.seen.some((s) => s.headers.authorization === `Bearer ${ADMIN_KEY}`));
    assert.equal(upstream.headers[PROTOCOL_HEADER.toLowerCase()], String(PROTOCOL_VERSION));
    assert.equal(upstream.headers["nylorun-tenant"], undefined);
    assert.equal((await send(port, { method: "HEAD", path: "/" })).status, 302);

    const cookie = await session(port);
    const hello = await send(port, { path: "/_studio/hello", headers: { cookie } });
    assert.equal(hello.status, 200);
    const body = JSON.parse(hello.body);
    assert.deepEqual(body.runtime, { compatible: true });
    assert.deepEqual(body.tenant, { id: TENANT_A, name: "orders", state: "open" });
    assertNoKeys(hello);
    // The Tenant list and create routes are gone.
    assert.equal((await send(port, { path: "/_studio/tenants", headers: { cookie } })).status, 404);
    const create = await send(port, {
      method: "POST",
      path: "/_studio/tenants",
      body: '{"name":"x"}',
      headers: { cookie, origin: `http://localhost:${port}`, "content-type": "application/json" },
    });
    assert.equal(create.status, 404);
    assert.equal(runtime.seen.filter((s) => s.method === "POST").length, 0);
  });
});

test("an unavailable Tenant is answered clearly, and Studio asks again", async () => {
  await withStudio(async ({ port, runtime }) => {
    // The Runtime answers the opaque 404 while its Tenant is not open.
    runtime.tenant.state = "unavailable";
    const cookie = await session(port);
    const root = await send(port, { path: "/" });
    assert.equal(root.status, 503);
    assert.match(root.headers["content-type"] ?? "", /^text\/html/);
    assert.match(root.body, /Tenant unavailable/);
    assert.match(root.body, /did not open its Tenant to Studio \(HTTP 404\)/);
    assert.match(root.body, /npx nylorun status/);

    const hello = JSON.parse((await send(port, { path: "/_studio/hello", headers: { cookie } })).body);
    assert.equal(hello.tenant.state, "unavailable");
    assert.equal(hello.tenant.id, null);
    assert.match(hello.tenant.message, /npx nylorun status/);

    const proxied = await send(port, { path: `/_studio/tenants/${TENANT_A}/runtime/v1/agents`, headers: { cookie } });
    assert.equal(proxied.status, 503);
    assert.match(JSON.parse(proxied.body).message, /did not open its Tenant/);
    assert.equal(runtime.seen.filter((s) => s.path === "/v1/agents").length, 0);
    const minted = await send(port, {
      method: "POST",
      path: "/_studio/login-tokens",
      headers: { authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ tenant: TENANT_A }),
    });
    assert.equal(minted.status, 503);

    // A failure is not remembered: once the Tenant opens, the next request reaches it.
    runtime.tenant.state = "open";
    const open = await send(port, { path: "/" });
    assert.equal(open.status, 302);
    assert.equal(open.headers.location, `/tenants/${TENANT_A}`);
    const after = await send(port, { path: `/_studio/tenants/${TENANT_A}/runtime/v1/agents`, headers: { cookie } });
    assert.equal(after.status, 200, after.body);

    // Once known, the id is kept while the Tenant is unavailable again.
    runtime.tenant.state = "unavailable";
    const again = JSON.parse((await send(port, { path: "/_studio/hello", headers: { cookie } })).body);
    assert.deepEqual({ id: again.tenant.id, state: again.tenant.state }, { id: TENANT_A, state: "unavailable" });
  });
});

test("an unreachable Runtime is answered clearly, and no key leaks", async () => {
  const root = await webRoot();
  const studio = await startStudioServer({
    runtimeUrl: "http://127.0.0.1:1",
    adminKey: ADMIN_KEY,
    port: 0,
    webRoot: root,
  });
  try {
    const page = await send(studio.port, { path: "/" });
    assert.equal(page.status, 503);
    assert.match(page.body, /cannot reach the Runtime/);
    assert.match(page.body, /npx nylorun status/);
    assertNoKeys(page);
    const cookie = await session(studio.port);
    const hello = await send(studio.port, { path: "/_studio/hello", headers: { cookie } });
    assert.equal(hello.status, 200);
    const body = JSON.parse(hello.body);
    assert.equal(body.runtime.compatible, false);
    assert.deepEqual(
      { id: body.tenant.id, state: body.tenant.state },
      { id: null, state: "unavailable" },
    );
    assertNoKeys(hello);
    const proxied = await send(studio.port, { path: `/_studio/tenants/${TENANT_A}/runtime/v1/agents`, headers: { cookie } });
    assert.equal(proxied.status, 503);
    assertNoKeys(proxied);
  } finally {
    await studio.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("configuration helpers validate the Runtime URL and admin key file", async () => {
  assert.equal(parseRuntimeUrl("http://runtime:4000/"), "http://runtime:4000");
  for (const bad of ["runtime:4000", "ftp://runtime", "http://u:p@runtime", "http://runtime?x=1"])
    assert.throws(() => parseRuntimeUrl(bad), undefined, bad);
  const dir = await mkdtemp(join(tmpdir(), "nylorun-studio-key-"));
  try {
    const file = join(dir, "host-credentials.json");
    await writeFile(file, JSON.stringify({ adminKey: ADMIN_KEY }));
    assert.equal(readAdminKeyFile(file), ADMIN_KEY);
    await writeFile(file, JSON.stringify({}));
    assert.throws(() => readAdminKeyFile(file), /no adminKey/);
    assert.throws(() => readAdminKeyFile(join(dir, "missing.json")), /Cannot read/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Embedding (Studio §8) -------------------------------------------------------------------

const EMBEDDERS = ["nylorun://localhost", "http://nylorun.localhost"] as const;

async function mintFor(
  port: number,
  body: Record<string, unknown>,
): Promise<{ token: string; tenant: string | null; subject: string | null; url: string; expiresAt: string }> {
  const reply = await send(port, {
    method: "POST",
    path: "/_studio/login-tokens",
    headers: { authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(reply.status, 201, reply.body);
  return JSON.parse(reply.body);
}

async function redeem(port: number, token: string, origin = `http://localhost:${port}`): Promise<Reply> {
  return send(port, {
    method: "POST",
    path: "/_studio/sessions",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

async function embedSession(port: number, tenant = TENANT_A, subject = "user_1"): Promise<string> {
  const { token } = await mintFor(port, { tenant, subject });
  const reply = await redeem(port, token);
  assert.equal(reply.status, 201, reply.body);
  return (JSON.parse(reply.body) as { sessionToken: string }).sessionToken;
}

test("login tokens can be limited to a Tenant and a subject; {} stays Host-wide", async () => {
  await withStudio(async ({ port }) => {
    const limited = await mintFor(port, { tenant: TENANT_A, subject: "user_1" });
    assert.equal(limited.tenant, TENANT_A);
    assert.equal(limited.subject, "user_1");
    assert.equal(Buffer.from(limited.token, "base64url").length, 32);
    const wide = await mintFor(port, {});
    assert.equal(wide.tenant, null);
    assert.equal(wide.subject, null);
    // The CLI's request: JSON `{}`; and a request with no body at all.
    assert.equal((await mint(port)).token.length, 43);

    for (const body of [
      JSON.stringify({ tenant: "../x" }),
      JSON.stringify({ subject: "" }),
      JSON.stringify({ subject: "x".repeat(201) }),
      JSON.stringify({ tenant: TENANT_A, admin: true }),
      JSON.stringify([]),
      "{not json",
      JSON.stringify({ subject: "x".repeat(5000) }),
    ]) {
      const reply = await send(port, {
        method: "POST",
        path: "/_studio/login-tokens",
        headers: { authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json" },
        body,
      });
      assert.equal(reply.status, 400, body.slice(0, 40));
    }
    // The `tenant` claim must name the installation's Tenant.
    const other = await send(port, {
      method: "POST",
      path: "/_studio/login-tokens",
      headers: { authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ tenant: TENANT_B }),
    });
    assert.equal(other.status, 404);
    assert.match(JSON.parse(other.body).message, /Unknown Tenant/);
    const denied = await send(port, {
      method: "POST",
      path: "/_studio/login-tokens",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenant: TENANT_A }),
    });
    assert.equal(denied.status, 401);
  });
});

test("a Tenant-limited login token never becomes a cookie", async () => {
  await withStudio(async ({ port }) => {
    const { token } = await mintFor(port, { tenant: TENANT_A });
    const reply = await send(port, { path: `/login?token=${token}` });
    assert.equal(reply.status, 401);
    assert.equal(reply.headers["set-cookie"], undefined);
    // The attempt used it up.
    assert.equal((await redeem(port, token)).status, 401);
  });
});

test("a login token becomes a one-hour bearer session, once", async () => {
  await withStudio(async ({ port, clock }) => {
    const { token } = await mintFor(port, { tenant: TENANT_A, subject: "user_1" });
    const first = await redeem(port, token);
    assert.equal(first.status, 201, first.body);
    assert.equal(first.headers["set-cookie"], undefined);
    const body = JSON.parse(first.body) as Record<string, string>;
    assert.match(body.sessionToken!, /^v2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    assert.equal(body.tenant, TENANT_A);
    assert.equal(body.subject, "user_1");
    assert.equal(body.expiresAt, new Date(clock.now + EMBED_SESSION_TTL_MS).toISOString());

    const again = await redeem(port, token);
    assert.equal(again.status, 401);
    assert.equal(JSON.parse(again.body).code, "token_invalid");

    const late = await mintFor(port, { tenant: TENANT_A });
    clock.now += LOGIN_TOKEN_TTL_MS;
    assert.equal((await redeem(port, late.token)).status, 401);

    // Exchanging changes state: it needs this origin's Origin.
    const fresh = await mintFor(port, { tenant: TENANT_A });
    assert.equal((await redeem(port, fresh.token, "nylorun://localhost")).status, 403);
    const noOrigin = await send(port, {
      method: "POST",
      path: "/_studio/sessions",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: fresh.token }),
    });
    assert.equal(noOrigin.status, 403);
    assert.equal((await send(port, { path: "/_studio/sessions" })).status, 405);
    const malformed = await send(port, {
      method: "POST",
      path: "/_studio/sessions",
      headers: { origin: `http://localhost:${port}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(malformed.status, 400);
  });
});

test("bearer sessions expire, cannot be forged, and end with the admin key", async () => {
  const clock = { now: 1_000_000 };
  let sessionToken = "";
  await withStudio(async ({ port }) => {
    sessionToken = await embedSession(port);
    const hello = await send(port, { path: "/_studio/hello", headers: { authorization: `Bearer ${sessionToken}` } });
    assert.equal(hello.status, 200);
  }, { clock });
  await withStudio(async ({ port }) => {
    // Survives a restart with the same admin key, for one hour.
    const auth = (token: string) => ({ authorization: `Bearer ${token}` });
    assert.equal((await send(port, { path: "/_studio/hello", headers: auth(sessionToken) })).status, 200);
    const [version, claims, signature] = sessionToken.split(".") as [string, string, string];
    const decoded = JSON.parse(Buffer.from(claims, "base64url").toString("utf8"));
    const forge = (patch: Record<string, unknown>) =>
      `${version}.${Buffer.from(JSON.stringify({ ...decoded, ...patch })).toString("base64url")}.${signature}`;
    for (const attempt of [
      forge({ tenant: TENANT_B }),
      forge({ tenant: null }),
      forge({ exp: decoded.exp + 1 }),
      `${version}.${claims}.${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`,
      `v1.${claims}.${signature}`,
      "v2.x.y",
      "not-a-session",
    ]) {
      const reply = await send(port, { path: "/_studio/hello", headers: auth(attempt) });
      assert.equal(reply.status, 401, attempt);
    }
    // A bad bearer is refused even beside a valid cookie.
    const cookie = await session(port);
    const mixed = await send(port, { path: "/_studio/hello", headers: { cookie, authorization: "Bearer v2.x.y" } });
    assert.equal(mixed.status, 401);

    clock.now += EMBED_SESSION_TTL_MS - 1;
    assert.equal((await send(port, { path: "/_studio/hello", headers: auth(sessionToken) })).status, 200);
    clock.now += 1;
    assert.equal((await send(port, { path: "/_studio/hello", headers: auth(sessionToken) })).status, 401);
  }, { clock });
  await withStudio(async ({ port }) => {
    clock.now = 1_000_000;
    const reply = await send(port, { path: "/_studio/hello", headers: { authorization: `Bearer ${sessionToken}` } });
    assert.equal(reply.status, 401);
  }, { clock, adminKey: "b".repeat(64) });
});

test("a Tenant-limited session reaches only its Tenant", async () => {
  await withStudio(async ({ port, runtime }) => {
    const sessionToken = await embedSession(port, TENANT_A);
    const auth = { authorization: `Bearer ${sessionToken}` };
    const own = await send(port, { path: `/_studio/tenants/${TENANT_A}/runtime/v1/agents`, headers: auth });
    assert.equal(own.status, 200, own.body);
    assertNoKeys(own);
    const upstream = runtime.seen.at(-1)!;
    // The Runtime sees the derived Studio key, never the session token.
    assert.equal(upstream.headers.authorization, `Bearer ${deriveStudioToken(ADMIN_KEY)}`);
    assert.ok(!JSON.stringify(upstream.headers).includes(sessionToken));
    assert.equal(upstream.headers["nylorun-subject"], undefined);

    const before = runtime.seen.length;
    const other = await send(port, { path: `/_studio/tenants/${TENANT_B}/runtime/v1/agents`, headers: auth });
    assert.equal(other.status, 404);
    assert.equal(JSON.parse(other.body).message, "Unknown Tenant");
    assert.equal(runtime.seen.length, before);
    assert.equal((await send(port, { path: "/_studio/hello", headers: auth })).status, 200);

    // A Host-wide bearer session behaves like the cookie: it reaches the one Tenant.
    const { token } = await mintFor(port, {});
    const wide = JSON.parse((await redeem(port, token)).body).sessionToken as string;
    const a = await send(port, { path: `/_studio/tenants/${TENANT_A}/runtime/v1/agents`, headers: { authorization: `Bearer ${wide}` } });
    assert.equal(a.status, 200);
    const b = await send(port, { path: `/_studio/tenants/${TENANT_B}/runtime/v1/agents`, headers: { authorization: `Bearer ${wide}` } });
    assert.equal(b.status, 404);
  });
});

test("state changes from an embedded session are logged with the subject", async () => {
  const entries: Readonly<Record<string, unknown>>[] = [];
  await withStudio(async ({ port }) => {
    const sessionToken = await embedSession(port, TENANT_A, "user_1");
    const put = await send(port, {
      method: "PUT",
      path: `/_studio/tenants/${TENANT_A}/runtime/v1/sessions/s1?x=secret`,
      body: JSON.stringify({ agentId: "a" }),
      headers: {
        authorization: `Bearer ${sessionToken}`,
        origin: `http://localhost:${port}`,
        "content-type": "application/json",
      },
    });
    assert.equal(put.status, 200, put.body);
    await send(port, { path: `/_studio/tenants/${TENANT_A}/runtime/v1/agents`, headers: { authorization: `Bearer ${sessionToken}` } });
  }, { log: (entry) => entries.push(entry) });
  assert.deepEqual(entries, [
    { msg: "studio proxy", subject: "user_1", tenant: TENANT_A, method: "PUT", path: "/v1/sessions/s1", status: 200 },
  ]);
});

test("only the allowlist may frame dashboard files; nothing else can be framed", async () => {
  await withStudio(async ({ port }) => {
    for (const path of ["/", `/tenants/${TENANT_A}`, `/tenants/${TENANT_A}/sessions/s1`, "/assets/app.js"]) {
      const reply = await send(port, { path });
      assert.equal(reply.status, path === "/" ? 302 : 200, path);
      assert.equal(reply.headers["content-security-policy"], `frame-ancestors ${EMBEDDERS.join(" ")}`, path);
      assert.equal(reply.headers["x-frame-options"], undefined, path);
    }
    const index = await send(port, { path: `/tenants/${TENANT_A}` });
    assert.match(index.body, new RegExp(`<meta name="nylorun-frame-ancestors" content="${EMBEDDERS.join(" ")}">`));
    const { token } = await mint(port);
    for (const [path, init] of [
      ["/_studio/hello", {}],
      ["/_studio/unknown", {}],
      ["/assets/missing.js", {}],
      [`/login?token=${token}`, {}],
      ["/login?token=used", {}],
    ] as const) {
      const reply = await send(port, { path, ...init });
      assert.equal(reply.headers["x-frame-options"], "DENY", path);
      const csp = reply.headers["content-security-policy"];
      if (csp !== undefined) assert.match(String(csp), /frame-ancestors 'none'/, path);
    }
  }, { frameAncestors: EMBEDDERS });
  await withStudio(async ({ port }) => {
    const reply = await send(port, { path: `/tenants/${TENANT_A}` });
    assert.equal(reply.headers["content-security-policy"], "frame-ancestors 'none'");
    assert.match(reply.body, /<meta name="nylorun-frame-ancestors" content="">/);
  });
});

test("index.html names the analytics measurement id only when Studio has one", async () => {
  await withStudio(async ({ port }) => {
    const reply = await send(port, { path: `/tenants/${TENANT_A}` });
    assert.match(reply.body, /<meta name="nylorun-analytics" content="G-K6RPDFH6Q6">/);
  }, { analyticsId: "G-K6RPDFH6Q6" });
  await withStudio(async ({ port }) => {
    const reply = await send(port, { path: `/tenants/${TENANT_A}` });
    assert.doesNotMatch(reply.body, /nylorun-analytics/);
  });
  assert.equal(parseAnalyticsId(""), undefined);
  assert.equal(parseAnalyticsId(" G-K6RPDFH6Q6 "), "G-K6RPDFH6Q6");
  assert.throws(() => parseAnalyticsId('G-1"><script>'), /not a Google Analytics measurement id/);
});

test("the container entry refuses invalid configuration, naming the variable", async () => {
  const { spawn } = await import("node:child_process");
  const dir = await mkdtemp(join(tmpdir(), "nylorun-studio-entry-"));
  const keyFile = join(dir, "host-credentials.json");
  await writeFile(keyFile, JSON.stringify({ adminKey: ADMIN_KEY }));
  try {
    for (const [name, value] of [
      ["NYLORUN_STUDIO_FRAME_ANCESTORS", "*"],
      ["NYLORUN_STUDIO_FRAME_ANCESTORS", "https://*.example.com"],
      ["NYLORUN_STUDIO_FRAME_ANCESTORS", "nylorun:"],
      ["NYLORUN_STUDIO_SESSION_COOKIE", "a;b"],
      ["NYLORUN_STUDIO_ALLOWED_HOSTS", "https://studio.acme.dev"],
    ] as const) {
      const child = spawn(process.execPath, [new URL("../dist/server-main.js", import.meta.url).pathname], {
        env: {
          ...process.env,
          NYLORUN_RUNTIME_URL: "http://127.0.0.1:9",
          NYLORUN_ADMIN_KEY_FILE: keyFile,
          PORT: "3999",
          [name]: value,
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const [code] = await once(child, "exit");
      assert.equal(code, 1, value);
      assert.match(stderr, new RegExp(`^${name}: `), value);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- forwarded sign-in (F9 S1) and allowed hosts ---------------------------------------------

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
/** A JWT-shaped token; the fake Runtime's `me` map decides whether it is valid. */
function jwt(claims: Record<string, unknown>): string {
  return `${b64({ alg: "RS256", typ: "JWT", kid: "k1" })}.${b64(claims)}.c2lnbmF0dXJl`;
}
const scoped = (subject: string, scopes: string[]) => ({
  status: 200,
  body: { subject, scopes, agents: "*", sandboxes: [], via: "issuer:keycloak" },
});
/** `exp` in seconds, `ttl` seconds after the test clock's now. */
const expIn = (clock: { now: number }, ttl: number) => Math.floor(clock.now / 1000) + ttl;
const cookieOf = (reply: Reply) => String(reply.headers["set-cookie"]?.[0] ?? "");
const meCalls = (runtime: { seen: Seen[] }) => runtime.seen.filter((entry) => entry.path === "/v1/me");

test("a forwarded bearer with the studio scope signs in with Studio's cookie, for its subject", async () => {
  const entries: Readonly<Record<string, unknown>>[] = [];
  const clock = { now: 1_000_000 };
  await withStudio(async ({ port, runtime }) => {
    const token = jwt({ sub: "alice", exp: expIn(clock, 600) });
    runtime.me.set(token, scoped("u:alice", ["sessions:own", "studio"]));
    const hello = await send(port, { path: "/_studio/hello", headers: { authorization: `Bearer ${token}` } });
    assert.equal(hello.status, 200, hello.body);
    const setCookie = cookieOf(hello);
    assert.match(setCookie, new RegExp(`^${SESSION_COOKIE}=v3\\.`));
    assert.match(setCookie, /; HttpOnly; SameSite=Strict; Path=\/; Max-Age=600$/u);
    // Verified with the Runtime, with the protocol header; the token goes nowhere else.
    const [check] = meCalls(runtime);
    assert.equal(check!.headers.authorization, `Bearer ${token}`);
    assert.equal(check!.headers[PROTOCOL_HEADER.toLowerCase()], String(PROTOCOL_VERSION));
    assert.ok(!hello.body.includes(token));

    // The cookie alone is a session: no second check.
    const cookie = setCookie.split(";")[0]!;
    assert.equal((await send(port, { path: "/_studio/hello", headers: { cookie } })).status, 200);
    // So is the forwarded bearer beside it (oauth2-proxy sends it on every request).
    assert.equal(
      (await send(port, { path: "/_studio/hello", headers: { cookie, authorization: `Bearer ${token}` } })).status,
      200,
    );
    assert.equal(meCalls(runtime).length, 1);

    // Tenant-wide, through the Tenant's Studio key; writes are logged with the subject.
    const put = await send(port, {
      method: "PUT",
      path: `/_studio/tenants/${TENANT_A}/runtime/v1/sessions/s1`,
      body: JSON.stringify({ agentId: "a" }),
      headers: { cookie, origin: `http://localhost:${port}`, "content-type": "application/json" },
    });
    assert.equal(put.status, 200, put.body);
    const upstream = runtime.seen.at(-1)!;
    assert.equal(upstream.headers.authorization, `Bearer ${deriveStudioToken(ADMIN_KEY)}`);

    // The cookie ends with the token (seen on a Host that needs a session).
    clock.now += 599_000;
    assert.equal((await send(port, { path: "/_studio/hello", host: PROXIED, headers: { cookie } })).status, 200);
    clock.now += 1_000;
    assert.equal((await send(port, { path: "/_studio/hello", host: PROXIED, headers: { cookie } })).status, 401);

    // A forged subject is refused.
    const [version, claims, signature] = cookie.split("=")[1]!.split(".") as [string, string, string];
    const decoded = JSON.parse(Buffer.from(claims, "base64url").toString("utf8"));
    const forged = `${SESSION_COOKIE}=${version}.${b64({ ...decoded, sub: "u:mallory", exp: decoded.exp + 10_000 })}.${signature}`;
    clock.now -= 600_000;
    assert.equal((await send(port, { path: "/_studio/hello", host: PROXIED, headers: { cookie: forged } })).status, 401);
  }, { clock, allowedHosts: [PROXIED], log: (entry) => entries.push(entry) });
  assert.deepEqual(entries, [
    { msg: "studio proxy", subject: "u:alice", tenant: TENANT_A, method: "PUT", path: "/v1/sessions/s1", status: 200 },
  ]);
});

test("oauth2-proxy's X-Forwarded-Access-Token signs in, beside its Basic Authorization", async () => {
  const clock = { now: 1_000_000 };
  await withStudio(async ({ port, runtime }) => {
    const token = jwt({ sub: "bob", exp: expIn(clock, 60 * 24 * 60 * 60) });
    runtime.me.set(token, scoped("u:bob", ["studio"]));
    const reply = await send(port, {
      path: `/_studio/tenants/${TENANT_A}/runtime/v1/agents`,
      headers: { "x-forwarded-access-token": token, authorization: "Basic Ym9iOg==" },
    });
    assert.equal(reply.status, 200, reply.body);
    // A token that outlives Studio's cookie gets the usual 30 days.
    assert.match(cookieOf(reply), new RegExp(`Max-Age=${SESSION_TTL_MS / 1000}$`));
    assert.equal(runtime.seen.at(-1)!.headers.authorization, `Bearer ${deriveStudioToken(ADMIN_KEY)}`);
    assert.equal(meCalls(runtime).length, 1);
  }, { clock });
});

test("forwarded sign-in refuses an unscoped, invalid or opaque token", async () => {
  await withStudio(async ({ port, runtime }) => {
    const unscoped = jwt({ sub: "carol", exp: 9_999_999_999 });
    runtime.me.set(unscoped, scoped("u:carol", ["sessions:own", "agents:read"]));
    for (const headers of [{ authorization: `Bearer ${unscoped}` }, { "x-forwarded-access-token": unscoped }]) {
      const reply = await send(port, { path: "/_studio/hello", headers });
      assert.equal(reply.status, 403, reply.body);
      assert.match(JSON.parse(reply.body).message, /does not carry the studio scope/);
      assert.equal(reply.headers["set-cookie"], undefined);
    }

    const invalid = jwt({ sub: "dave", exp: 9_999_999_999 });
    const refused = await send(port, { path: "/_studio/hello", headers: { "x-forwarded-access-token": invalid } });
    assert.equal(refused.status, 401);
    assert.match(JSON.parse(refused.body).message, /^The Runtime refused the forwarded token: Invalid bearer token\./);
    assert.equal(refused.headers["set-cookie"], undefined);

    const missing = jwt({ sub: "erin" });
    runtime.me.set(missing, { status: 404, body: { message: "Not found" } });
    assert.equal((await send(port, { path: "/_studio/hello", headers: { authorization: `Bearer ${missing}` } })).status, 401);

    // Not a JWT: refused without asking the Runtime.
    const before = meCalls(runtime).length;
    const opaque = await send(port, { path: "/_studio/hello", headers: { "x-forwarded-access-token": "gho_opaque" } });
    assert.equal(opaque.status, 401);
    assert.match(JSON.parse(opaque.body).message, /not a JWT/);
    assert.equal(meCalls(runtime).length, before);
  });
});

test("embed bearer sessions and CLI sign-in are unchanged by forwarded sign-in", async () => {
  await withStudio(async ({ port, runtime }) => {
    const token = jwt({ sub: "alice", exp: 9_999_999_999 });
    runtime.me.set(token, scoped("u:alice", ["studio"]));
    // A valid embed session wins over a forwarded token; no Runtime check.
    const sessionToken = await embedSession(port, TENANT_A);
    const embedded = await send(port, {
      path: "/_studio/hello",
      headers: { authorization: `Bearer ${sessionToken}`, "x-forwarded-access-token": token },
    });
    assert.equal(embedded.status, 200);
    assert.equal(embedded.headers["set-cookie"], undefined);
    // A bad Studio bearer is refused even beside a forwarded token or a cookie.
    const cookie = await session(port);
    for (const bad of ["v2.x.y", "browser-supplied"]) {
      const reply = await send(port, {
        path: "/_studio/hello",
        headers: { authorization: `Bearer ${bad}`, "x-forwarded-access-token": token, cookie },
      });
      assert.equal(reply.status, 401, bad);
    }
    assert.equal(meCalls(runtime).length, 0);
    // The CLI's cookie still signs in on its own.
    assert.equal((await send(port, { path: "/_studio/hello", headers: { cookie } })).status, 200);
  });
});

test("NYLORUN_STUDIO_ALLOWED_HOSTS adds Host values; others are still refused", async () => {
  await withStudio(async ({ port, runtime }) => {
    const host = "studio.acme.dev";
    const token = jwt({ sub: "alice", exp: 9_999_999_999 });
    runtime.me.set(token, scoped("u:alice", ["studio"]));
    // The proxy ends TLS: the cookie is Secure.
    const hello = await send(port, {
      path: "/_studio/hello",
      host,
      headers: { "x-forwarded-access-token": token, "x-forwarded-proto": "https" },
    });
    assert.equal(hello.status, 200, hello.body);
    assert.match(cookieOf(hello), /; Secure$/u);
    const cookie = cookieOf(hello).split(";")[0]!;
    assert.equal((await send(port, { path: "/", host, headers: { cookie } })).status, 302);
    assert.equal((await send(port, { path: `/tenants/${TENANT_A}`, host: "STUDIO.ACME.DEV" })).status, 200);
    // State changes from the proxied origin (https or http) pass; another origin does not.
    for (const origin of [`https://${host}`, `http://${host}`]) {
      const put = await send(port, {
        method: "PUT",
        path: `/_studio/tenants/${TENANT_A}/runtime/v1/sessions/s1`,
        host,
        body: JSON.stringify({ agentId: "a" }),
        headers: { cookie, origin, "content-type": "application/json" },
      });
      assert.equal(put.status, 200, `${origin} ${put.body}`);
    }
    const evil = await send(port, {
      method: "PUT",
      path: `/_studio/tenants/${TENANT_A}/runtime/v1/sessions/s1`,
      host,
      body: "{}",
      headers: { cookie, origin: "https://evil.example", "content-type": "application/json" },
    });
    assert.equal(evil.status, 403);
    // The loopback address still works; an unlisted Host does not.
    assert.equal((await send(port, { path: "/_studio/hello", headers: { cookie } })).status, 200);
    for (const other of ["other.acme.dev", `${host}:8443`, `evil.${host}`]) {
      const reply = await send(port, { path: "/_studio/hello", host: other, headers: { cookie } });
      assert.equal(reply.status, 421, other);
      assert.match(JSON.parse(reply.body).message, /NYLORUN_STUDIO_ALLOWED_HOSTS/);
    }
    // CLI sign-in on the listed host: the login URL opens there.
    const minted = await send(port, {
      method: "POST",
      path: "/_studio/login-tokens",
      host,
      headers: { authorization: `Bearer ${ADMIN_KEY}`, "x-forwarded-proto": "https" },
    });
    assert.equal(minted.status, 201);
    const { token: login } = JSON.parse(minted.body) as { token: string; url: string };
    assert.match(JSON.parse(minted.body).url, /^https:\/\/studio\.acme\.dev\/login\?token=/);
    const signedIn = await send(port, { path: `/login?token=${login}`, host });
    assert.equal(signedIn.status, 303);
  }, { allowedHosts: ["studio.acme.dev"], log: () => {} });
});

test("parseAllowedHosts accepts host names with optional ports and refuses anything else", () => {
  assert.deepEqual(parseAllowedHosts(""), []);
  assert.deepEqual(parseAllowedHosts(" Studio.Acme.dev , studio.acme.dev:8443,,10.0.0.5:3000 "), [
    "studio.acme.dev",
    "studio.acme.dev:8443",
    "10.0.0.5:3000",
  ]);
  for (const bad of ["https://studio.acme.dev", "studio.acme.dev/path", "*.acme.dev", "studio acme", "studio.acme.dev:99999", "-x.dev"])
    assert.throws(() => parseAllowedHosts(bad), /is not a Host value/, bad);
});
