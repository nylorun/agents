/**
 * The Studio server that runs in the `studio` container of a Tenant's Compose project:
 * the dashboard and the trusted proxy on one origin, behind a cookie session.
 *
 * - The CLI mints a single-use login token with the admin key
 *   (`POST /_studio/login-tokens`) and opens `/login?token=…`, which sets an
 *   `HttpOnly`, `SameSite=Strict` session cookie for `SESSION_TTL_MS`. The
 *   cookie is signed with a key derived from the admin key, so it survives
 *   Studio restarts and ends when the admin key changes (`nylorun reset`).
 * - An embedder (Studio §8) mints a login token limited to one Tenant and one
 *   subject, passes it to the framed dashboard, which exchanges it at
 *   `POST /_studio/sessions` for a one-hour bearer session kept in memory. A
 *   session limited to a Tenant reaches only that Tenant.
 * - Every `/_studio/*` request needs a session, cookie or bearer, except the
 *   two that create one. The dashboard's static files carry no data and are
 *   served without one; only `frameAncestors` may frame them.
 * - `Host` must be the published loopback address (DNS rebinding); requests
 *   that change state must carry this origin's `Origin`; no CORS headers.
 * - Studio serves its installation's one Tenant, which it learns from the
 *   Admin API (`admin.status().tenant`): `/` redirects to `/tenants/<id>`, and
 *   a route or login token naming another Tenant is refused. Tenant API calls
 *   use the Tenant's Studio key, derived from the admin key in memory. No key
 *   ever reaches the browser.
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
  createAdmin,
  deriveStudioToken,
  type HostTenant,
} from "@nylorun/admin";
import {
  StudioLoginTokenRequestSchema,
  StudioSessionRequestSchema,
  type StudioLoginTokenResponse,
  type StudioSessionResponse,
} from "@nylorun/agents/studio-embed";
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
/** How long an embedded Studio's bearer session lasts: one hour (Studio §8.4). */
export const EMBED_SESSION_TTL_MS = 60 * 60 * 1000;
const EMBED_SESSION_VERSION = "v2";
const EMBED_AUDIENCE = "studio";

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
  /**
   * Exact origins that may frame the dashboard (`NYLORUN_STUDIO_FRAME_ANCESTORS`,
   * validated with `parseFrameAncestors`). Default: none.
   */
  frameAncestors?: readonly string[];
  /**
   * The Google Analytics measurement id the dashboard reports page views to
   * (`NYLORUN_STUDIO_ANALYTICS_ID`, validated with `parseAnalyticsId`). `nylorun start`
   * sets it unless the developer opted out. Default: none, and the dashboard
   * loads no analytics.
   */
  analyticsId?: string;
  /** Where Studio logs state changes made by an embedded session. Default: stdout. */
  log?: (entry: Readonly<Record<string, unknown>>) => void;
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

/** The installation's one Tenant, as `/_studio/hello` reports it. */
export type StudioTenantSummary = Readonly<{
  /** Null until Studio has read it: the Host cannot read its Tenant, or the Admin API is unreachable. */
  id: string | null;
  name: string | null;
  state: "open" | "unavailable";
  /** Why it is unavailable and how to repair it. */
  message?: string;
}>;

export type StudioServerHello = Readonly<{
  version: string;
  runtime: RuntimeCompatibility;
  tenant: StudioTenantSummary;
}>;

const SAFE_METHODS = new Set(["GET", "HEAD"]);
const MAX_JSON_BODY = 4096;
const TENANT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TENANT_RUNTIME = /^\/_studio\/tenants\/([^/]+)\/runtime(\/.*)$/;

const ANALYTICS_ID = /^G-[A-Z0-9]{4,20}$/;

/** Validates `NYLORUN_STUDIO_ANALYTICS_ID`: empty (none) or a Google Analytics 4 measurement id. */
export function parseAnalyticsId(value: string): string | undefined {
  const id = value.trim();
  if (id === "") return undefined;
  if (!ANALYTICS_ID.test(id))
    throw new Error(`${id} is not a Google Analytics measurement id (G-XXXXXXXXXX).`);
  return id;
}

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

/** Who a request acts as: the whole Host (cookie, or a Host-wide token) or one Tenant. */
type StudioSession = Readonly<{
  kind: "cookie" | "bearer";
  tenant: string | null;
  subject: string | null;
}>;

type EmbedClaims = Readonly<{
  aud: string;
  tenant: string | null;
  sub: string | null;
  iat: number;
  exp: number;
}>;

/** A bearer session: `v2.<base64url(claims)>.<signature>` (Studio §8.4). */
function issueEmbedSession(key: Buffer, claims: EmbedClaims): string {
  const payload = `${EMBED_SESSION_VERSION}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  return `${payload}.${sign(key, payload)}`;
}

function embedSession(key: Buffer, value: string, at: number): EmbedClaims | undefined {
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== EMBED_SESSION_VERSION) return undefined;
  const expected = Buffer.from(sign(key, `${parts[0]}.${parts[1]}`));
  const provided = Buffer.from(parts[2]!);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected))
    return undefined;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!claims || typeof claims !== "object") return undefined;
  const { aud, tenant, sub, iat, exp } = claims as Record<string, unknown>;
  if (aud !== EMBED_AUDIENCE) return undefined;
  if (tenant !== null && (typeof tenant !== "string" || !TENANT_ID.test(tenant)))
    return undefined;
  if (sub !== null && typeof sub !== "string") return undefined;
  if (typeof iat !== "number" || typeof exp !== "number") return undefined;
  if (iat > at + SESSION_SKEW_MS || exp <= at) return undefined;
  if (exp - iat > EMBED_SESSION_TTL_MS) return undefined;
  return { aud, tenant, sub, iat, exp };
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

const INVALID_BODY = Symbol("invalid body");

/**
 * A JSON body when the request declares one: undefined for no body or a
 * non-JSON content type, `INVALID_BODY` for malformed or oversized JSON.
 */
async function readOptionalJson(
  request: IncomingMessage,
): Promise<unknown | typeof INVALID_BODY> {
  const type = request.headers["content-type"] ?? "";
  if (!/^application\/json(;|$)/iu.test(type)) {
    request.resume();
    return undefined;
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_JSON_BODY) return INVALID_BODY;
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return INVALID_BODY;
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

/** Why the Host's Tenant is not open, with the repair the Host names. */
function unavailableMessage(tenant: HostTenant): string {
  if (tenant.cause === undefined)
    return "The Runtime has not opened its Tenant yet. Try again in a moment.";
  return `${tenant.cause.message} ${tenant.cause.repair} (${tenant.cause.code})`;
}

/** Starts the Studio server. The container entry is `server-main.ts`. */
/** `frame-ancestors` sources for the allowlist; `'none'` when it is empty. */
function frameAncestorSources(origins: readonly string[]): string {
  return origins.length === 0 ? "'none'" : origins.join(" ");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Adds the frame allowlist to `index.html`, so the embed bridge knows its
 * parents (§8.8), and the analytics measurement id when there is one.
 */
function injectIndexMeta(
  html: string,
  origins: readonly string[],
  analyticsId: string | undefined,
): string {
  let meta = `<meta name="nylorun-frame-ancestors" content="${escapeHtml(origins.join(" "))}">`;
  if (analyticsId !== undefined)
    meta += `<meta name="nylorun-analytics" content="${escapeHtml(analyticsId)}">`;
  return html.includes("</head>")
    ? html.replace("</head>", `${meta}</head>`)
    : `${meta}${html}`;
}

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
  const frameAncestors = [...(options.frameAncestors ?? [])];
  const analyticsId = parseAnalyticsId(options.analyticsId ?? "");
  const dashboard = {
    frameAncestors: frameAncestorSources(frameAncestors),
    transformIndex: (html: string) => injectIndexMeta(html, frameAncestors, analyticsId),
  };
  const log =
    options.log ??
    ((entry: Readonly<Record<string, unknown>>) =>
      console.log(JSON.stringify(entry)));

  /** Login token → expiry (ms) and what it is limited to. Single use. */
  const loginTokens = new Map<
    string,
    Readonly<{ expiresAt: number; tenant: string | null; subject: string | null }>
  >();
  /**
   * The Host's Tenant id, once Studio has read it: an installation's Tenant
   * keeps its id. A failure to read it is not remembered, so a later request
   * asks the Admin API again.
   */
  let knownTenantId: string | undefined;
  /** The Tenant's derived Studio key, in memory only. */
  let studioKeyMemo: Readonly<{ tenantId: string; key: string }> | undefined;

  let boundPort = 0;
  let publicPort = 0;
  let publicHosts: ReadonlySet<string> = new Set();

  const studioKey = (tenantId: string): string => {
    if (studioKeyMemo?.tenantId !== tenantId)
      studioKeyMemo = { tenantId, key: deriveStudioToken(adminKey, tenantId) };
    return studioKeyMemo.key;
  };

  /** The Host's one Tenant, read from the Admin API (`admin.status().tenant`). */
  const hostTenant = async (): Promise<StudioTenantSummary> => {
    try {
      const { tenant } = await admin.status();
      if (tenant.id !== null) knownTenantId = tenant.id;
      return tenant.state === "open" && tenant.id !== null
        ? { id: tenant.id, name: tenant.name, state: "open" }
        : {
            id: tenant.id,
            name: tenant.name,
            state: "unavailable",
            message: unavailableMessage(tenant),
          };
    } catch (error) {
      return {
        id: knownTenantId ?? null,
        name: null,
        state: "unavailable",
        message:
          error instanceof AdminError
            ? `The Runtime Admin API is unavailable: ${error.message}`
            : "The Runtime Admin API is unavailable.",
      };
    }
  };

  /** The Tenant id routes and login tokens must name: remembered, or read now. */
  const tenantIdOrCause = async (): Promise<
    Readonly<{ id: string } | { id: null; message: string }>
  > => {
    if (knownTenantId !== undefined) return { id: knownTenantId };
    const tenant = await hostTenant();
    return tenant.id !== null
      ? { id: tenant.id }
      : { id: null, message: tenant.message ?? "The Tenant is unavailable." };
  };

  /**
   * `GET /`: the dashboard of the installation's one Tenant. Like the
   * dashboard's files it needs no session; the Tenant id is not a secret.
   */
  const redirectToTenant = async (
    url: URL,
    response: ServerResponse,
    method: string,
  ): Promise<void> => {
    const tenant = await hostTenant();
    if (tenant.state !== "open" || tenant.id === null) {
      page(
        response,
        503,
        "Tenant unavailable",
        `${escapeHtml(tenant.message ?? "The Tenant is unavailable.")} Reload this page to try again; <code>npx nylorun status</code> reports the Tenant.`,
        method,
      );
      return;
    }
    // Framed like the dashboard it leads to (Studio §8.9).
    response.removeHeader("x-frame-options");
    response.writeHead(302, {
      location: `/tenants/${encodeURIComponent(tenant.id)}${url.search}`,
      "cache-control": "no-store",
      "content-security-policy": `frame-ancestors ${dashboard.frameAncestors}`,
    });
    response.end();
  };

  /**
   * The request's session. A bearer is checked first and never falls back to
   * the cookie: a framed Studio with a bad token must not act Host-wide.
   */
  const sessionOf = (request: IncomingMessage): StudioSession | undefined => {
    const at = now();
    if (request.headers.authorization !== undefined) {
      const token = bearer(request);
      const claims = token === undefined ? undefined : embedSession(signingKey, token, at);
      return claims
        ? { kind: "bearer", tenant: claims.tenant, subject: claims.sub }
        : undefined;
    }
    return cookieValues(request, SESSION_COOKIE).some((value) =>
      validSession(signingKey, value, at),
    )
      ? { kind: "cookie", tenant: null, subject: null }
      : undefined;
  };

  /** Takes a login token out of the map: single use, even when it has expired. */
  const takeLoginToken = (token: string) => {
    const entry = loginTokens.get(token);
    loginTokens.delete(token);
    return entry !== undefined && entry.expiresAt > now() ? entry : undefined;
  };

  const mintLoginToken = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const provided = bearer(request);
    if (
      provided === undefined ||
      !timingSafeEqual(digest(provided), adminKeyDigest)
    ) {
      request.resume();
      response.setHeader("www-authenticate", "Bearer");
      fail(response, 401, "The admin key is required to mint a login token.");
      return;
    }
    // No body, or a body that is not JSON, is the CLI's Host-wide token.
    const body = await readOptionalJson(request);
    if (body === INVALID_BODY)
      return fail(response, 400, "Send a JSON object no larger than 4 KiB.");
    const parsed = StudioLoginTokenRequestSchema.safeParse(body ?? {});
    if (!parsed.success)
      return fail(
        response,
        400,
        `Send JSON { "tenant"?: "<Tenant id>", "subject"?: "<1–200 visible ASCII characters>" }: ${parsed.error.issues[0]?.message ?? "invalid"}.`,
      );
    const tenant = parsed.data.tenant ?? null;
    // The embed contract keeps the `tenant` claim; it must name this
    // installation's Tenant.
    if (tenant !== null) {
      const host = await tenantIdOrCause();
      if (host.id === null)
        return fail(
          response,
          503,
          `Studio cannot read this installation's Tenant: ${host.message}`,
        );
      if (tenant !== host.id)
        return fail(
          response,
          404,
          `Unknown Tenant: this Studio serves only Tenant ${host.id}.`,
        );
    }
    const at = now();
    for (const [token, entry] of loginTokens)
      if (entry.expiresAt <= at) loginTokens.delete(token);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = at + LOGIN_TOKEN_TTL_MS;
    const subject = parsed.data.subject ?? null;
    loginTokens.set(token, { expiresAt, tenant, subject });
    const reply: StudioLoginTokenResponse = {
      token,
      url: `http://localhost:${publicPort}/login?token=${token}`,
      expiresAt: new Date(expiresAt).toISOString(),
      tenant,
      subject,
    };
    json(response, 201, reply);
  };

  /** `POST /_studio/sessions`: a login token becomes a bearer session (Studio §8.4). */
  const createSession = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const body = await readOptionalJson(request);
    const parsed = StudioSessionRequestSchema.safeParse(
      body === INVALID_BODY ? undefined : body,
    );
    if (!parsed.success)
      return fail(response, 400, 'Send JSON { "token": "<login token>" }.');
    const entry = takeLoginToken(parsed.data.token);
    if (entry === undefined)
      return json(response, 401, {
        code: "token_invalid",
        message: "This login token is invalid, expired or already used.",
      });
    const at = now();
    const exp = at + EMBED_SESSION_TTL_MS;
    const reply: StudioSessionResponse = {
      sessionToken: issueEmbedSession(signingKey, {
        aud: EMBED_AUDIENCE,
        tenant: entry.tenant,
        sub: entry.subject,
        iat: at,
        exp,
      }),
      tenant: entry.tenant,
      subject: entry.subject,
      expiresAt: new Date(exp).toISOString(),
    };
    json(response, 201, reply);
  };

  const login = (url: URL, response: ServerResponse): void => {
    const entry = takeLoginToken(url.searchParams.get("token") ?? "");
    const at = now();
    // A token limited to a Tenant never becomes a Host-wide cookie.
    if (entry === undefined || entry.tenant !== null) {
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
        return await mintLoginToken(request, response);
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
    if (pathname === "/_studio/sessions") {
      if (method !== "POST") {
        request.resume();
        return fail(response, 405, "Method not allowed");
      }
      return await createSession(request, response);
    }

    if (pathname === "/") {
      request.resume();
      if (!SAFE_METHODS.has(method))
        return fail(response, 405, "Studio only serves static assets here.");
      return await redirectToTenant(url, response, method);
    }

    // The dashboard's files carry no data: served without a session, framed
    // only by the allowlist. Its sign-in page is part of the dashboard.
    if (!pathname.startsWith("/_studio/")) {
      request.resume();
      if (!SAFE_METHODS.has(method))
        return fail(response, 405, "Studio only serves static assets here.");
      return await serveDashboard(
        response,
        method,
        pathname,
        webRoot,
        (status, message) => {
          response.setHeader("x-frame-options", "DENY");
          fail(response, status, message);
        },
        dashboard,
      );
    }

    const session = sessionOf(request);
    if (session === undefined) {
      request.resume();
      if (request.headers.authorization !== undefined)
        response.setHeader("www-authenticate", 'Bearer error="invalid_token"');
      return fail(
        response,
        401,
        "Studio session required. Run npx nylorun studio to sign in.",
      );
    }

    if (pathname === "/_studio/hello") {
      request.resume();
      if (!SAFE_METHODS.has(method))
        return fail(response, 405, "Method not allowed");
      const [runtime, tenant] = await Promise.all([
        probeRuntimeCompatibility(runtimeUrl),
        hostTenant(),
      ]);
      const hello: StudioServerHello = { version: STUDIO_VERSION, runtime, tenant };
      return json(response, 200, hello, method);
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
      const host = await tenantIdOrCause();
      if (host.id === null) {
        request.resume();
        return fail(response, 503, host.message);
      }
      // Another Tenant, and a session limited to another Tenant, get the same
      // answer as a Tenant that does not exist.
      if (
        tenantId !== host.id ||
        (session.tenant !== null && session.tenant !== tenantId)
      ) {
        request.resume();
        return fail(response, 404, "Unknown Tenant");
      }
      if (session.kind === "bearer" && !SAFE_METHODS.has(method)) {
        const path = pathname.slice(`/_studio/tenants/${segment}/runtime`.length);
        response.once("finish", () =>
          log({
            msg: "studio proxy",
            subject: session.subject,
            tenant: tenantId,
            method,
            path,
            status: response.statusCode,
          }),
        );
      }
      return proxyRuntime(request, response, {
        origin,
        runtimeUrl,
        serverKey: studioKey(tenantId),
        prefix: `/_studio/tenants/${segment}/runtime`,
        allowedOrigins: new Set([origin]),
      });
    }

    request.resume();
    return fail(response, 404, "Unknown Studio route");
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
