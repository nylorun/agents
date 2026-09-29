import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  TENANT_HEADER,
} from "@nylorun/agents";
import { deriveStudioToken, deriveTenantKey } from "@nylorun/admin";
import {
  LOGIN_TOKEN_TTL_MS,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  TENANT_NAME_MAX,
  parseRuntimeUrl,
  readAdminKeyFile,
  safeNextPath,
  startStudioServer,
} from "../dist/server.js";

const ADMIN_KEY = "a".repeat(64);
const TENANT_A = "tn_00000000000000000000000001";
const TENANT_B = "tn_00000000000000000000000002";

type Seen = { method: string; path: string; headers: IncomingHttpHeaders; body: string };
type Reply = { status: number; headers: IncomingHttpHeaders; body: string };

/** Fake Runtime: /health, the Admin API tenant list, and an echoing Tenant API. */
async function startFakeRuntime() {
  const seen: Seen[] = [];
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
            features: [...PROTOCOL_FEATURES, "derived-principals"],
          },
        }),
      );
      return;
    }
    if (req.url === "/v1/admin/tenants" && req.method === "POST") {
      const created = JSON.parse(body) as { tenantId: string; name: string };
      res.statusCode = 201;
      res.end(
        JSON.stringify({
          id: created.tenantId,
          name: created.name,
          createdAt: "2026-09-29T00:00:00.000Z",
          updatedAt: "2026-09-29T00:00:00.000Z",
          schemaVersion: 1,
        }),
      );
      return;
    }
    if (req.url === "/v1/admin/tenants") {
      if (req.headers.authorization !== `Bearer ${ADMIN_KEY}`) {
        res.statusCode = 401;
        res.end(JSON.stringify({ code: "unauthorized", message: "no" }));
        return;
      }
      res.end(
        JSON.stringify([
          { id: TENANT_A, name: "orders", state: "open", envelope: null },
          { id: TENANT_B, name: null, state: "quarantined", envelope: null },
        ]),
      );
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
  extra: { publicPort?: number; adminKey?: string; clock?: { now: number } } = {},
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
  for (const tenant of [TENANT_A, TENANT_B])
    assert.ok(!text.includes(deriveStudioToken(ADMIN_KEY, tenant)), "Studio key leaked");
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

test("a session survives a Studio restart and lasts 30 days", async () => {
  const clock = { now: 1_000_000 };
  let cookie = "";
  await withStudio(async ({ port }) => {
    cookie = await session(port);
  }, { clock });
  // A new Studio process with the same admin key accepts the cookie.
  await withStudio(async ({ port }) => {
    clock.now += SESSION_TTL_MS - 1;
    assert.equal((await send(port, { path: "/", headers: { cookie } })).status, 200);
    clock.now += 1;
    assert.equal((await send(port, { path: "/", headers: { cookie } })).status, 401);
  }, { clock });
});

test("a session ends when the admin key changes, and cannot be forged", async () => {
  const clock = { now: 1_000_000 };
  let cookie = "";
  await withStudio(async ({ port }) => {
    cookie = await session(port);
  }, { clock });
  await withStudio(async ({ port }) => {
    assert.equal((await send(port, { path: "/", headers: { cookie } })).status, 401);
  }, { clock, adminKey: "b".repeat(64) });
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
      assert.equal((await send(port, { path: "/", headers: { cookie: attempt } })).status, 401, attempt);
    assert.equal((await send(port, { path: "/", headers: { cookie } })).status, 200);
  }, { clock });
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

test("every route but /login and /healthz needs a session cookie", async () => {
  await withStudio(async ({ port }) => {
    for (const path of ["/", "/assets/app.js", `/tenants/${TENANT_A}`, "/_studio/tenants", "/_studio/hello", `/_studio/tenants/${TENANT_A}/runtime/v1/agents`]) {
      const anonymous = await send(port, { path });
      assert.equal(anonymous.status, 401, path);
      assert.ok(!anonymous.body.includes("studio-spa"));
      const forged = await send(port, { path, headers: { cookie: `${SESSION_COOKIE}=${"x".repeat(43)}` } });
      assert.equal(forged.status, 401, path);
    }
    const health = await send(port, { path: "/healthz" });
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { status: "ok" });

    const cookie = await session(port);
    const index = await send(port, { path: "/", headers: { cookie } });
    assert.equal(index.status, 200);
    assert.match(index.body, /studio-spa/);
    const spa = await send(port, { path: `/tenants/${TENANT_A}/vault`, headers: { cookie: `other=1; ${cookie}` } });
    assert.equal(spa.status, 200);
    assert.match(spa.body, /studio-spa/);
    const asset = await send(port, { path: "/assets/app.js", headers: { cookie } });
    assert.equal(asset.status, 200);
    assert.equal(asset.headers["x-frame-options"], "DENY");
  });
});

test("Host must be the published loopback address (DNS rebinding)", async () => {
  await withStudio(async ({ port }) => {
    const cookie = await session(port);
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`])
      assert.equal((await send(port, { path: "/", host, headers: { cookie } })).status, 200, host);
    for (const host of [`rebind.attacker.example:${port}`, `localhost:${port + 1}`, `[::1]:${port}`, "localhost", `LOCALHOST.evil:${port}`]) {
      for (const path of ["/", "/_studio/tenants", "/login?token=x"])
        assert.equal((await send(port, { path, host, headers: { cookie } })).status, 421, `${host} ${path}`);
      const minted = await send(port, {
        method: "POST",
        path: "/_studio/login-tokens",
        host,
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      });
      assert.equal(minted.status, 421, host);
    }
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
      await send(port, { method: "OPTIONS", path: "/_studio/tenants", headers: { origin: "http://evil.example", "access-control-request-method": "GET" } }),
      await send(port, { method: "OPTIONS", path: "/_studio/tenants", headers: { cookie, origin: `http://localhost:${port}` } }),
      await send(port, { path: "/_studio/tenants", headers: { cookie, origin: "http://evil.example" } }),
      await send(port, { path: `/_studio/tenants/${TENANT_A}/runtime/v1/agents`, headers: { cookie, origin: "http://evil.example" } }),
      await send(port, { path: "/", headers: { origin: "http://evil.example" } }),
      await send(port, { path: "/healthz", headers: { origin: "http://evil.example" } }),
    ];
    for (const reply of replies) assertNoCors(reply);
  });
});

test("the proxy uses each Tenant's derived Studio key and never leaks keys", async () => {
  await withStudio(async ({ port, runtime }) => {
    const cookie = await session(port);
    for (const tenant of [TENANT_A, TENANT_B]) {
      const reply = await send(port, {
        path: `/_studio/tenants/${tenant}/runtime/v1/agents`,
        headers: { cookie, authorization: "Bearer browser-supplied" },
      });
      assert.equal(reply.status, 200, reply.body);
      assertNoKeys(reply);
      const upstream = runtime.seen.at(-1)!;
      assert.equal(upstream.path, "/v1/agents");
      assert.equal(upstream.headers.authorization, `Bearer ${deriveStudioToken(ADMIN_KEY, tenant)}`);
      assert.equal(upstream.headers[TENANT_HEADER.toLowerCase()], tenant);
      assert.equal(upstream.headers[PROTOCOL_HEADER.toLowerCase()], String(PROTOCOL_VERSION));
      assert.equal(upstream.headers.cookie, undefined);
      assert.equal(upstream.headers.origin, undefined);
    }
    assert.notEqual(deriveStudioToken(ADMIN_KEY, TENANT_A), deriveStudioToken(ADMIN_KEY, TENANT_B));

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

test("the Tenant list comes from the Admin API with the admin key", async () => {
  await withStudio(async ({ port, runtime }) => {
    const cookie = await session(port);
    const reply = await send(port, { path: "/_studio/tenants", headers: { cookie } });
    assert.equal(reply.status, 200, reply.body);
    assert.deepEqual(JSON.parse(reply.body), {
      tenants: [
        { id: TENANT_A, name: "orders", state: "open" },
        { id: TENANT_B, name: null, state: "quarantined" },
      ],
    });
    assertNoKeys(reply);
    const upstream = runtime.seen.find((s) => s.path === "/v1/admin/tenants")!;
    assert.equal(upstream.headers.authorization, `Bearer ${ADMIN_KEY}`);
    assert.equal(upstream.headers[PROTOCOL_HEADER.toLowerCase()], String(PROTOCOL_VERSION));

    const hello = await send(port, { path: "/_studio/hello", headers: { cookie } });
    assert.equal(hello.status, 200);
    assert.deepEqual(JSON.parse(hello.body).runtime, { compatible: true });
    assertNoKeys(hello);
  });
});

test("Studio creates a Tenant with the project principal and returns no key", async () => {
  await withStudio(async ({ port, runtime }) => {
    const cookie = await session(port);
    const origin = `http://localhost:${port}`;
    const create = (body: string, headers: Record<string, string> = {}) =>
      send(port, {
        method: "POST",
        path: "/_studio/tenants",
        body,
        headers: { cookie, origin, "content-type": "application/json", ...headers },
      });

    const anonymous = await send(port, {
      method: "POST",
      path: "/_studio/tenants",
      body: '{"name":"x"}',
      headers: { origin, "content-type": "application/json" },
    });
    assert.equal(anonymous.status, 401);
    const noOrigin = await send(port, {
      method: "POST",
      path: "/_studio/tenants",
      body: '{"name":"x"}',
      headers: { cookie, "content-type": "application/json" },
    });
    assert.equal(noOrigin.status, 403);
    for (const [body, headers] of [
      ['{"name":"  "}', {}],
      [JSON.stringify({ name: "n".repeat(TENANT_NAME_MAX + 1) }), {}],
      ['{"name":3}', {}],
      ["not json", {}],
      ['{"name":"x"}', { "content-type": "text/plain" }],
      [JSON.stringify({ name: "x", pad: "p".repeat(5000) }), {}],
    ] as const) {
      const rejected = await create(body, headers);
      assert.equal(rejected.status, 400, body.slice(0, 40));
    }
    assert.equal(runtime.seen.filter((s) => s.method === "POST").length, 0);

    const reply = await create(JSON.stringify({ name: "  my-agents  " }));
    assert.equal(reply.status, 201, reply.body);
    const { tenant } = JSON.parse(reply.body) as { tenant: { id: string; name: string; state: string } };
    assert.equal(tenant.name, "my-agents");
    assert.equal(tenant.state, "open");
    assert.match(tenant.id, /^tn_/);

    const sent = runtime.seen.find((s) => s.method === "POST" && s.path === "/v1/admin/tenants");
    assert.ok(sent);
    assert.equal(sent.headers.authorization, `Bearer ${ADMIN_KEY}`);
    const request = JSON.parse(sent.body) as {
      tenantId: string;
      name: string;
      derivedPrincipals: { id: string; credentialHash: string }[];
    };
    assert.equal(request.tenantId, tenant.id);
    const projectKey = deriveTenantKey(ADMIN_KEY, tenant.id, "project");
    assert.deepEqual(request.derivedPrincipals, [
      { id: "project", credentialHash: createHash("sha256").update(projectKey).digest("hex") },
    ]);
    assert.ok(!reply.body.includes(projectKey), "the project key never reaches the browser");
    assert.ok(!reply.body.includes("applicationKey"));
    assertNoKeys(reply);
  });
});

test("the Tenant list reports an unavailable Runtime as 502", async () => {
  const root = await webRoot();
  const studio = await startStudioServer({
    runtimeUrl: "http://127.0.0.1:1",
    adminKey: ADMIN_KEY,
    port: 0,
    webRoot: root,
  });
  try {
    const cookie = await session(studio.port);
    const reply = await send(studio.port, { path: "/_studio/tenants", headers: { cookie } });
    assert.equal(reply.status, 502);
    assertNoKeys(reply);
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
