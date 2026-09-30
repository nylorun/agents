/**
 * Every successful answer of the Tenant and Admin APIs parses, exactly, with its schema in
 * `@nylorun/core/contracts`: the schemas the Runtime's OpenAPI document is generated from.
 * The schemas are strict, so a field the Runtime sends that a schema lacks fails here.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { ZodType } from "zod";
import {
  ERROR_CODES,
  AcceptedResponseSchema,
  ActionResultReceiptSchema,
  AccessPolicyResponseSchema,
  AdminStatusSchema,
  AdminTenantListSchema,
  AdminTenantStatusSchema,
  CreateTokenResponseSchema,
  CredentialInfoSchema,
  DeleteEndpointResponseSchema,
  DeliveryHeartbeatResponseSchema,
  ListEndpointsResponseSchema,
  DeletedResponseSchema,
  HealthResponseSchema,
  HostModelCatalogSchema,
  HostModelViewSchema,
  JwksSchema,
  EndpointPingResponseSchema,
  ListAgentsResponseSchema,
  ListCredentialsResponseSchema,
  ListProvidersResponseSchema,
  ListPublicAgentsResponseSchema,
  ListPublishableKeysResponseSchema,
  ListSessionsResponseSchema,
  ListVaultsResponseSchema,
  PublishableKeySchema,
  PutAgentResponseSchema,
  ReadyResponseSchema,
  ResetTenantResponseSchema,
  RevokeSubjectResponseSchema,
  SandboxToolOutcomeSchema,
  SessionItemsResponseSchema,
  SessionViewSchema,
  SigningKeyListSchema,
  TenantSandboxViewSchema,
  TenantStatusSchema,
  VaultInfoSchema,
} from "@nylorun/core/contracts";
import { z } from "zod";
import { Agent, tool } from "@nylorun/core/define";
import {
  startEphemeralRuntime,
  type EphemeralRuntime,
} from "../../src/tenant/ephemeral.js";
import { startEndpoint, type TestEndpoint } from "../support/endpoint.js";
const ORIGIN = "https://app.example.com";
let root: string;
let rt: EphemeralRuntime;
let endpoint: TestEndpoint | undefined;

function app(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "nylorun-protocol": "3",
    "nylorun-tenant": rt.tenantId,
    authorization: `Bearer ${rt.applicationKey}`,
    ...extra,
  };
}

/** Sends the request and returns its body, which must parse to itself with `schema`. */
async function answer(
  schema: ZodType,
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string>; base?: string } = {},
): Promise<any> {
  const headers = { ...(options.headers ?? app()) };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${options.base ?? rt.url}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const body = await response.json();
  expect(response.status, `${method} ${path}: ${JSON.stringify(body)}`).toBeLessThan(300);
  const parsed = schema.safeParse(body);
  expect(
    parsed.error?.issues.map(({ path, message }) => `${path.join(".")}: ${message}`),
    `${method} ${path}`,
  ).toBeUndefined();
  expect(parsed.data).toEqual(body);
  return body;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "nylorun-responses-"));
  rt = await startEphemeralRuntime({
    hostRoot: root,
    operatorListener: true,
    browserAccess: true,
    model: { kind: "fixture" },
  });
});

afterAll(async () => {
  await endpoint?.close();
  await rt?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

it("Host and Admin answers", async () => {
  const admin = { "nylorun-protocol": "3", authorization: `Bearer ${rt.adminKey}` };
  await answer(HealthResponseSchema, "GET", "/health", { headers: {} });
  await answer(ReadyResponseSchema, "GET", "/ready", { headers: {} });
  await answer(AdminTenantListSchema, "GET", "/v1/admin/tenants", {
    headers: admin,
    base: rt.adminUrl,
  });
  await answer(AdminTenantStatusSchema, "GET", `/v1/admin/tenants/${rt.tenantId}`, {
    headers: admin,
    base: rt.adminUrl,
  });
  await answer(AdminStatusSchema, "GET", "/v1/admin/status", { headers: admin, base: rt.adminUrl });
  await answer(AdminStatusSchema, "GET", "/v1/admin/host", { headers: admin, base: rt.adminUrl });
});

it("agents, sessions and Action endpoints", async () => {
  const manifest = Agent({ id: "bot", name: "Bot", description: "Helps" }).build().manifest;
  await answer(PutAgentResponseSchema, "PUT", "/v1/agents/bot", {
    body: { requestId: "bot", manifest, implementationVersion: "dev" },
  });
  await answer(PutAgentResponseSchema, "PUT", "/v1/agents/spare", {
    body: {
      requestId: "spare",
      manifest: Agent({ id: "spare", name: "Spare" }).build().manifest,
      implementationVersion: "dev",
    },
  });
  await answer(ListAgentsResponseSchema, "GET", "/v1/agents");

  await answer(ListEndpointsResponseSchema, "PUT", "/v1/endpoints", {
    body: {
      endpoints: [
        { agentId: "hooked", url: "http://localhost:3000/actions", implementationVersion: "dev" },
      ],
    },
  });
  await answer(ListEndpointsResponseSchema, "GET", "/v1/endpoints");
  await answer(DeleteEndpointResponseSchema, "DELETE", "/v1/endpoints/hooked");

  // A delivery to a local endpoint that answers 202, then its callbacks with the delivery token.
  // The fixture model calls `lookup_order`.
  const orders = Agent({ id: "orders", name: "Orders" })
    .use({
      id: "orders",
      tools: [tool({ name: "lookup_order", input: z.object({ orderId: z.string() }), async run() { return "found"; } })],
    })
    .build();
  await answer(PutAgentResponseSchema, "PUT", "/v1/agents/orders", {
    body: { requestId: "orders", manifest: orders.manifest, implementationVersion: "dev" },
  });
  endpoint = await startEndpoint({ runtime: { url: rt.url } });
  await answer(ListEndpointsResponseSchema, "PUT", "/v1/endpoints", {
    body: { endpoints: [{ agentId: "orders", url: endpoint.url, implementationVersion: "dev" }] },
  });
  await answer(EndpointPingResponseSchema, "POST", "/v1/endpoints/orders/ping");
  await answer(SessionViewSchema, "PUT", "/v1/sessions/o1", {
    body: { requestId: "o1", agentId: "orders", ownerUserId: "app:ann" },
  });
  await answer(AcceptedResponseSchema, "POST", "/v1/sessions/o1/commands", {
    body: { type: "message", requestId: "o1-m1", idempotencyKey: "o1-m1", content: "Where is it?" },
  });
  const delivery = await endpoint.next();
  const callback = (token: string) => app({ authorization: `Bearer ${token}` });
  const beat = await answer(
    DeliveryHeartbeatResponseSchema,
    "POST",
    `/v1/actions/${delivery.action.actionId}/heartbeat`,
    { headers: callback(delivery.token) },
  );
  await answer(ActionResultReceiptSchema, "POST", `/v1/actions/${delivery.action.actionId}/result`, {
    headers: callback(beat.token),
    body: { value: { kind: "completed", output: "found" } },
  });

  await answer(SessionViewSchema, "PUT", "/v1/sessions/s1", {
    body: { requestId: "s1", agentId: "bot", ownerUserId: "app:ann" },
  });
  // The Tenant's default sandbox, so session `sb` is opened with one.
  await answer(TenantSandboxViewSchema, "PUT", "/v1/tenant/sandbox", {
    body: { requestId: "sandbox", default: "virtual" },
  });
  await answer(SessionViewSchema, "PUT", "/v1/sessions/sb", {
    body: { requestId: "sb", agentId: "bot", ownerUserId: "app:ann" },
  });
  await answer(AcceptedResponseSchema, "POST", "/v1/sessions/s1/commands", {
    body: { type: "message", requestId: "m1", idempotencyKey: "m1", content: "Hello" },
  });
  await answer(SessionViewSchema, "GET", "/v1/sessions/s1");
  await answer(SessionViewSchema, "GET", "/v1/sessions/sb");
  await answer(ListSessionsResponseSchema, "GET", "/v1/sessions");
  await answer(SessionItemsResponseSchema, "GET", "/v1/sessions/s1/items");
  const outcome = await answer(SandboxToolOutcomeSchema, "POST", "/v1/sessions/sb/sandbox/bash", {
    body: { command: "echo hello" },
  });
  expect(outcome.kind).toBe("completed");
});

it("Tenant settings", async () => {
  await answer(TenantStatusSchema, "GET", "/v1/tenant");
  await answer(HostModelCatalogSchema, "GET", "/v1/tenant/models");
  await answer(ListProvidersResponseSchema, "GET", "/v1/tenant/providers");
  await answer(HostModelViewSchema, "GET", "/v1/tenant/model");
  await answer(TenantSandboxViewSchema, "GET", "/v1/tenant/sandbox");
  await answer(TenantSandboxViewSchema, "PUT", "/v1/tenant/sandbox", {
    body: {
      requestId: "limits",
      default: "virtual",
      limits: { resources: { cpus: 2, memory: "1GiB" }, idle: "5m" },
    },
  });
});

it("vaults and credentials", async () => {
  const write = (key: string) => ({ requestId: key, idempotencyKey: key });
  const vault = await answer(VaultInfoSchema, "POST", "/v1/vaults", {
    body: { ...write("vault"), name: "v", ownerUserId: "app:ann", metadata: { team: "a" } },
  });
  await answer(ListVaultsResponseSchema, "GET", "/v1/vaults?ownerUserId=app:ann");
  await answer(VaultInfoSchema, "GET", `/v1/vaults/${vault.id}`);
  const credential = await answer(CredentialInfoSchema, "POST", `/v1/vaults/${vault.id}/credentials`, {
    body: {
      ...write("credential"),
      name: "api",
      auth: { type: "bearer", url: "https://api.example.com", token: "secret-token" },
    },
  });
  const path = `/v1/vaults/${vault.id}/credentials/${credential.id}`;
  await answer(ListCredentialsResponseSchema, "GET", `/v1/vaults/${vault.id}/credentials`);
  await answer(CredentialInfoSchema, "GET", path);
  await answer(CredentialInfoSchema, "POST", path, {
    body: { ...write("rotate"), auth: { type: "bearer", token: "rotated-token" } },
  });
  await answer(DeletedResponseSchema, "DELETE", path);
  await answer(DeletedResponseSchema, "DELETE", `/v1/vaults/${vault.id}`);
});

it("access: policy, tokens, signing keys, publishable keys and revocations", async () => {
  await answer(AccessPolicyResponseSchema, "GET", "/v1/access/policy");
  await answer(AccessPolicyResponseSchema, "PUT", "/v1/access/policy", {
    body: {
      requestId: "policy",
      policy: {
        version: 1,
        roles: { user: { scopes: ["sessions:own", "agents:read"], agents: "*" } },
        anon: { scopes: ["agents:read"], agents: "*" },
        tokens: { maxTtlSeconds: 600 },
      },
    },
  });
  const token = await answer(CreateTokenResponseSchema, "POST", "/v1/tokens", {
    body: { requestId: "token", subject: "app:ann", role: "user" },
  });
  await answer(ListPublicAgentsResponseSchema, "GET", "/v1/agents", {
    headers: app({ authorization: `Bearer ${token.token}` }),
  });
  await answer(JwksSchema, "GET", "/v1/access/jwks");
  await answer(SigningKeyListSchema, "GET", "/v1/access/signing-keys");
  await answer(SigningKeyListSchema, "POST", "/v1/access/signing-keys/rotate", {
    body: { requestId: "rotate" },
  });
  const key = await answer(PublishableKeySchema, "POST", "/v1/access/publishable-keys", {
    body: { requestId: "key", name: "web", origins: [ORIGIN] },
  });
  await answer(ListPublicAgentsResponseSchema, "GET", "/v1/agents", {
    headers: { "nylorun-protocol": "3", "nylorun-key": key.key, origin: ORIGIN },
  });
  await answer(ListPublishableKeysResponseSchema, "GET", "/v1/access/publishable-keys");
  await answer(PublishableKeySchema, "PUT", `/v1/access/publishable-keys/${key.id}`, {
    body: { requestId: "origins", origins: [ORIGIN, "http://localhost:*"] },
  });
  await answer(PublishableKeySchema, "DELETE", `/v1/access/publishable-keys/${key.id}`);
  await answer(RevokeSubjectResponseSchema, "POST", "/v1/access/revocations", {
    body: { requestId: "revoke", subject: "app:ann" },
  });
});

it("reset", async () => {
  await answer(ResetTenantResponseSchema, "POST", "/v1/tenant/reset", {
    body: { requestId: "reset", scope: "all", activeWork: "cancel" },
  });
});

it("every error code the Runtime sends is one of ERROR_CODES", () => {
  const codes = new Set<string>();
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object")
      for (const [key, inner] of Object.entries(value))
        if (key === "code" && typeof inner === "string") codes.add(inner);
        else collect(inner);
  };
  for (const fixture of ["route-matrix.json", "host-matrix.json"])
    collect(JSON.parse(readFileSync(new URL(`../http/__fixtures__/${fixture}`, import.meta.url), "utf8")));
  expect(codes.size).toBeGreaterThan(5);
  expect([...codes].filter((code) => !(ERROR_CODES as readonly string[]).includes(code))).toEqual([]);
});
