/**
 * The Tenant's own settings (`/v1/tenant/**`): its status, reset, a first configuration, the
 * model it calls, what its model calls cost, and the sandboxes its sessions get.
 *
 * A reset that deletes sessions moves the Tenant to a new basin generation, so a session
 * created again starts in an empty basin; the old basin is deleted after a grace period.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { z } from "zod";
import {
  ModelUsageQuerySchema,
  PutHostModelRequestSchema,
  PutTenantSandboxRequestSchema,
  ResetTenantRequestSchema,
  SeedTenantConfigRequestSchema,
  SelectHostModelRequestSchema,
  type SubjectScope,
} from "@nylorun/core/contracts";
import {
  HostModelCatalog,
  HostModelView,
  ListProvidersResponse,
  ModelUsageTotals,
  PutHostModelRequest,
  PutTenantSandboxRequest,
  ResetTenantRequest,
  ResetTenantResponse,
  SeedTenantConfigRequest,
  SeedTenantConfigResponse,
  SelectHostModelRequest,
  TenantSandboxView,
  TenantStatus,
} from "../../components.js";
import { periodStart } from "../../../gates/meter.js";
import { hostModelCatalog } from "../../../model/catalog.js";
import { sandboxConfigErrors } from "../../../sandbox/resolve.js";
import {
  effectiveSandboxConfig,
  readSandboxConfig,
  writeSandboxConfig,
} from "../../../sandbox/tenant-config.js";
import type { TenantContext } from "../../../tenant/context.js";
import { fail } from "../../../tenant/http.js";
import { clearObservers } from "../../../tenant/session-streams.js";
import { usesFixtureModel } from "../../../tenant/model-setting.js";
import { resetTenant } from "../../../tenant/reset.js";
import { clearWork, drain } from "../../../tenant/scheduler.js";
import { buildTenantStatus, seedTenantConfig } from "../../../tenant/status.js";
import {
  tenantReset,
  streamsStatus,
} from "../../../tenant/streams.js";
import type { TenantEnv } from "../app.js";
import { readJson } from "../body.js";
import { pathSegments, tenantRoute, type RouteAccess } from "../define.js";
import { jsonResponse } from "../respond.js";

const settings = (scopes: readonly SubjectScope[] | "never"): RouteAccess => ({
  credentials: scopes === "never" ? ["application"] : ["application", "subject"],
  scopes,
});
const SETTINGS = settings(["tenant:settings"]);

const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const body = (schema: z.ZodType) => ({
  required: true,
  content: { "application/json": { schema } },
});

/** `GET /v1/tenant/sandbox`: the backend report and the configuration with defaults applied. */
async function sandboxView(ctx: TenantContext): Promise<unknown> {
  const config = await ctx.store.tx((t) => readSandboxConfig(t));
  return { ...(await ctx.sandbox.report()), config: effectiveSandboxConfig(config) };
}

export function tenantRoutes(api: OpenAPIHono<TenantEnv>): void {
  tenantRoute(
    api,
    SETTINGS,
    {
      method: "get",
      path: "/v1/tenant",
      tags: ["Tenant"],
      summary: "Get the Tenant's status",
      responses: { 200: json(TenantStatus, "Readiness, model, sandboxes, streams and counts") },
    },
    async (c) => {
      const ctx = c.env.tenant;
      const { vault } = ctx;
      return jsonResponse(
        200,
        await buildTenantStatus({
          envelope: ctx.envelope,
          config: ctx.config,
          store: ctx.store,
          vault,
          sandbox: ctx.sandbox,
          closing: ctx.closing || ctx.closed,
          modelConfigured:
            !ctx.useVaultModel ||
            (await ctx.store.tx((t) => usesFixtureModel(t))) ||
            (await vault.getHostModel()).configured,
          ...(ctx.stuckInvocations ? { stuckInvocations: ctx.stuckInvocations } : {}),
          streamsStatus: () => streamsStatus(ctx),
        }),
      );
    },
  );

  tenantRoute(
    api,
    settings("never"),
    {
      method: "post",
      path: "/v1/tenant/reset",
      tags: ["Tenant"],
      summary: "Reset the Tenant",
      description:
        "Deletes its sessions, its sandboxes, or both, after draining or cancelling the turns in progress. The Tenant stays open.",
      request: { body: body(ResetTenantRequest) },
      responses: { 200: json(ResetTenantResponse, "Reset") },
    },
    async (c) => {
      const ctx = c.env.tenant;
      const request = ResetTenantRequestSchema.parse(await readJson(c.req.raw));
      await drain(ctx, request.activeWork, 30_000);
      // A sessions reset moves the Tenant to a new basin generation, so a session created
      // again with the same id, during or after the reset, starts in an empty basin at 0.
      const sessionsReset = request.scope !== "sandboxes";
      await resetTenant(
        {
          store: ctx.store,
          sandbox: ctx.sandbox,
          paths: ctx.config.paths,
          clearSessionState: () => {
            clearWork(ctx);
            clearObservers(ctx.sessionStreams);
          },
        },
        request.scope,
      );
      if (sessionsReset) await tenantReset(ctx);
      // Reset leaves the Tenant open for new work.
      ctx.closing = false;
      return jsonResponse(200, { ok: true });
    },
  );

  tenantRoute(
    api,
    settings("never"),
    {
      method: "put",
      path: "/v1/tenant/config/seed",
      tags: ["Tenant"],
      summary: "Seed the Tenant's configuration",
      description: "Sets each setting the Tenant does not have yet; keeps the ones it has.",
      request: { body: body(SeedTenantConfigRequest) },
      responses: { 200: json(SeedTenantConfigResponse, "What was set, and what was kept") },
    },
    async (c) => {
      const ctx = c.env.tenant;
      const request = SeedTenantConfigRequestSchema.parse(await readJson(c.req.raw));
      return jsonResponse(200, await seedTenantConfig({ store: ctx.store, vault: ctx.vault }, request));
    },
  );

  tenantRoute(
    api,
    settings(["tenant:settings", "agents:write"]),
    {
      method: "get",
      path: "/v1/tenant/models",
      tags: ["Tenant"],
      summary: "List model providers and models",
      responses: { 200: json(HostModelCatalog, "Provider and model names") },
    },
    async (c) => {
      c.env.tenant;
      return jsonResponse(200, hostModelCatalog());
    },
  );

  tenantRoute(
    api,
    SETTINGS,
    {
      method: "get",
      path: "/v1/tenant/sandbox",
      tags: ["Tenant"],
      summary: "Get the Tenant's sandbox configuration",
      responses: { 200: json(TenantSandboxView, "The backend in use and the configuration in force") },
    },
    async (c) => jsonResponse(200, await sandboxView(c.env.tenant)),
  );

  tenantRoute(
    api,
    SETTINGS,
    {
      method: "put",
      path: "/v1/tenant/sandbox",
      tags: ["Tenant"],
      summary: "Set the Tenant's sandbox configuration",
      description: "What a session gets when it names no sandbox, and the limits every session's sandbox must fit.",
      request: { body: body(PutTenantSandboxRequest) },
      responses: { 200: json(TenantSandboxView, "The configuration now in force") },
    },
    async (c) => {
      const ctx = c.env.tenant;
      const { requestId: _requestId, ...config } = PutTenantSandboxRequestSchema.parse(
        await readJson(c.req.raw),
      );
      const errors = sandboxConfigErrors(effectiveSandboxConfig(config));
      if (errors.length > 0) fail(400, errors.join(" "));
      await ctx.store.tx((t) => writeSandboxConfig(t, config));
      return jsonResponse(200, await sandboxView(ctx));
    },
  );

  tenantRoute(
    api,
    SETTINGS,
    {
      method: "get",
      path: "/v1/tenant/usage",
      tags: ["Tenant"],
      summary: "Get what the Tenant's model calls used",
      description:
        "Totals from the model usage ledger, which the model gate writes once per call: for the Tenant, one agent or one turn, over the current UTC day or month, or all time.",
      request: { query: ModelUsageQuerySchema },
      responses: { 200: json(ModelUsageTotals, "The calls, tokens and cost") },
    },
    async (c) => {
      const parsed = ModelUsageQuerySchema.safeParse(c.req.query());
      if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? "Invalid query");
      const { scope, id, period } = parsed.data;
      if (scope !== "tenant" && !id) fail(400, `The ${scope} scope needs an id`);
      const since = period === "total" ? undefined : periodStart(period, new Date());
      const totals = await c.env.tenant.store.tx((t) =>
        t.modelUsageTotals({
          scope,
          ...(scope !== "tenant" ? { id: id! } : {}),
          ...(since ? { since } : {}),
        }),
      );
      return jsonResponse(200, {
        scope,
        ...(scope !== "tenant" ? { id } : {}),
        period,
        ...(since ? { since } : {}),
        ...totals,
      });
    },
  );

  tenantRoute(
    api,
    settings(["tenant:settings", "agents:write"]),
    {
      method: "get",
      path: "/v1/tenant/providers",
      tags: ["Tenant"],
      summary: "List the model providers the Tenant has credentials for",
      responses: { 200: json(ListProvidersResponse, "The providers") },
    },
    async (c) => jsonResponse(200, await (c.env.tenant).vault.listHostProviders()),
  );

  tenantRoute(
    api,
    SETTINGS,
    {
      method: "get",
      path: "/v1/tenant/model",
      tags: ["Tenant"],
      summary: "Get the Tenant's model",
      responses: { 200: json(HostModelView, "The model its sessions call") },
    },
    async (c) => jsonResponse(200, await (c.env.tenant).vault.getHostModel()),
  );

  tenantRoute(
    api,
    SETTINGS,
    {
      method: "put",
      path: "/v1/tenant/model",
      tags: ["Tenant"],
      summary: "Set a model provider's credentials",
      request: { body: body(PutHostModelRequest) },
      responses: { 200: json(HostModelView, "The model now in force") },
    },
    async (c) => {
      const ctx = c.env.tenant;
      return jsonResponse(
        200,
        await ctx.vault.putHostModel(PutHostModelRequestSchema.parse(await readJson(c.req.raw))),
      );
    },
  );

  tenantRoute(
    api,
    SETTINGS,
    {
      method: "put",
      path: "/v1/tenant/model/selection",
      tags: ["Tenant"],
      summary: "Choose the provider and model",
      request: { body: body(SelectHostModelRequest) },
      responses: { 200: json(HostModelView, "The model now in force") },
    },
    async (c) => {
      const ctx = c.env.tenant;
      return jsonResponse(
        200,
        await ctx.vault.selectHostModel(
          SelectHostModelRequestSchema.parse(await readJson(c.req.raw)),
        ),
      );
    },
  );
}
