/**
 * F9 C2: MCP OAuth connect into an installation vault, end to end over the Tenant API, an
 * in-test OAuth authorization server (discovery, DCR, PKCE, refresh) and the protected MCP
 * server it guards. With `NYLORUN_TEST_MODEL_GATE=http` the gateway's keys module runs the
 * OAuth and authorizes the MCP calls (F9-D14); the runtime side's fetch then fails every call,
 * and is never called.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Agent } from "@nylorun/core/define";
import type { ModelProvider } from "../src/core/provider.js";
import { guardedFetch, type OutboundPolicy } from "../src/tenant/outbound.js";
import { testTenantPool } from "./support/store.js";
import { startTestTenant } from "./support/tenant.js";

const APP = "mcp-oauth-app-key-aaaaaaaaaaaaaaaa";
const KEK = Buffer.alloc(32, 9).toString("base64");
const HTTP_GATE = process.env.NYLORUN_TEST_MODEL_GATE === "http";
const MANAGEMENT = "mcp-oauth-management-key-aaaaaaaaa";
const server = { authorization: `Bearer ${APP}`, "content-type": "application/json" };
/** The Management API's key (protocol 8): the vault routes take it alone. */
const management = { authorization: `Bearer ${MANAGEMENT}`, "content-type": "application/json" };

type Started = Awaited<ReturnType<typeof startTestTenant>>;
const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close().catch(() => undefined);
});

async function call(
  runtime: Started,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${runtime.url}${path}`, {
    method,
    headers: options.headers ?? (path.startsWith("/v1/tenant") ? management : server),
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: response.status, body };
}

const readBody = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
};
const sendJson = (res: ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

/**
 * An OAuth authorization server and the MCP server it protects, on one origin: RFC 9728 and
 * RFC 8414 metadata, DCR (unless `dcr: false`), an authorize endpoint that approves at once
 * (or answers `deny`), a token endpoint that checks PKCE and rotates refresh tokens, and an MCP
 * endpoint that answers 401 without a live access token.
 */
async function oauthServer(options: { dcr?: boolean; deny?: boolean; clients?: string[] } = {}) {
  const requests: string[] = [];
  const clients = new Map<string, string[]>(
    (options.clients ?? []).map((id) => [id, []] as [string, string[]]),
  );
  const codes = new Map<string, { clientId: string; challenge: string; redirectUri: string; resource?: string }>();
  const live = new Set<string>();
  const refreshTokens = new Map<string, string>();
  const grants: string[] = [];
  const mcpAuthorizations: (string | null)[] = [];
  let issued = 0;
  const issue = (clientId: string) => {
    issued += 1;
    const access = `access-${issued}-${randomBytes(4).toString("hex")}`;
    const refresh = `refresh-${issued}-${randomBytes(4).toString("hex")}`;
    live.add(access);
    refreshTokens.set(refresh, clientId);
    return { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 3600 };
  };
  let base = "";
  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    requests.push(`${req.method} ${url.pathname}`);
    if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource/mcp")
      return sendJson(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["tools"] });
    if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server")
      return sendJson(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        ...(options.dcr === false ? {} : { registration_endpoint: `${base}/register` }),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    if (req.method === "POST" && url.pathname === "/register") {
      const body = JSON.parse(await readBody(req)) as { redirect_uris: string[] };
      const id = `client-${clients.size + 1}`;
      clients.set(id, body.redirect_uris);
      return sendJson(res, 201, { ...body, client_id: id, token_endpoint_auth_method: "none" });
    }
    if (req.method === "GET" && url.pathname === "/authorize") {
      const q = url.searchParams;
      const redirectUri = q.get("redirect_uri")!;
      const registered = clients.get(q.get("client_id") ?? "");
      if (!registered || (registered.length > 0 && !registered.includes(redirectUri)))
        return sendJson(res, 400, { error: "invalid_client" });
      if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge"))
        return sendJson(res, 400, { error: "invalid_request" });
      const back = new URL(redirectUri);
      back.searchParams.set("state", q.get("state") ?? "");
      if (options.deny) back.searchParams.set("error", "access_denied");
      else {
        const code = `code-${randomBytes(6).toString("hex")}`;
        codes.set(code, {
          clientId: q.get("client_id")!,
          challenge: q.get("code_challenge")!,
          redirectUri,
          ...(q.get("resource") ? { resource: q.get("resource")! } : {}),
        });
        back.searchParams.set("code", code);
      }
      return res.writeHead(302, { location: back.href }).end();
    }
    if (req.method === "POST" && url.pathname === "/token") {
      const form = new URLSearchParams(await readBody(req));
      const grant = form.get("grant_type") ?? "";
      grants.push(grant);
      if (grant === "authorization_code") {
        const code = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
        if (
          !code ||
          code.challenge !== challenge ||
          code.redirectUri !== form.get("redirect_uri") ||
          code.clientId !== form.get("client_id") ||
          (code.resource ?? null) !== form.get("resource")
        )
          return sendJson(res, 400, { error: "invalid_grant" });
        return sendJson(res, 200, issue(code.clientId));
      }
      if (grant === "refresh_token") {
        const clientId = refreshTokens.get(form.get("refresh_token") ?? "");
        refreshTokens.delete(form.get("refresh_token") ?? "");
        if (!clientId || clientId !== form.get("client_id")) return sendJson(res, 400, { error: "invalid_grant" });
        return sendJson(res, 200, issue(clientId));
      }
      return sendJson(res, 400, { error: "unsupported_grant_type" });
    }
    if (url.pathname === "/mcp") {
      const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : null;
      if (req.method !== "POST") return res.writeHead(405).end();
      mcpAuthorizations.push(authorization);
      if (!authorization || !live.has(authorization.replace(/^Bearer /, "")))
        return res
          .writeHead(401, {
            "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
          })
          .end();
      const raw = await readBody(req);
      const mcp = new McpServer({ name: "remote", version: "0.0.0" });
      mcp.registerTool(
        "echo",
        { description: "Echoes.", inputSchema: { value: z.number() } },
        async ({ value }) => ({ content: [{ type: "text", text: String(value) }] }),
      );
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcp.connect(transport);
      res.on("close", () => {
        void transport.close().catch(() => {});
        void mcp.close().catch(() => {});
      });
      return transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  open.push(() => new Promise<void>((resolve) => http.close(() => resolve())));
  return {
    base,
    mcpUrl: `${base}/mcp`,
    requests,
    grants,
    mcpAuthorizations,
    live,
    /** Every token the server issued, to check none leaks. */
    issuedTokens: () => [...live, ...refreshTokens.keys()],
  };
}

/** Calls `remote__echo` once, then answers. */
const model: ModelProvider = async (effect: { input: unknown }) => {
  const input = effect.input as { tools?: { name: string }[]; prompt?: { kind?: string }[] };
  const names = (input.tools ?? []).map((tool) => tool.name);
  if (!names.includes("remote__echo") || input.prompt?.at(-1)?.kind === "tool-result")
    return { output: [{ type: "text", text: "done" }] };
  return { output: [{ type: "tool-call", id: "call-1", name: "remote__echo", args: { value: 7 } }] };
};

/** The runtime side's fetch in HTTP gate mode: any call is a failure of F9-D14. */
function forbiddenFetch() {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    calls.push(String(input instanceof Request ? input.url : input));
    throw new Error("the runtime container made an outbound call");
  }) as typeof fetch;
  return { calls, fetchFn };
}

async function boot(options: { mcpUrl?: string; delivery?: OutboundPolicy } = {}) {
  const forbidden = forbiddenFetch();
  const runtime = await startTestTenant({
    applicationKey: APP,
    managementKey: MANAGEMENT,
    vaultKek: KEK,
    modelProvider: model,
    ...(options.delivery ? { delivery: options.delivery } : {}),
    // HTTP gate mode: the gateway calls the authorization server under the Host's policy, and
    // the runtime side's fetch fails every call.
    ...(HTTP_GATE ? { vaultFetch: forbidden.fetchFn, gateVaultFetch: guardedFetch(options.delivery ?? {}) } : {}),
  });
  open.push(() => runtime.close());
  const agent = (
    options.mcpUrl
      ? Agent({ id: "bot", name: "Bot" }).mcp({ remote: { type: "streamable-http", url: options.mcpUrl } })
      : Agent({ id: "bot", name: "Bot" })
  ).build();
  const saved = await call(runtime, "PUT", "/v1/agents/bot", {
    body: { requestId: "put-bot", manifest: agent.manifest, implementationVersion: "dev" },
  });
  expect(saved.status).toBe(200);
  return { runtime, forbidden };
}

async function installationVault(runtime: Started, name = "mcp") {
  const created = await call(runtime, "POST", "/v1/tenant/vaults", {
    body: { requestId: `vault-${name}`, idempotencyKey: `vault-${name}`, name, scope: "installation" },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return created.body.id as string;
}

async function start(runtime: Started, vaultId: string, body: Record<string, unknown>) {
  return call(runtime, "POST", `/v1/tenant/vaults/${vaultId}/oauth/start`, { body });
}

/** The browser: opens the authorize URL and follows the redirect back to the callback. */
async function signIn(authorizeUrl: string): Promise<{ status: number; html: string; callback: string }> {
  const approved = await fetch(authorizeUrl, { redirect: "manual" });
  expect(approved.status).toBe(302);
  const callback = approved.headers.get("location")!;
  const page = await fetch(callback, { redirect: "manual" });
  return { status: page.status, html: await page.text(), callback };
}

async function runTurn(runtime: Started, sessionId: string, vaultId: string) {
  const opened = await call(runtime, "PUT", `/v1/sessions/${sessionId}`, {
    body: { requestId: `open-${sessionId}`, agentId: "bot", ownerUserId: "u:a", vaultIds: [vaultId] },
  });
  expect(opened.status, JSON.stringify(opened.body)).toBe(200);
  const sent = await call(runtime, "POST", `/v1/sessions/${sessionId}/commands`, {
    body: { type: "message", requestId: `m-${sessionId}`, idempotencyKey: `m-${sessionId}`, content: "go" },
  });
  expect(sent.status).toBe(200);
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const view = await call(runtime, "GET", `/v1/sessions/${sessionId}`);
    if (["completed", "failed", "uncertain"].includes(view.body.status)) return view.body;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`session ${sessionId} did not finish`);
}

describe("MCP OAuth connect", () => {
  it("connects with DCR and PKCE, calls the MCP server with the token, and refreshes it once expired", async () => {
    const as = await oauthServer();
    const { runtime, forbidden } = await boot({ mcpUrl: as.mcpUrl });
    const vaultId = await installationVault(runtime);

    const started = await start(runtime, vaultId, { url: as.mcpUrl, server: "remote" });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const authorize = new URL(started.body.authorizeUrl);
    expect(authorize.origin + authorize.pathname).toBe(`${as.base}/authorize`);
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "client-1",
      code_challenge_method: "S256",
      redirect_uri: `${runtime.url}/v1/oauth/callback`,
      resource: as.mcpUrl,
      scope: "tools",
    });
    expect(Date.parse(started.body.expiresAt) - Date.now()).toBeGreaterThan(9 * 60_000);

    const signed = await signIn(started.body.authorizeUrl);
    expect(signed.status).toBe(200);
    expect(signed.html).toContain("Connected. You can close this tab.");
    expect(as.grants).toEqual(["authorization_code"]);

    const listed = await call(runtime, "GET", `/v1/tenant/vaults/${vaultId}/credentials`);
    expect(listed.body.credentials).toEqual([
      expect.objectContaining({ name: "remote", type: "oauth", binding: { url: as.mcpUrl }, expiresAt: expect.any(String) }),
    ]);
    const credentialId = listed.body.credentials[0].id as string;

    const first = await runTurn(runtime, "s-1", vaultId);
    expect(first.status).toBe("completed");
    const firstToken = as.mcpAuthorizations.at(-1)!;
    expect(firstToken).toMatch(/^Bearer access-1-/);
    expect(as.mcpAuthorizations.every((item) => item === firstToken)).toBe(true);

    // The access token expires at the server and in the vault: the next use refreshes it.
    as.live.delete(firstToken.replace(/^Bearer /, ""));
    const expired = await call(runtime, "POST", `/v1/tenant/vaults/${vaultId}/credentials/${credentialId}`, {
      body: {
        requestId: "expire",
        idempotencyKey: "expire",
        auth: { type: "oauth", accessToken: firstToken.replace(/^Bearer /, ""), expiresAt: "2000-01-01T00:00:00.000Z" },
      },
    });
    expect(expired.status).toBe(200);
    const before = as.mcpAuthorizations.length;
    const second = await runTurn(runtime, "s-2", vaultId);
    expect(second.status).toBe("completed");
    expect(as.grants).toEqual(["authorization_code", "refresh_token"]);
    const after = as.mcpAuthorizations.slice(before);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((item) => /^Bearer access-2-/.test(item ?? ""))).toBe(true);

    // No token leaves the vault: not in the page, the credential, or the sessions.
    const seen = JSON.stringify([signed.html, listed.body, first, second]);
    for (const token of as.issuedTokens()) expect(seen).not.toContain(token);

    // The state was used once.
    const again = await fetch(signed.callback);
    expect(again.status).toBe(400);
    expect(await again.text()).toContain("unknown, already used or expired");

    // Discovery, registration and the exchange came from the gateway (or this process), never
    // from the runtime side in HTTP gate mode.
    expect(as.requests).toEqual(
      expect.arrayContaining([
        "GET /.well-known/oauth-protected-resource/mcp",
        "GET /.well-known/oauth-authorization-server",
        "POST /register",
        "POST /token",
      ]),
    );
    expect(forbidden.calls).toEqual([]);
  });

  it("connects again into the same credential, and uses a given client id without registering", async () => {
    const as = await oauthServer({ dcr: false, clients: ["operator-client"] });
    const { runtime } = await boot({ mcpUrl: as.mcpUrl });
    const vaultId = await installationVault(runtime);
    const ids: string[] = [];
    for (const attempt of [1, 2]) {
      const started = await start(runtime, vaultId, { url: as.mcpUrl, server: "remote", clientId: "operator-client" });
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      expect(new URL(started.body.authorizeUrl).searchParams.get("client_id")).toBe("operator-client");
      expect((await signIn(started.body.authorizeUrl)).status, `attempt ${attempt}`).toBe(200);
      const listed = await call(runtime, "GET", `/v1/tenant/vaults/${vaultId}/credentials`);
      expect(listed.body.credentials).toHaveLength(1);
      ids.push(listed.body.credentials[0].id);
    }
    expect(ids[0]).toBe(ids[1]);
    expect(as.requests).not.toContain("POST /register");
  });

  it("asks for a client id when the server offers no registration", async () => {
    const as = await oauthServer({ dcr: false });
    const { runtime } = await boot();
    const vaultId = await installationVault(runtime);
    const started = await start(runtime, vaultId, { url: as.mcpUrl, server: "remote" });
    expect(started.status).toBe(400);
    expect(started.body).toMatchObject({ code: "oauth_client_required" });
  });

  it("refuses a bad, a reused and an expired state, and the server's error", async () => {
    const as = await oauthServer();
    const { runtime } = await boot();
    const vaultId = await installationVault(runtime);

    const bad = await fetch(`${runtime.url}/v1/oauth/callback?state=nope&code=x`);
    expect(bad.status).toBe(400);
    expect(bad.headers.get("content-type")).toContain("text/html");
    expect(bad.headers.get("cache-control")).toBe("no-store");
    expect(await bad.text()).toContain("unknown, already used or expired");
    expect((await fetch(`${runtime.url}/v1/oauth/callback?code=x`)).status).toBe(400);

    // Expired: the pending row outlived its ten minutes.
    const late = await start(runtime, vaultId, { url: as.mcpUrl, server: "remote" });
    expect(late.status).toBe(200);
    const sql = testTenantPool(runtime.tenantId);
    await sql`UPDATE nylorun.oauth_pending SET expires_at = '2000-01-01T00:00:00.000Z'`;
    const expired = await signIn(late.body.authorizeUrl);
    expect(expired.status).toBe(400);
    expect(expired.html).toContain("unknown, already used or expired");
    // Used up even so: the row is gone.
    expect((await sql`SELECT count(*)::int AS n FROM nylorun.oauth_pending`)[0]!.n).toBe(0);

    // The authorization server's error ends the connect, and its state with it.
    const denying = await oauthServer({ deny: true });
    const denied = await start(runtime, vaultId, { url: denying.mcpUrl, server: "remote" });
    expect(denied.status).toBe(200);
    const page = await signIn(denied.body.authorizeUrl);
    expect(page.status).toBe(400);
    expect(page.html).toContain("did not grant access (access_denied)");
    const state = new URL(denied.body.authorizeUrl).searchParams.get("state")!;
    const reused = await fetch(`${runtime.url}/v1/oauth/callback?state=${encodeURIComponent(state)}&code=x`);
    expect(reused.status).toBe(400);
    expect(await reused.text()).toContain("unknown, already used or expired");
    expect((await call(runtime, "GET", `/v1/tenant/vaults/${vaultId}/credentials`)).body.credentials).toEqual([]);
  });

  it("calls no private address when the Host refuses them", async () => {
    const as = await oauthServer();
    const { runtime, forbidden } = await boot({ delivery: { privateAddresses: "refuse" } });
    const vaultId = await installationVault(runtime);
    for (const url of [as.mcpUrl, as.mcpUrl.replace("127.0.0.1", "localhost")]) {
      const started = await start(runtime, vaultId, { url, server: "remote" });
      expect(started.status, url).toBe(400);
      expect(started.body).toMatchObject({ code: "request_rejected", message: expect.stringMatching(/private addresses/) });
    }
    expect(as.requests).toEqual([]);
    expect(forbidden.calls).toEqual([]);
  });

  it("starts only for a management key, into an installation vault", async () => {
    const as = await oauthServer();
    const { runtime } = await boot();
    const vaultId = await installationVault(runtime);
    const personal = await call(runtime, "POST", "/v1/tenant/vaults", {
      body: { requestId: "ada", idempotencyKey: "ada", name: "Ada's", ownerUserId: "ada" },
    });
    const body = { url: as.mcpUrl, server: "remote" };
    expect((await start(runtime, personal.body.id, body)).status).toBe(400);
    expect((await start(runtime, "host", body)).status).toBe(404);
    expect((await start(runtime, "missing", body)).status).toBe(404);
    const acting = await call(runtime, "POST", `/v1/tenant/vaults/${vaultId}/oauth/start`, {
      headers: { ...server, "nylorun-subject": "ada", "nylorun-scopes": "vaults:own" },
      body,
    });
    expect(acting).toMatchObject({ status: 403, body: { code: "key_role_mismatch" } });
    const application = await call(runtime, "POST", `/v1/tenant/vaults/${vaultId}/oauth/start`, {
      headers: server,
      body,
    });
    expect(application).toMatchObject({ status: 403, body: { code: "key_role_mismatch" } });
    expect((await start(runtime, vaultId, { url: as.mcpUrl })).status).toBe(400);
    expect(as.requests).toEqual([]);
  });
});
