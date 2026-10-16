/**
 * Every successful answer of the Runtime and Management APIs parses, exactly, with its schema in
 * `@nylorun/core/contracts`: the schemas the Runtime's OpenAPI document is generated from.
 * The schemas are strict, so a field the Runtime sends that a schema lacks fails here.
 */
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import type { ZodType } from "zod";
import {
  ERROR_CODES,
  AcceptedResponseSchema,
  AgentDiskVersionsSchema,
  AgentManifestPlanSchema,
  AgentManifestVersionsSchema,
  AgentManifestViewSchema,
  AgentPageSchema,
  CredentialCoverageSchema,
  DeleteAgentManifestResponseSchema,
  DeleteAgentResponseSchema,
  DeletedResponseSchema,
  AgentSecretViewSchema,
  AgentViewSchema,
  ForkAgentResponseSchema,
  HealthResponseSchema,
  HostModelCatalogSchema,
  ModelInputsViewSchema,
  HostModelViewSchema,
  JwksSchema,
  ListAgentEventsResponseSchema,
  ListAgentManifestsResponseSchema,
  ListAgentSecretsResponseSchema,
  ListAgentsResponseSchema,
  ListProvidersResponseSchema,
  ListSessionsResponseSchema,
  MeResponseSchema,
  ReadyResponseSchema,
  ResetTenantResponseSchema,
  SandboxToolOutcomeSchema,
  SaveAgentManifestResponseSchema,
  SessionItemsResponseSchema,
  SessionManifestViewSchema,
  SessionViewSchema,
  SigningKeyListSchema,
  TenantSandboxViewSchema,
  ModelUsageTotalsSchema,
  ModelBudgetsSchema,
  TenantStatusSchema,
} from "@nylorun/core/contracts";
import { Agent } from "@nylorun/core/define";
import {
  startEphemeralRuntime,
  type EphemeralRuntime,
} from "../../src/tenant/ephemeral.js";
import { testIssuer, type TestIssuer } from "../support/issuer.js";
import { testPool } from "../support/store.js";
import { manifestOf } from "../support/agents.js";
let issuer: TestIssuer;
let root: string;
let rt: EphemeralRuntime;

function app(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "nylorun-protocol": String(PROTOCOL_VERSION),
    authorization: `Bearer ${rt.applicationKey}`,
    ...extra,
  };
}

/** The Management API's key (protocol 8): every `/v1/tenant/*` route takes it alone. */
function management(): Record<string, string> {
  return { "nylorun-protocol": String(PROTOCOL_VERSION), authorization: `Bearer ${rt.managementKey}` };
}

/** Sends the request and returns its body, which must parse to itself with `schema`. */
async function answer(
  schema: ZodType,
  method: string,
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<any> {
  const headers = {
    ...(options.headers ?? (path.startsWith("/v1/tenant") ? management() : app())),
  };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${rt.url}${path}`, {
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
    database: testPool(),
    hostRoot: root,
    issuers: (issuer = await testIssuer()).configs,
    model: { kind: "fixture" },
  });
});

afterAll(async () => {
  await rt?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

it("Host answers", async () => {
  await answer(HealthResponseSchema, "GET", "/health", { headers: {} });
  const ready = await answer(ReadyResponseSchema, "GET", "/ready", { headers: {} });
  expect(ready.harness).toEqual({ mode: "in-process", connected: expect.any(Number) });
});

it("agent manifests, Agents and sessions", async () => {
  const bot = Agent({ id: "bot", name: "Bot", description: "Helps" }).build();
  await answer(AgentManifestPlanSchema, "PUT", "/v1/agent-manifests/bot?dryRun=true", { body: manifestOf(bot) });
  await answer(SaveAgentManifestResponseSchema, "PUT", "/v1/agent-manifests/bot", { body: manifestOf(bot) });
  // A second version, of kind virtual, so session `sb` runs with a sandbox.
  await answer(SaveAgentManifestResponseSchema, "PUT", "/v1/agent-manifests/box", {
    body: manifestOf(bot, { name: "box", runtime: { kind: "virtual", network: { allowedHosts: ["registry.npmjs.org"] } } }),
  });
  await answer(SaveAgentManifestResponseSchema, "PUT", "/v1/agent-manifests/spare", {
    body: manifestOf(Agent({ id: "spare", name: "Spare" }).build()),
  });
  await answer(ListAgentManifestsResponseSchema, "GET", "/v1/agent-manifests");
  await answer(AgentManifestViewSchema, "GET", "/v1/agent-manifests/bot");
  await answer(AgentManifestViewSchema, "GET", "/v1/agent-manifests/bot/versions/1");
  await answer(AgentManifestVersionsSchema, "GET", "/v1/agent-manifests/bot/versions");
  await answer(DeleteAgentManifestResponseSchema, "DELETE", "/v1/agent-manifests/spare");

  await answer(AgentViewSchema, "PUT", "/v1/agents/bot", { body: { requestId: "bot", manifest: "bot" } });
  await answer(AgentViewSchema, "PUT", "/v1/agents/env", {
    body: { requestId: "env", manifest: "box@1", labels: { team: "a" } },
  });
  await answer(ListAgentsResponseSchema, "GET", "/v1/agents");
  await answer(AgentPageSchema, "GET", "/v1/agents?limit=1");

  await answer(SessionViewSchema, "PUT", "/v1/sessions/s1", {
    body: { requestId: "s1", agent: "bot", ownerUserId: "app:ann" },
  });
  await answer(SessionViewSchema, "PUT", "/v1/sessions/sb", {
    body: { requestId: "sb", agent: "env", ownerUserId: "app:ann" },
  });
  await answer(AcceptedResponseSchema, "POST", "/v1/sessions/s1/commands", {
    body: { type: "message", requestId: "m1", idempotencyKey: "m1", content: "Hello" },
  });
  await answer(SessionViewSchema, "GET", "/v1/sessions/s1");
  expect(await answer(SessionViewSchema, "GET", "/v1/sessions/sb")).toMatchObject({
    agentId: "env",
    manifest: { name: "box", version: 1 },
  });
  await answer(SessionManifestViewSchema, "GET", "/v1/sessions/sb/manifest");
  await answer(ListSessionsResponseSchema, "GET", "/v1/sessions");
  await answer(SessionItemsResponseSchema, "GET", "/v1/sessions/s1/items");
  const outcome = await answer(SandboxToolOutcomeSchema, "POST", "/v1/sessions/sb/sandbox/bash", {
    body: { command: "echo hello" },
  });
  expect(outcome.kind).toBe("completed");
  expect(await answer(AgentViewSchema, "GET", "/v1/agents/env")).toMatchObject({
    manifest: "box@1",
    resolvedVersion: 1,
    tracking: "pinned",
    kind: "virtual",
  });
  await answer(ListAgentsResponseSchema, "GET", "/v1/agents?label=team=a");
  await answer(ListAgentEventsResponseSchema, "GET", "/v1/agents/env/events");
  await answer(AgentDiskVersionsSchema, "GET", "/v1/agents/env/versions");
  await answer(ForkAgentResponseSchema, "POST", "/v1/agents/env/fork", {
    body: { id: "env-copy", dryRun: true },
  });
});

it("Tenant settings", async () => {
  await answer(TenantStatusSchema, "GET", "/v1/tenant");
  const catalog = await answer(HostModelCatalogSchema, "GET", "/v1/tenant/models");
  // What a catalog model reads, and what the operator may add (protocol 12).
  const groq = catalog.providers
    .find((provider) => provider.id === "groq")!
    .models.find((model) => model.id === "llama-3.1-8b-instant")!;
  expect(groq).toMatchObject({ inputs: ["text"], addableInputs: ["image", "pdf", "audio", "video"] });
  expect(
    await answer(ModelInputsViewSchema, "PUT", "/v1/tenant/models/inputs", {
      body: { requestId: "i1", provider: "groq", model: "llama-3.1-8b-instant", inputs: ["image"] },
    }),
  ).toEqual({ provider: "groq", model: "llama-3.1-8b-instant", inputs: ["text", "image"] });
  const added = await answer(HostModelCatalogSchema, "GET", "/v1/tenant/models");
  expect(
    added.providers.find((provider) => provider.id === "groq")!.models.find((model) => model.id === groq.id)!.inputs,
  ).toEqual(["text", "image"]);
  await answer(ListProvidersResponseSchema, "GET", "/v1/tenant/providers");
  await answer(HostModelViewSchema, "GET", "/v1/tenant/model");
  await answer(TenantSandboxViewSchema, "GET", "/v1/tenant/sandbox");
  // The scripted model's calls are metered too, through its gate (protocol 15).
  expect(await answer(ModelUsageTotalsSchema, "GET", "/v1/tenant/usage")).toMatchObject({
    scope: "tenant",
    period: "total",
    costUsd: 0,
  });
  await answer(ModelUsageTotalsSchema, "GET", "/v1/tenant/usage?scope=turn&id=t1&period=day");
  const budgets = [
    { scope: "manifest", id: "bot", period: "day", limitUsd: 2.5 },
    { scope: "tenant", period: "month", limitUsd: 100, limitTokens: 1_000_000 },
    { scope: "turn", limitTokens: 500 },
  ];
  expect(
    await answer(ModelBudgetsSchema, "PUT", "/v1/tenant/budgets", { body: { requestId: "b1", budgets } }),
  ).toEqual({ budgets });
  expect(await answer(ModelBudgetsSchema, "GET", "/v1/tenant/budgets")).toEqual({ budgets });
  await answer(TenantSandboxViewSchema, "PUT", "/v1/tenant/sandbox", {
    body: {
      requestId: "limits",
      limits: { resources: { cpus: 2, memory: "1GiB" }, idle: "5m" },
    },
  });
});

it("Agent secrets and credential coverage", async () => {
  await answer(AgentViewSchema, "PUT", "/v1/agents/keys", {
    body: { requestId: "keys", manifest: "bot" },
  });
  const base = "/v1/agents/keys/secrets";
  await answer(AgentSecretViewSchema, "PUT", `${base}/GITHUB_TOKEN`, {
    body: {
      requestId: "secret",
      type: "environment_secret",
      value: "ghp-secret",
      allowedHosts: ["api.github.com"],
      inject: { header: "authorization", format: "Bearer {value}" },
    },
  });
  await answer(AgentSecretViewSchema, "PUT", `${base}/REGION`, {
    body: { requestId: "variable", type: "environment_variable", value: "eu" },
  });
  await answer(AgentSecretViewSchema, "PUT", `${base}/api`, {
    body: { requestId: "bearer", type: "bearer", url: "https://api.example.com", value: "secret-token" },
  });
  await answer(AgentSecretViewSchema, "PUT", `${base}/gateway`, {
    body: {
      requestId: "headers",
      type: "headers",
      url: "https://mcp.example.com/tools",
      headers: { "x-api-key": "secret-key" },
      via: "https://gateway.example.com/mcp",
    },
  });
  // Again, with a new value: the same credential, re-sealed.
  await answer(AgentSecretViewSchema, "PUT", `${base}/api`, {
    body: { requestId: "rotate", type: "bearer", url: "https://api.example.com", value: "rotated-token" },
  });
  expect((await answer(ListAgentSecretsResponseSchema, "GET", base)).secrets).toHaveLength(4);
  await answer(AgentSecretViewSchema, "GET", `${base}/api`);
  await answer(AgentSecretViewSchema, "GET", `${base}/GITHUB_TOKEN`);
  await answer(CredentialCoverageSchema, "POST", "/v1/tenant/credential-coverage", {
    body: { requestId: "coverage", agentId: "keys" },
  });
  await answer(DeletedResponseSchema, "DELETE", `${base}/api`);
  await answer(DeleteAgentResponseSchema, "DELETE", "/v1/agents/keys");
});

it("access: signing keys, public keys, and the caller and Agent list for an issuer token", async () => {
  const token = await issuer.sign("app:ann", "sessions:own agents:read");
  await answer(MeResponseSchema, "GET", "/v1/me", { headers: app({ authorization: `Bearer ${token}` }) });
  await answer(ListAgentsResponseSchema, "GET", "/v1/agents", {
    headers: app({ authorization: `Bearer ${token}` }),
  });
  await answer(JwksSchema, "GET", "/v1/access/jwks");
  await answer(SigningKeyListSchema, "GET", "/v1/tenant/signing-keys");
  await answer(SigningKeyListSchema, "POST", "/v1/tenant/signing-keys/rotate", {
    body: { requestId: "rotate" },
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
