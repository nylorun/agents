/**
 * The Studio server that runs in the `studio` container of the Docker stack:
 * the dashboard and the trusted proxy on one origin, behind a cookie session.
 *
 * - The CLI mints a single-use login token with the admin key
 *   (`POST /_studio/login-tokens`) and opens `/login?token=…`, which sets an
 *   `HttpOnly`, `SameSite=Strict` session cookie for `SESSION_TTL_MS`. The
 *   cookie is signed with a key derived from the admin key, so it survives
 *   Studio restarts and ends when the admin key changes (`nylorun reset`).
 * - Every other request needs that cookie, except `/healthz`.
 * - `Host` must be the published loopback address (DNS rebinding); requests
 *   that change state must carry this origin's `Origin`; no CORS headers.
 * - Tenants are listed and created through the Admin API with the admin key.
 *   A Tenant Studio creates registers the derived principal `project`, so a
 *   Project on this machine can link it (`nylo tenant use`). Tenant API
 *   calls use the Tenant's Studio key, derived from the admin key in memory.
 *   No key ever reaches the browser.
 *
 * This module does not read the environment; `server-main.ts` does.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  AdminError,
  PROJECT_PRINCIPAL_ID,
  createAdmin,
  deriveStudioToken,
} from "@nylorun/admin";
import { packagedWebRoot, serveDashboard } from "./static.js";
import { proxyRuntime } from "./proxy.js";
import {
  STUDIO_VERSION,
  probeRuntimeCompatibility,
  type RuntimeCompatibility,
} from "./runtime-compat.js";

export const SESSION_COOKIE = "nylorun_studio_session";
export const LOGIN_TOKEN_TTL_MS = 2 * 60 * 1000;
/** How long a browser stays signed in: 30 days. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_VERSION = "v1";
/** Sessions issued this far in the future (clock skew) are still accepted. */
const SESSION_SKEW_MS = 60 * 1000;

export type StudioServerOptions = Readonly<{
  /** Runtime base URL, e.g. `http://runtime:4000`. Non-loopback is allowed. */
  runtimeUrl: string;
  /** The Host's admin key. Kept in memory; never sent to the browser. */
  adminKey: string;
  /** Listen port. Default 3000; 0 picks a free port. */
  port?: number;
  /** Listen address. Default `127.0.0.1`; the container passes `0.0.0.0`. */
  host?: string;
  /** Port the browser uses (Docker's published port). Default: the bound port. */
  publicPort?: number;
  /** Built dashboard directory. Default: `dist/web` beside this module. */
  webRoot?: string;
  /** Clock for login-token and session expiry (tests). */
  now?: () => number;
}>;

export type StudioServer = Readonly<{
  port: number;
  publicPort: number;
  /** `http://localhost:<publicPort>` */
  url: string;
  close(): Promise<void>;
}>;

export type StudioTenantSummary = Readonly<{
  id: string;
  name: string | null;
  state: string;
}>;

export type StudioServerHello = Readonly<{
  version: string;
  runtime: RuntimeCompatibility;
}>;

const SAFE_METHODS = new Set(["GET", "HEAD"]);
/** Longest Tenant name Studio creates. */
export const TENANT_NAME_MAX = 64;
const MAX_JSON_BODY = 4096;
const TENANT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TENANT_RUNTIME = /^\/_studio\/tenants\/([^/]+)\/runtime(\/.*)$/;

/** Validates `NYLORUN_RUNTIME_URL`: absolute http(s), no credentials, query or fragment. */
export function parseRuntimeUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("NYLORUN_RUNTIME_URL must be an absolute http(s) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("NYLORUN_RUNTIME_URL must use http or https.");
  if (url.username !== "" || url.password !== "")
    throw new Error("NYLORUN_RUNTIME_URL must not contain credentials.");
  if (url.search !== "" || url.hash !== "")
    throw new Error(
      "NYLORUN_RUNTIME_URL must not contain a query string or fragment.",
    );
  return url.href.replace(/\/$/u, "");
}

/** Reads `{ adminKey }` from a `host-credentials.json` file. */
export function readAdminKeyFile(path: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read the admin key file ${path}: ${detail}`);
  }
  const adminKey =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { adminKey?: unknown }).adminKey
      : undefined;
  if (typeof adminKey !== "string" || adminKey.trim() === "")
    throw new Error(`The admin key file ${path} has no adminKey.`);
  return adminKey.trim();
}

/**
 * Where `/login` sends the browser: a same-origin path such as
 * `/tenants/<id>`, or `/`.
 */
export function safeNextPath(next: string | null): string {
  if (next === null || !/^\/(?![/\\])[^\\\s]*$/u.test(next)) return "/";
  const base = "http://studio.invalid";
  let resolved: URL;
  try {
    resolved = new URL(next, base);
  } catch {
    return "/";
  }
  if (resolved.origin !== base) return "/";
  if (
    resolved.pathname === "/login" ||
    resolved.pathname.startsWith("/_studio/")
  )
    return "/";
  return resolved.pathname + resolved.search;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** The key that signs session cookies, derived from the admin key. */
function sessionKey(adminKey: string): Buffer {
  return createHmac("sha256", adminKey).update("nylorun/studio-session/v1", "utf8").digest();
}

function sign(key: Buffer, payload: string): string {
  return createHmac("sha256", key).update(payload, "utf8").digest("base64url");
}

/** A session cookie value: `v1.<issued ms>.<nonce>.<signature>`. */
function issueSession(key: Buffer, issuedAt: number): string {
  const payload = `${SESSION_VERSION}.${issuedAt}.${randomBytes(16).toString("base64url")}`;
  return `${payload}.${sign(key, payload)}`;
}

function validSession(key: Buffer, value: string, at: number): boolean {
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== SESSION_VERSION) return false;
  const expected = Buffer.from(sign(key, parts.slice(0, 3).join(".")));
  const provided = Buffer.from(parts[3]!);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected))
    return false;
  if (!/^\d{1,16}$/u.test(parts[1]!)) return false;
  const issuedAt = Number(parts[1]);
  return issuedAt <= at + SESSION_SKEW_MS && at - issuedAt < SESSION_TTL_MS;
}

function bearer(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer "))
    return undefined;
  return header.slice("Bearer ".length);
}

function cookieValues(request: IncomingMessage, name: string): string[] {
  const header = request.headers.cookie;
  if (typeof header !== "string") return [];
  const values: string[] = [];
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name)
      values.push(part.slice(index + 1).trim());
  }
  return values;
}

function hostPort(host: string): string | undefined {
  const index = host.lastIndexOf(":");
  if (index < 0 || host.endsWith("]")) return undefined;
  return host.slice(index + 1);
}

function json(
  response: ServerResponse,
  status: number,
  value: unknown,
  method = "GET",
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(method === "HEAD" ? undefined : `${JSON.stringify(value)}\n`);
}

function fail(response: ServerResponse, status: number, message: string): void {
  json(response, status, { message });
}

/** A small JSON request body, or undefined when it is not JSON or too large. */
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const type = request.headers["content-type"] ?? "";
  if (!/^application\/json(;|$)/iu.test(type)) {
    request.resume();
    return undefined;
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_JSON_BODY) return undefined;
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function page(
  response: ServerResponse,
  status: number,
  title: string,
  message: string,
  method = "GET",
): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  });
  response.end(
    method === "HEAD"
      ? undefined
      : `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Nylorun Studio</title>
<style>body{font:16px system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#18181b}code{background:#f4f4f5;padding:.1rem .3rem;border-radius:.25rem}</style>
</head>
<body><h1>${title}</h1><p>${message}</p></body>
</html>
`,
  );
}

const SIGN_IN =
  "Run <code>npx nylorun studio</code> in a terminal. It opens Studio in your browser, signed in for 30 days.";

/** Starts the Studio server. The container entry is `server-main.ts`. */
export async function startStudioServer(
  options: StudioServerOptions,
): Promise<StudioServer> {
  const runtimeUrl = parseRuntimeUrl(options.runtimeUrl);
  const adminKey = options.adminKey;
  if (typeof adminKey !== "string" || adminKey === "")
    throw new Error("Studio requires the admin key.");
  const adminKeyDigest = digest(adminKey);
  const signingKey = sessionKey(adminKey);
  const webRoot = options.webRoot ?? packagedWebRoot();
  const now = options.now ?? Date.now;
  const admin = createAdmin({ url: runtimeUrl, key: adminKey });

  /** Login token → expiry (ms). Single use. */
  const loginTokens = new Map<string, number>();
  /** Tenant id → derived Studio key, in memory only. */
  const studioKeys = new Map<string, string>();

  let boundPort = 0;
  let publicPort = 0;
  let publicHosts: ReadonlySet<string> = new Set();

  const studioKey = (tenantId: string): string => {
    let key = studioKeys.get(tenantId);
    if (key === undefined) {
      key = deriveStudioToken(adminKey, tenantId);
      studioKeys.set(tenantId, key);
    }
    return key;
  };

  const hasSession = (request: IncomingMessage): boolean => {
    const at = now();
    return cookieValues(request, SESSION_COOKIE).some((value) =>
      validSession(signingKey, value, at),
    );
  };

  const mintLoginToken = (
    request: IncomingMessage,
    response: ServerResponse,
  ): void => {
    request.resume();
    const provided = bearer(request);
    if (
      provided === undefined ||
      !timingSafeEqual(digest(provided), adminKeyDigest)
    ) {
      response.setHeader("www-authenticate", "Bearer");
      fail(response, 401, "The admin key is required to mint a login token.");
      return;
    }
    const at = now();
    for (const [token, expiresAt] of loginTokens)
      if (expiresAt <= at) loginTokens.delete(token);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = at + LOGIN_TOKEN_TTL_MS;
    loginTokens.set(token, expiresAt);
    json(response, 201, {
      token,
      url: `http://localhost:${publicPort}/login?token=${token}`,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  };

  const login = (url: URL, response: ServerResponse): void => {
    const token = url.searchParams.get("token") ?? "";
    const expiresAt = loginTokens.get(token);
    loginTokens.delete(token);
    const at = now();
    if (expiresAt === undefined || expiresAt <= at) {
      page(
        response,
        401,
        "Login link expired",
        `This login link is invalid, expired or already used. ${SIGN_IN}`,
      );
      return;
    }
    const session = issueSession(signingKey, at);
    response.writeHead(303, {
      location: safeNextPath(url.searchParams.get("next")),
      "set-cookie": `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
      "cache-control": "no-store",
    });
    response.end();
  };

  const listTenants = async (response: ServerResponse): Promise<void> => {
    try {
      const tenants = await admin.listTenants();
      const summaries: StudioTenantSummary[] = tenants.map((tenant) => ({
        id: tenant.id,
        name: tenant.name,
        state: tenant.state,
      }));
      json(response, 200, { tenants: summaries });
    } catch (error) {
      const detail =
        error instanceof AdminError
          ? error.message
          : "The Runtime Admin API is unavailable";
      fail(response, 502, detail);
    }
  };

  const createTenant = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const body = await readJsonBody(request);
    const raw =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as { name?: unknown }).name
        : undefined;
    const name = typeof raw === "string" ? raw.trim() : "";
    if (name === "" || name.length > TENANT_NAME_MAX)
      return fail(
        response,
        400,
        `Send JSON { "name": "…" } with a Tenant name of 1 to ${TENANT_NAME_MAX} characters.`,
      );
    try {
      // The application key it returns is dropped: Projects derive theirs.
      const { tenant } = await admin.createTenant({
        name,
        principals: [PROJECT_PRINCIPAL_ID],
      });
      const summary: StudioTenantSummary = {
        id: tenant.id,
        name: tenant.name,
        state: "open",
      };
      json(response, 201, { tenant: summary });
    } catch (error) {
      fail(
        response,
        502,
        error instanceof AdminError
          ? error.message
          : "The Runtime Admin API is unavailable",
      );
    }
  };

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("x-frame-options", "DENY");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("cross-origin-resource-policy", "same-origin");
    const method = (request.method ?? "GET").toUpperCase();
    const host = (request.headers.host ?? "").toLowerCase();
    const url = new URL(request.url ?? "/", "http://studio.invalid");
    const pathname = url.pathname;

    if (pathname === "/healthz") {
      // Container-internal names (compose service, container id) reach the
      // listen port; `/healthz` carries no data and sets no cookie.
      if (!publicHosts.has(host) && hostPort(host) !== String(boundPort)) {
        request.resume();
        return fail(response, 421, "Studio does not serve this Host.");
      }
      request.resume();
      if (!SAFE_METHODS.has(method))
        return fail(response, 405, "Method not allowed");
      return json(response, 200, { status: "ok" }, method);
    }

    if (!publicHosts.has(host)) {
      request.resume();
      return fail(
        response,
        421,
        `Studio only serves http://localhost:${publicPort} and http://127.0.0.1:${publicPort}.`,
      );
    }
    const origin = `http://${host}`;

    if (!SAFE_METHODS.has(method)) {
      const requestOrigin = request.headers.origin;
      if (requestOrigin !== undefined && requestOrigin !== origin) {
        request.resume();
        return fail(response, 403, "Cross-origin requests are not allowed.");
      }
      // Minting is authorized by the admin key; the CLI sends no Origin.
      if (pathname === "/_studio/login-tokens" && method === "POST")
        return mintLoginToken(request, response);
      if (requestOrigin === undefined) {
        request.resume();
        return fail(
          response,
          403,
          "Requests that change state need a same-origin Origin header.",
        );
      }
    }

    if (pathname === "/login") {
      request.resume();
      if (method !== "GET") return fail(response, 405, "Method not allowed");
      return login(url, response);
    }
    if (pathname === "/_studio/login-tokens") {
      request.resume();
      return fail(response, 405, "Method not allowed");
    }

    if (!hasSession(request)) {
      request.resume();
      if (pathname.startsWith("/_studio/"))
        return fail(
          response,
          401,
          "Studio session required. Run npx nylorun studio to sign in.",
        );
      return page(response, 401, "Sign in to Studio", SIGN_IN, method);
    }

    if (pathname === "/_studio/hello") {
      request.resume();
      if (!SAFE_METHODS.has(method))
        return fail(response, 405, "Method not allowed");
      const hello: StudioServerHello = {
        version: STUDIO_VERSION,
        runtime: await probeRuntimeCompatibility(runtimeUrl),
      };
      return json(response, 200, hello, method);
    }

    if (pathname === "/_studio/tenants") {
      if (method === "POST") return createTenant(request, response);
      request.resume();
      if (method !== "GET") return fail(response, 405, "Method not allowed");
      return listTenants(response);
    }

    const tenantRoute = TENANT_RUNTIME.exec(pathname);
    if (tenantRoute) {
      const segment = tenantRoute[1]!;
      let tenantId: string;
      try {
        tenantId = decodeURIComponent(segment);
      } catch {
        tenantId = "";
      }
      if (!TENANT_ID.test(tenantId)) {
        request.resume();
        return fail(response, 404, "Unknown Tenant");
      }
      return proxyRuntime(request, response, {
        origin,
        runtimeUrl,
        serverKey: studioKey(tenantId),
        tenantId,
        prefix: `/_studio/tenants/${segment}/runtime`,
        allowedOrigins: new Set([origin]),
      });
    }

    if (pathname.startsWith("/_studio/")) {
      request.resume();
      return fail(response, 404, "Unknown Studio route");
    }

    request.resume();
    if (!SAFE_METHODS.has(method))
      return fail(response, 405, "Studio only serves static assets here.");
    await serveDashboard(response, method, pathname, webRoot, (status, message) =>
      fail(response, status, message),
    );
  };

  const server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) fail(response, 500, "Studio request failed");
      else response.end();
    });
  });
  await new Promise<void>((ready, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(options.port ?? 3000, options.host ?? "127.0.0.1", () => {
      server.off("error", rejectListen);
      ready();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Studio did not report a TCP address.");
  }
  boundPort = address.port;
  publicPort = options.publicPort ?? boundPort;
  publicHosts = new Set([`localhost:${publicPort}`, `127.0.0.1:${publicPort}`]);

  return Object.freeze({
    port: boundPort,
    publicPort,
    url: `http://localhost:${publicPort}`,
    close: () =>
      new Promise<void>((done, rejectClose) => {
        server.closeAllConnections();
        server.close((error) =>
          error === undefined ? done() : rejectClose(error),
        );
      }),
  });
}
