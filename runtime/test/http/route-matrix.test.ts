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

const TENANT = `tn_${"0".repeat(22)}mtrx`;
const APPLICATION_KEY = "matrix-application-key-0000000000";
const ADMIN_KEY = "matrix-admin-key-00000000000000000";
const EXECUTOR_TOKEN = "matrix-executor-token-000000000000";
const ORIGIN = "https://app.example.com";
const SUBJECT = "app:ann";
const ALL_SCOPES = "agents:read agents:write sessions:own vaults:own tenant:settings";
/** A body every schema rejects, so a write that gets past authorization changes nothing. */
const INVALID = [] as const;

let root: string;
let rt: EphemeralRuntime;
let publishableKey: string;
let subjectToken: string;
let vaultId: string;
const secrets: [string, string][] = [];

type Caller =
  | "none"
  | "wrong"
  | "application"
  | "subject"
  | "subject-read"
  | "token"
  | "publishable"
  | "executor";
const CALLERS: readonly Caller[] = [
  "none",
  "wrong",
  "application",
  "subject",
  "subject-read",
  "token",
  "publishable",
  "executor",
];

function callerHeaders(caller: Caller): Record<string, string> {
  const base = { "nylorun-protocol": "2", "nylorun-tenant": TENANT };
  const bearer = (key: string) => ({ ...base, authorization: `Bearer ${key}` });
  switch (caller) {
    case "none":
      return base;
    case "wrong":
      return bearer("matrix-wrong-key-000000000000000000");
    case "application":
      return bearer(APPLICATION_KEY);
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
      return bearer(subjectToken);
    case "publishable":
      // A browser page: the key names the Tenant.
      return { "nylorun-protocol": "2", "nylorun-key": publishableKey, origin: ORIGIN };
    case "executor":
      return bearer(EXECUTOR_TOKEN);
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
  const vault = `/v1/vaults/${vaultId}`;
  return [
    { method: "GET", path: "/v1/executors/connect" },
    { method: "GET", path: "/v1/actions" },
    { method: "POST", path: "/v1/actions/act-missing/sandbox/bash", body: INVALID },
    { method: "POST", path: "/v1/actions/act-missing/claim", body: INVALID },
    { method: "POST", path: "/v1/actions/act-missing/heartbeat", body: INVALID },
    { method: "GET", path: "/v1/executors" },
    { method: "PUT", path: "/v1/executors", body: INVALID },
    { method: "DELETE", path: "/v1/executors/ghost" },
    { method: "GET", path: "/v1/endpoints" },
    { method: "PUT", path: "/v1/endpoints", body: INVALID },
    { method: "DELETE", path: "/v1/endpoints/ghost" },
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
    { method: "GET", path: "/v1/tenant" },
    { method: "POST", path: "/v1/tenant/reset", body: INVALID },
    { method: "PUT", path: "/v1/tenant/config/seed", body: INVALID },
    { method: "GET", path: "/v1/tenant/models" },
    { method: "GET", path: "/v1/tenant/sandbox" },
    { method: "PUT", path: "/v1/tenant/sandbox", body: INVALID },
    { method: "GET", path: "/v1/tenant/providers" },
    { method: "GET", path: "/v1/tenant/model" },
    { method: "PUT", path: "/v1/tenant/model", body: INVALID },
    { method: "PUT", path: "/v1/tenant/model/selection", body: INVALID },
    { method: "POST", path: "/v1/vaults", body: INVALID },
    { method: "GET", path: `/v1/vaults?ownerUserId=${SUBJECT}` },
    { method: "GET", path: vault },
    { method: "DELETE", path: "/v1/vaults/vlt-missing" },
    { method: "POST", path: `${vault}/credentials`, body: INVALID },
    { method: "GET", path: `${vault}/credentials` },
    { method: "GET", path: `${vault}/credentials/crd-missing` },
    { method: "POST", path: `${vault}/credentials/crd-missing`, body: INVALID },
    { method: "DELETE", path: `${vault}/credentials/crd-missing` },
    { method: "GET", path: "/v1/access/jwks" },
    { method: "POST", path: "/v1/tokens", body: INVALID },
    { method: "GET", path: "/v1/access/policy" },
    { method: "PUT", path: "/v1/access/policy", body: INVALID },
    { method: "GET", path: "/v1/access/signing-keys" },
    { method: "POST", path: "/v1/access/signing-keys/rotate", body: INVALID },
    { method: "POST", path: "/v1/access/signing-keys/kid-missing/revoke", body: INVALID },
    { method: "GET", path: "/v1/access/publishable-keys" },
    { method: "POST", path: "/v1/access/publishable-keys", body: INVALID },
    { method: "PUT", path: "/v1/access/publishable-keys/pk-missing", body: INVALID },
    { method: "DELETE", path: "/v1/access/publishable-keys/pk-missing" },
    { method: "POST", path: "/v1/access/revocations", body: INVALID },
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
    { method: "GET", path: "/v1/executors/connect/x" },
    { method: "DELETE", path: "/v1/executors/connect" },
    { method: "GET", path: "/v1/sessions/s1/items/x" },
    { method: "GET", path: "/v1/sessions/s1/events/x" },
    { method: "POST", path: "/v1/actions/act-missing/claim/x", body: INVALID },
    { method: "GET", path: "/v1/actions/act-missing" },
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
  rt = await startEphemeralRuntime({
    hostRoot: root,
    tenantId: TENANT,
    applicationKey: APPLICATION_KEY,
    adminKey: ADMIN_KEY,
    browserAccess: true,
    operatorListener: true,
    model: { kind: "fixture" },
  });
  const app = async (method: string, path: string, body: unknown) => {
    const response = await fetch(`${rt.url}${path}`, {
      method,
      headers: { ...callerHeaders("application"), "content-type": "application/json" },
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
  await app("PUT", "/v1/access/policy", {
    requestId: "policy",
    policy: {
      version: 1,
      roles: {
        user: { scopes: ["sessions:own", "agents:read", "vaults:own"], agents: "*" },
      },
      anon: { scopes: ["agents:read"], agents: "*" },
      tokens: { maxTtlSeconds: 600 },
    },
  });
  publishableKey = String(
    (await app("POST", "/v1/access/publishable-keys", {
      requestId: "key",
      name: "web",
      origins: [ORIGIN],
    })).key,
  );
  subjectToken = String(
    (await app("POST", "/v1/tokens", { requestId: "token", subject: SUBJECT, role: "user" }))
      .token,
  );
  await app("PUT", "/v1/executors", {
    executors: [{ agentId: "bot", implementationVersion: "dev", token: EXECUTOR_TOKEN }],
  });
  await app("PUT", "/v1/sessions/s1", { requestId: "s1", agentId: "bot", ownerUserId: SUBJECT });
  vaultId = String(
    (await app("POST", "/v1/vaults", {
      requestId: "vault",
      idempotencyKey: "vault",
      name: "v",
      ownerUserId: SUBJECT,
    })).id,
  );
  secrets.push(
    [publishableKey, "<publishable-key>"],
    [subjectToken, "<subject-token>"],
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
    const admin = (key: string) => ({ "nylorun-protocol": "2", authorization: `Bearer ${key}` });
    const callers: Record<string, Record<string, string>> = {
      none: {},
      "protocol-only": { "nylorun-protocol": "2" },
      "wrong-admin": admin("matrix-wrong-admin-key-000000000000"),
      admin: admin(ADMIN_KEY),
      application: callerHeaders("application"),
      "admin-with-origin": { ...admin(ADMIN_KEY), origin: ORIGIN },
    };
    const operations: Operation[] = [
      { method: "GET", path: "/health" },
      { method: "POST", path: "/health" },
      { method: "GET", path: "/ready" },
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

  it("answers browser preflights from the route alone, as recorded", async () => {
    const preflights: Record<string, Observed> = {};
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
            requestHeaders ?? "authorization, content-type, nylorun-key, nylorun-protocol",
        },
      });
      await response.arrayBuffer();
      const observed: Observed = { status: response.status };
      const allowOrigin = response.headers.get("access-control-allow-origin");
      if (allowOrigin) observed.allowOrigin = allowOrigin;
      preflights[stable(`${method} ${path}`)] = observed;
    }
    await expect(`${JSON.stringify(preflights, null, 2)}\n`).toMatchFileSnapshot(
      "./__fixtures__/preflight-matrix.json",
    );
  });
});
