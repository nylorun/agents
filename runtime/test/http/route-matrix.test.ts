/**
 * Characterization of the Runtime's HTTP surface: every operation, as every kind of caller,
 * pinned to a committed fixture. The fixture records what a client can observe (status, error
 * code, message, details and the headers clients act on), never bodies of successful answers.
 *
 * The Hono migration must leave this fixture unchanged until its cutover, which changes only the
 * cells its changeset lists. Requests never mutate state the matrix reads: writes carry a body
 * that fails validation, deletes name resources that do not exist.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import {
  startEphemeralRuntime,
  type EphemeralRuntime,
} from "../../src/tenant/ephemeral.js";
import { testIssuer, type TestIssuer } from "../support/issuer.js";
import { testPool } from "../support/store.js";

const TENANT = `tn_${"0".repeat(22)}mtrx`;
const APPLICATION_KEY = "matrix-application-key-0000000000";
const MANAGEMENT_KEY = "matrix-management-key-00000000000";
const ADMIN_KEY = "matrix-admin-key-00000000000000000";
const ORIGIN = "https://app.example.com";
const SUBJECT = "app:ann";
/**
 * Older clients still send the retired `vaults:own` (protocol 6) and `tenant:settings`
 * (protocol 7); they grant nothing.
 */
const ALL_SCOPES = "agents:read agents:write sessions:own vaults:own tenant:settings";
/** A body every schema rejects, so a write that gets past authorization changes nothing. */
const INVALID = [] as const;
/** An artifact id that never exists. */
const MISSING_ARTIFACT = `af_${"0".repeat(26)}`;

let root: string;
let rt: EphemeralRuntime;
let issuer: TestIssuer;
let issuerToken: string;
let vaultId: string;
const secrets: [string, string][] = [];

type Caller =
  | "none"
  | "wrong"
  | "application"
  | "application-browser"
  | "subject"
  | "subject-read"
  | "token"
  | "token-browser"
  | "management"
  | "management-subject";
const CALLERS: readonly Caller[] = [
  "none",
  "wrong",
  "application",
  "application-browser",
  "subject",
  "subject-read",
  "token",
  "token-browser",
  "management",
  "management-subject",
];

function callerHeaders(caller: Caller): Record<string, string> {
  // Protocol 5: nothing names the Tenant.
  const base = { "nylorun-protocol": "5" };
  const bearer = (key: string) => ({ ...base, authorization: `Bearer ${key}` });
  switch (caller) {
    case "none":
      return base;
    case "wrong":
      return bearer("matrix-wrong-key-000000000000000000");
    case "application":
      return bearer(APPLICATION_KEY);
    case "application-browser":
      // An application key is a server secret: refused from a browser.
      return { ...bearer(APPLICATION_KEY), origin: ORIGIN };
    case "subject":
      return {
        ...bearer(APPLICATION_KEY),
        "nylorun-subject": SUBJECT,
        "nylorun-scopes": ALL_SCOPES,
      };
    case "subject-read":
      return {
        ...bearer(APPLICATION_KEY),
        "nylorun-subject": SUBJECT,
        "nylorun-scopes": "agents:read",
      };
    case "token":
      // A trusted issuer's token (F9 I2).
      return bearer(issuerToken);
    case "token-browser":
      // The same token from a browser page: no toggle, no browser key (protocol 7).
      return { ...bearer(issuerToken), origin: ORIGIN };
    case "management":
      // The Management API's key (protocol 8): `/v1/tenant/*` and `/v1/me` only.
      return bearer(MANAGEMENT_KEY);
    case "management-subject":
      // A management key acts as itself, never for a subject.
      return {
        ...bearer(MANAGEMENT_KEY),
        "nylorun-subject": SUBJECT,
        "nylorun-scopes": ALL_SCOPES,
      };
  }
}

interface Observed {
  status: number;
  contentType?: string;
  code?: string;
  message?: string;
  details?: unknown;
  protocol?: unknown;
  allowOrigin?: string;
  wwwAuthenticate?: string;
  retryAfter?: string;
}

/** Replace values that differ per run (keys, ids) with stable names. */
function stable<T>(value: T): T {
  let text = JSON.stringify(value);
  for (const [secret, name] of secrets) text = text.split(secret).join(name);
  return JSON.parse(text) as T;
}

async function observe(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: unknown; stream?: boolean },
): Promise<Observed> {
  const aborter = new AbortController();
  const headers = { ...init.headers };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(url, {
    method: init.method,
    headers,
    signal: aborter.signal,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const observed: Observed = { status: response.status };
  const contentType = response.headers.get("content-type");
  if (contentType) observed.contentType = contentType;
  const allowOrigin = response.headers.get("access-control-allow-origin");
  if (allowOrigin) observed.allowOrigin = allowOrigin;
  const wwwAuthenticate = response.headers.get("www-authenticate");
  if (wwwAuthenticate) observed.wwwAuthenticate = wwwAuthenticate;
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) observed.retryAfter = retryAfter;
  if (contentType?.startsWith("text/event-stream")) {
    aborter.abort();
    return observed;
  }
  const text = await response.text();
  if (response.status >= 400 && text) {
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      if (typeof body.code === "string") observed.code = body.code;
      if (typeof body.message === "string") observed.message = body.message;
      if (body.details !== undefined) observed.details = body.details;
      if (body.protocol !== undefined) observed.protocol = body.protocol;
    } catch {
      observed.message = text;
    }
  }
  return observed;
}

interface Operation {
  method: string;
  path: string;
  body?: unknown;
}

/** Every Tenant operation, with ids that exist (`s1`, `bot`, the vault) or never will. */
function tenantOperations(): Operation[] {
  const vault = `/v1/tenant/vaults/${vaultId}`;
  return [
    { method: "POST", path: "/v1/actions/act-missing/sandbox/bash", body: INVALID },
    { method: "POST", path: "/v1/actions/act-missing/heartbeat", body: INVALID },
    { method: "GET", path: "/v1/endpoints" },
    { method: "PUT", path: "/v1/endpoints", body: INVALID },
    { method: "DELETE", path: "/v1/endpoints/ghost" },
    { method: "POST", path: "/v1/endpoints/ghost/ping" },
    { method: "POST", path: "/v1/actions/act-missing/result", body: INVALID },
    { method: "POST", path: "/v1/sessions/s1/commands", body: INVALID },
    { method: "GET", path: "/v1/agents" },
    { method: "PUT", path: "/v1/agents/bot", body: INVALID },
    { method: "GET", path: "/v1/sessions" },
    { method: "PUT", path: "/v1/sessions/s2", body: INVALID },
    { method: "GET", path: "/v1/sessions/s1" },
    { method: "GET", path: "/v1/sessions/missing" },
    { method: "GET", path: "/v1/sessions/s1/items" },
    { method: "GET", path: "/v1/sessions/s1/events" },
    { method: "POST", path: "/v1/sessions/s1/sandbox/bash", body: INVALID },
    { method: "GET", path: "/v1/sandboxes" },
    { method: "GET", path: "/v1/sandboxes?label=project=acme" },
    { method: "PUT", path: "/v1/sandboxes/team%2Fsbx-missing", body: INVALID },
    { method: "GET", path: "/v1/sandboxes/team%2Fsbx-missing" },
    { method: "GET", path: "/v1/sandboxes/team%2Fsbx-missing/events" },
    { method: "DELETE", path: "/v1/sandboxes/team%2Fsbx-missing" },
    // File artifacts (protocol 6): an empty name fails validation, so nothing is stored.
    { method: "POST", path: "/v1/artifacts?name=&sessionId=s1", body: INVALID },
    { method: "POST", path: `/v1/artifacts/${MISSING_ARTIFACT}/versions`, body: INVALID },
    { method: "GET", path: "/v1/artifacts" },
    { method: "GET", path: "/v1/artifacts?sessionId=s1" },
    { method: "GET", path: `/v1/artifacts/${MISSING_ARTIFACT}` },
    { method: "GET", path: `/v1/artifacts/${MISSING_ARTIFACT}/versions/latest/content` },
    // Folder artifacts (F8.2).
    { method: "GET", path: `/v1/artifacts/${MISSING_ARTIFACT}/versions/latest/tree` },
    { method: "GET", path: `/v1/artifacts/${MISSING_ARTIFACT}/versions/1/files/app%2Findex.html` },
    { method: "GET", path: `/v1/artifacts/${MISSING_ARTIFACT}/versions/2/diff?from=1` },
    { method: "GET", path: `/v1/artifacts/${MISSING_ARTIFACT}/versions/latest/zip` },
    { method: "POST", path: `/v1/artifacts/${MISSING_ARTIFACT}/links`, body: INVALID },
    { method: "DELETE", path: `/v1/artifacts/${MISSING_ARTIFACT}` },
    { method: "GET", path: "/v1/artifact-links/not-a-token" },
    { method: "GET", path: "/v1/tenant/artifacts" },
    { method: "PUT", path: "/v1/tenant/artifacts", body: INVALID },
    { method: "GET", path: "/v1/tenant" },
    { method: "POST", path: "/v1/tenant/reset", body: INVALID },
    { method: "PUT", path: "/v1/tenant/config/seed", body: INVALID },
    { method: "GET", path: "/v1/tenant/models" },
    { method: "GET", path: "/v1/tenant/sandbox" },
    { method: "PUT", path: "/v1/tenant/sandbox", body: INVALID },
    { method: "GET", path: "/v1/tenant/providers" },
    { method: "GET", path: "/v1/tenant/usage?scope=agent&id=bot&period=month" },
    { method: "GET", path: "/v1/tenant/budgets" },
    { method: "PUT", path: "/v1/tenant/budgets", body: INVALID },
    { method: "GET", path: "/v1/tenant/model" },
    { method: "PUT", path: "/v1/tenant/model", body: INVALID },
    { method: "PUT", path: "/v1/tenant/model/selection", body: INVALID },
    { method: "POST", path: "/v1/tenant/vaults", body: INVALID },
    { method: "GET", path: `/v1/tenant/vaults?ownerUserId=${SUBJECT}` },
    { method: "GET", path: vault },
    { method: "DELETE", path: "/v1/tenant/vaults/vlt-missing" },
    { method: "POST", path: `${vault}/credentials`, body: INVALID },
    { method: "GET", path: `${vault}/credentials` },
    { method: "GET", path: `${vault}/credentials/crd-missing` },
    { method: "POST", path: `${vault}/credentials/crd-missing`, body: INVALID },
    { method: "DELETE", path: `${vault}/credentials/crd-missing` },
    // MCP OAuth connect (F9 C2): an invalid body, and a state that was never issued.
    { method: "POST", path: `${vault}/oauth/start`, body: INVALID },
    { method: "GET", path: "/v1/oauth/callback?state=matrix-state&code=matrix-code" },
    { method: "GET", path: "/v1/access/jwks" },
    { method: "GET", path: "/v1/me" },
    { method: "GET", path: "/v1/tenant/signing-keys" },
    { method: "POST", path: "/v1/tenant/signing-keys/rotate", body: INVALID },
    { method: "POST", path: "/v1/tenant/signing-keys/kid-missing/revoke", body: INVALID },
    { method: "POST", path: "/v1/ag-ui/agents/bot", body: INVALID },
    { method: "GET", path: "/v1/ag-ui/agents/bot/threads/t1/messages" },
    { method: "GET", path: "/v1/ag-ui/agents/bot/threads/t1/events" },
    { method: "POST", path: "/v1/ag-ui/agents/bot/threads/t1/cancel" },
    { method: "POST", path: "/v1/a2a/agents/bot", body: INVALID },
    { method: "GET", path: "/v1/a2a/agents/bot/card" },
  ];
}

/** Paths the router accepts today only because a length guard is missing, and odd shapes. */
function edgeOperations(): Operation[] {
  return [
    { method: "POST", path: "/v1/sessions/s1/commands/x", body: INVALID },
    { method: "GET", path: "/v1/sessions/s1/items/x" },
    { method: "GET", path: "/v1/sessions/s1/events/x" },
    { method: "GET", path: "/v1/actions/act-missing" },
    // The executor routes (Action endpoints replaced them) are gone.
    { method: "GET", path: "/v1/executors" },
    { method: "GET", path: "/v1/executors/connect" },
    { method: "GET", path: "/v1/actions" },
    { method: "POST", path: "/v1/actions/act-missing/claim", body: INVALID },
    // Subject tokens, the access policy, browser keys and revocations (protocol 7): gone.
    { method: "POST", path: "/v1/tokens", body: INVALID },
    { method: "GET", path: "/v1/access/policy" },
    { method: "PUT", path: "/v1/access/policy", body: INVALID },
    { method: "GET", path: "/v1/access/publishable-keys" },
    { method: "POST", path: "/v1/access/publishable-keys", body: INVALID },
    { method: "PUT", path: "/v1/access/publishable-keys/pk-missing", body: INVALID },
    { method: "DELETE", path: "/v1/access/publishable-keys/pk-missing" },
    { method: "POST", path: "/v1/access/revocations", body: INVALID },
    // Vaults and signing keys outside the Management API (protocol 8): gone.
    { method: "POST", path: "/v1/vaults", body: INVALID },
    { method: "GET", path: `/v1/vaults?ownerUserId=${SUBJECT}` },
    { method: "GET", path: "/v1/vaults/vlt-missing" },
    { method: "DELETE", path: "/v1/vaults/vlt-missing" },
    { method: "POST", path: "/v1/vaults/vlt-missing/oauth/start", body: INVALID },
    { method: "GET", path: "/v1/access/signing-keys" },
    { method: "POST", path: "/v1/access/signing-keys/rotate", body: INVALID },
    { method: "GET", path: "/v1/sessions/missing/unknown" },
    { method: "GET", path: "/v1/sessions/" },
    { method: "GET", path: "/v1//sessions" },
    { method: "GET", path: "/v1/agents/" },
    { method: "GET", path: "/v1/sessions/s%2F1" },
    { method: "GET", path: "/v1/sessions/%E2%9C%93" },
    { method: "GET", path: "/v1/sessions/%E0%A4%A" },
    { method: "GET", path: "/v1/nothing" },
    { method: "GET", path: "/v2/agents" },
    { method: "PATCH", path: "/v1/sessions/s1" },
    { method: "HEAD", path: "/v1/agents" },
    { method: "HEAD", path: "/v1/sessions/s1" },
    { method: "HEAD", path: "/v1/sessions/s1/events" },
    { method: "OPTIONS", path: "/v1/agents" },
  ];
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "nylorun-route-matrix-"));
  issuer = await testIssuer();
  rt = await startEphemeralRuntime({
    database: testPool(),
    hostRoot: root,
    tenantId: TENANT,
    applicationKey: APPLICATION_KEY,
    managementKey: MANAGEMENT_KEY,
    adminKey: ADMIN_KEY,
    operatorListener: true,
    issuers: issuer.configs,
    model: { kind: "fixture" },
  });
  const app = async (method: string, path: string, body: unknown) => {
    const caller = path.startsWith("/v1/tenant") ? "management" : "application";
    const response = await fetch(`${rt.url}${path}`, {
      method,
      headers: { ...callerHeaders(caller), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = (await response.json()) as Record<string, unknown>;
    expect(response.status, `${method} ${path}: ${JSON.stringify(parsed)}`).toBe(200);
    return parsed;
  };
  await app("PUT", "/v1/agents/bot", {
    requestId: "bot",
    manifest: Agent({ id: "bot", name: "Bot", description: "Helps" }).build().manifest,
    implementationVersion: "dev",
  });
  issuerToken = await issuer.sign(SUBJECT, "sessions:own agents:read", { ttlSeconds: 900 });
  await app("PUT", "/v1/sessions/s1", { requestId: "s1", agentId: "bot", ownerUserId: SUBJECT });
  vaultId = String(
    (await app("POST", "/v1/tenant/vaults", {
      requestId: "vault",
      idempotencyKey: "vault",
      name: "v",
      ownerUserId: SUBJECT,
    })).id,
  );
  secrets.push(
    [issuerToken, "<issuer-token>"],
    [vaultId, "<vault>"],
    [TENANT, "<tenant>"],
  );
});

afterAll(async () => {
  await rt?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

// Hundreds of requests each: more than the default 5 seconds on a busy machine.
describe("route matrix", { timeout: 60_000 }, () => {
  it("answers every Tenant operation, as every caller, as recorded", async () => {
    const matrix: Record<string, Record<string, Observed>> = {};
    for (const operation of [...tenantOperations(), ...edgeOperations()]) {
      const row: Record<string, Observed> = {};
      for (const caller of CALLERS)
        row[caller] = await observe(`${rt.url}${operation.path}`, {
          method: operation.method,
          headers: callerHeaders(caller),
          body: operation.body,
        });
      matrix[stable(`${operation.method} ${operation.path}`)] = stable(row);
    }
    await expect(`${JSON.stringify(matrix, null, 2)}\n`).toMatchFileSnapshot(
      "./__fixtures__/route-matrix.json",
    );
  });

  it("answers the Host and Admin operations on each listener, as recorded", async () => {
    const admin = (key: string) => ({ "nylorun-protocol": "5", authorization: `Bearer ${key}` });
    const callers: Record<string, Record<string, string>> = {
      none: {},
      "protocol-only": { "nylorun-protocol": "5" },
      "wrong-admin": admin("matrix-wrong-admin-key-000000000000"),
      admin: admin(ADMIN_KEY),
      application: callerHeaders("application"),
      "admin-with-origin": { ...admin(ADMIN_KEY), origin: ORIGIN },
    };
    const operations: Operation[] = [
      { method: "GET", path: "/health" },
      { method: "POST", path: "/health" },
      { method: "GET", path: "/ready" },
      // The Admin Tenant routes of protocol 4: gone.
      { method: "GET", path: "/v1/admin/tenants" },
      { method: "POST", path: "/v1/admin/tenants", body: INVALID },
      { method: "GET", path: `/v1/admin/tenants/${TENANT}` },
      { method: "GET", path: `/v1/admin/tenants/tn_${"0".repeat(22)}dead` },
      { method: "DELETE", path: `/v1/admin/tenants/tn_${"0".repeat(22)}dead` },
      { method: "GET", path: "/v1/admin/tenants/not-a-tenant" },
      { method: "DELETE", path: `/v1/admin/tenants/${TENANT}?activeWork=bogus` },
      { method: "GET", path: "/v1/admin/status" },
      { method: "GET", path: "/v1/admin/host" },
      { method: "GET", path: "/v1/admin/nothing" },
      { method: "GET", path: "/v1/admin/tenants/" },
      { method: "GET", path: "/v1//admin/tenants" },
      { method: "HEAD", path: "/v1/admin/status" },
      { method: "PUT", path: "/v1/admin/status" },
      // Operator keys (F9 I1): only refusals and misses, so nothing changes.
      { method: "GET", path: "/v1/admin/keys" },
      { method: "PUT", path: "/v1/admin/keys/studio" },
      { method: "PUT", path: "/v1/admin/keys/Not_A_Key" },
      { method: "DELETE", path: "/v1/admin/keys/studio" },
      { method: "DELETE", path: "/v1/admin/keys/missing-key" },
      { method: "POST", path: "/v1/admin/keys" },
    ];
    const matrix: Record<string, Record<string, Observed>> = {};
    for (const [listener, base] of [
      ["public", rt.url],
      ["operator", rt.adminUrl],
    ] as const)
      for (const operation of operations) {
        const row: Record<string, Observed> = {};
        for (const [name, headers] of Object.entries(callers)) {
          const observed = await observe(`${base}${operation.path}`, {
            method: operation.method,
            headers,
            body: operation.body,
          });
          // `/health` and `/ready` answer with live values; their status is what matters.
          row[name] = operation.path.startsWith("/v1/") ? observed : { status: observed.status };
        }
        matrix[stable(`${listener} ${operation.method} ${operation.path}`)] = stable(row);
      }
    await expect(`${JSON.stringify(matrix, null, 2)}\n`).toMatchFileSnapshot(
      "./__fixtures__/host-matrix.json",
    );
  });

  it("answers OPTIONS without CORS headers: the operator's proxy answers preflights", async () => {
    const preflights: Record<string, Observed & { allow?: string }> = {};
    const requests: [string, string, string?][] = [
      ...tenantOperations().map(({ method, path }): [string, string] => [method, path]),
      ["GET", "/v1/sessions/s1/unknown"],
      ["POST", "/v1/vaults/v1/unknown/deeper"],
      ["GET", "/v1/ag-ui/anything"],
      ["PATCH", "/v1/sessions/s1"],
      ["GET", "/v1/sessions", "authorization, x-evil"],
      ["GET", "/health"],
      ["GET", "/v1/admin/tenants"],
    ];
    for (const [method, path, requestHeaders] of requests) {
      const response = await fetch(`${rt.url}${path}`, {
        method: "OPTIONS",
        headers: {
          origin: ORIGIN,
          "access-control-request-method": method,
          "access-control-request-headers":
            requestHeaders ?? "authorization, content-type, nylorun-protocol",
        },
      });
      await response.arrayBuffer();
      const observed: Observed & { allow?: string } = { status: response.status };
      const allowOrigin = response.headers.get("access-control-allow-origin");
      if (allowOrigin) observed.allowOrigin = allowOrigin;
      const allow = response.headers.get("allow");
      if (allow) observed.allow = allow;
      preflights[stable(`${method} ${path}`)] = observed;
    }
    // Without `Origin` too: an OPTIONS request is never routed to the Tenant.
    const plain = await fetch(`${rt.url}/v1/agents`, { method: "OPTIONS" });
    await plain.arrayBuffer();
    preflights["no Origin: OPTIONS /v1/agents"] = {
      status: plain.status,
      ...(plain.headers.get("allow") ? { allow: plain.headers.get("allow")! } : {}),
    };
    await expect(`${JSON.stringify(preflights, null, 2)}\n`).toMatchFileSnapshot(
      "./__fixtures__/preflight-matrix.json",
    );
  });
});
