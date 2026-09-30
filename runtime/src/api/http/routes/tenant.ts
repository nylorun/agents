/**
 * The Tenant's own settings (`/v1/tenant/**`): its status, reset, a first configuration, the
 * model it calls and the sandboxes its sessions get.
 *
 * A reset that deletes sessions abandons their streams (a session created again gets a new
 * incarnation) and collects them afterwards; it never deletes the Tenant's basin.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { z } from "zod";
import {
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
import { hostModelCatalog } from "../../../model/catalog.js";
import { sandboxConfigErrors } from "../../../sandbox/resolve.js";
import {
  effectiveSandboxConfig,
  readSandboxConfig,
  writeSandboxConfig,
} from "../../../sandbox/tenant-config.js";
import type { TenantContext } from "../../../tenant/context.js";
import { fail } from "../../../tenant/http.js";
import { clearExecutorStreams, clearObservers } from "../../../tenant/live.js";
import { usesFixtureModel } from "../../../tenant/model-setting.js";
import { resetTenant } from "../../../tenant/reset.js";
import { clearWork, drain } from "../../../tenant/scheduler.js";
import { buildTenantStatus, seedTenantConfig } from "../../../tenant/status.js";
import {
  requestStreamCollection,
  sessionStreamsAbandoned,
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

/**
 * The Tenant's settings are no executor's business: the refusal is recorded (`vault.reject`),
 * as every executor call to them was.
 */
async function refuseExecutor(c: Context<TenantEnv>): Promise<TenantContext> {
  const ctx = c.env.tenant;
  if (c.get("scope").kind === "executor") {
    await ctx.vault.reject(pathSegments(c.env.incoming).join("/"));
    fail(403, "Application credential required");
  }
  return ctx;
}

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
      const ctx = await refuseExecutor(c);
      const { vault } = ctx;
      return jsonResponse(
        200,
        await buildTenantStatus({
          envelope: ctx.envelope,
          config: ctx.config,
          store: ctx.store,
          registry: ctx.registry,
          vault,
          sandbox: ctx.sandbox,
          closing: ctx.closing || ctx.closed,
          modelConfigured:
            !ctx.useVaultModel ||
            (await ctx.store.tx((t) => usesFixtureModel(t))) ||
            (await vault.getHostModel()).configured,
          executorStreams: ctx.live.executorStreams,
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
      const ctx = await refuseExecutor(c);
      const request = ResetTenantRequestSchema.parse(await readJson(c.req.raw));
      await drain(ctx, request.activeWork, 30_000);
      // The deleted sessions' streams are abandoned: a session created again with the same id,
      // during or after the reset, gets a new incarnation and starts at sequence 0. The pending
      // collection is recorded first, so a crash before it runs leaves it to the sweep.
      const sessionsReset = request.scope !== "sandboxes";
      if (sessionsReset) await requestStreamCollection(ctx);
      await resetTenant(
        {
          store: ctx.store,
          registry: ctx.registry,
          sandbox: ctx.sandbox,
          paths: ctx.config.paths,
          clearSessionState: () => {
            clearWork(ctx);
            clearObservers(ctx.live);
          },
          clearExecutorStreams: () => clearExecutorStreams(ctx.live),
        },
        request.scope,
      );
      if (sessionsReset) sessionStreamsAbandoned(ctx);
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
      const ctx = await refuseExecutor(c);
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
      await refuseExecutor(c);
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
    async (c) => jsonResponse(200, await sandboxView(await refuseExecutor(c))),
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
      const ctx = await refuseExecutor(c);
      const { requestId: _requestId, ...config } = PutTenantSandboxRequestSchema.parse(
        await readJson(c.req.raw),
      );
      const errors = sandboxConfigErrors(
        effectiveSandboxConfig(config),
        (await ctx.sandbox.ready).backend?.name,
      );
      if (errors.length > 0) fail(400, errors.join(" "));
      await ctx.store.tx((t) => writeSandboxConfig(t, config));
      return jsonResponse(200, await sandboxView(ctx));
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
    async (c) => jsonResponse(200, await (await refuseExecutor(c)).vault.listHostProviders()),
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
    async (c) => jsonResponse(200, await (await refuseExecutor(c)).vault.getHostModel()),
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
      const ctx = await refuseExecutor(c);
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
      const ctx = await refuseExecutor(c);
      return jsonResponse(
        200,
        await ctx.vault.selectHostModel(
          SelectHostModelRequestSchema.parse(await readJson(c.req.raw)),
        ),
      );
    },
  );
}
