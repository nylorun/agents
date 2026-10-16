/**
 * The Tenant's own settings (`/v1/tenant/**`): its status, reset, a first configuration, the
 * model it calls, what its model calls cost and may cost (budgets), the sandboxes its
 * sessions get, and its Runtime limits.
 *
 * A reset that deletes sessions moves the Tenant to a new basin generation, so a session
 * created again starts in an empty basin; the old basin is deleted after a grace period.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { z } from "zod";
import {
  ModelUsageQuerySchema,
  PutModelBudgetsRequestSchema,
  PutToolPolicyRequestSchema,
  PutModelInputsRequestSchema,
  type ModelBudget,
  PutHostModelRequestSchema,
  PutTenantEnvironmentsRequestSchema,
  PutTenantLimitsRequestSchema,
  RUNTIME_LIMIT_CEILINGS,
  RUNTIME_LIMIT_DEFAULTS,
  ResetTenantRequestSchema,
  runtimeLimitIssues,
  runtimeLimitsOf,
  SeedTenantConfigRequestSchema,
  SelectHostModelRequestSchema,
} from "@nylorun/core/contracts";
import {
  HostModelCatalog,
  HostModelView,
  ListProvidersResponse,
  ModelBudgets,
  ModelInputsView,
  ModelUsageTotals,
  PutModelBudgetsRequest,
  PutToolPolicyRequest,
  PutModelInputsRequest,
  ToolPolicy,
  PutHostModelRequest,
  PutTenantEnvironmentsRequest,
  PutTenantLimitsRequest,
  ResetTenantRequest,
  ResetTenantResponse,
  SeedTenantConfigRequest,
  SeedTenantConfigResponse,
  SelectHostModelRequest,
  TenantLimitsView,
  TenantSandboxView,
  TenantStatus,
} from "../../components.js";
import { readRuntimeLimits, writeLimitsConfig } from "../../../tenant/runtime-limits.js";
import { periodStart } from "../../../gates/meter.js";
import { readToolPolicy, TOOL_POLICY_SETTING, ToolPolicyUnreadable } from "../../../gates/policy.js";
import { addableInputs, capabilitiesOf, inputsError } from "../../../model/capabilities.js";
import { catalogModel, hostModelCatalog } from "../../../model/catalog.js";
import { sandboxConfigErrors } from "../../../sandbox/resolve.js";
import {
  effectiveSandboxConfig,
  readSandboxConfig,
  writeSandboxConfig,
} from "../../../sandbox/tenant-config.js";
import type { ModelBudgetRow } from "../../../store/types.js";
import type { TenantContext } from "../../../tenant/context.js";
import { fail } from "../../../tenant/http.js";
import { clearObservers } from "../../../tenant/session-streams.js";
import { readAddedInputs, usesFixtureModel, writeAddedInputs } from "../../../tenant/model-setting.js";
import { resetTenant } from "../../../tenant/reset.js";
import { clearWork, drain } from "../../../tenant/scheduler.js";
import { buildTenantStatus, harnessStatusOf, seedTenantConfig } from "../../../tenant/status.js";
import {
  tenantReset,
  streamsStatus,
} from "../../../tenant/streams.js";
import type { TenantEnv } from "../app.js";
import { readJson } from "../body.js";
import { pathSegments, tenantRoute, type RouteAccess } from "../define.js";
import { jsonResponse } from "../respond.js";
import { rearmPodTimers } from "../../../tenant/environments.js";
import { hostTuning } from "../../../tuning.js";

/** Every Management API route (`/v1/tenant/*`): a management key, acting as itself (protocol 8). */
const MANAGEMENT: RouteAccess = { credentials: ["management"], scopes: "never" };

/** Each Runtime limit's default and ceiling, for the limits routes' descriptions. */
const LIMITS_TABLE = `Defaults and ceilings: ${Object.entries(RUNTIME_LIMIT_CEILINGS)
  .map(
    ([name, ceiling]) =>
      `\`${name}\` ${RUNTIME_LIMIT_DEFAULTS[name as keyof typeof RUNTIME_LIMIT_DEFAULTS]} ${ceiling.unit}, at most ${ceiling.value} (${ceiling.why})`,
  )
  .join("; ")}.`;

const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const body = (schema: z.ZodType) => ({
  required: true,
  content: { "application/json": { schema } },
});

const budgetRow = (budget: ModelBudget, updatedAt: string): ModelBudgetRow => ({
  scope: budget.scope,
  scopeId: budget.scope === "agent" ? budget.id! : "*",
  period: budget.period ?? null,
  limitUsd: budget.limitUsd ?? null,
  limitTokens: budget.limitTokens ?? null,
  updatedAt,
});

const budgetView = (row: ModelBudgetRow): ModelBudget => ({
  scope: row.scope,
  ...(row.scope === "agent" ? { id: row.scopeId } : {}),
  ...(row.period ? { period: row.period } : {}),
  ...(row.limitUsd !== null ? { limitUsd: row.limitUsd } : {}),
  ...(row.limitTokens !== null ? { limitTokens: row.limitTokens } : {}),
});

/** `GET /v1/tenant/sandbox`: the backend report and the configuration with defaults applied. */
async function sandboxView(ctx: TenantContext): Promise<unknown> {
  const config = await ctx.store.tx((t) => readSandboxConfig(t));
  return {
    ...(await ctx.sandbox.report()),
    config: effectiveSandboxConfig(config),
    cluster: await clusterOf(ctx),
  };
}

/** The Tenant's cluster for pod sandboxes (F7.2), from the sandboxes service; null without one. */
async function clusterOf(ctx: TenantContext) {
  if (!ctx.pods) return null;
  try {
    const [info, ready] = await Promise.all([ctx.pods.client.info(), ctx.pods.client.ready()]);
    return {
      namespace: info.namespace,
      context: info.context,
      ready,
      ...(info.controllerVersion ? { controllerVersion: info.controllerVersion } : {}),
      ...(info.networkPolicy
        ? {
            networkPolicy: {
              enforced: info.networkPolicy.enforced === true,
              ...(info.networkPolicy.probedAt ? { probedAt: info.networkPolicy.probedAt } : {}),
            },
          }
        : {}),
    };
  } catch {
    return null;
  }
}

export function tenantRoutes(api: OpenAPIHono<TenantEnv>): void {
  tenantRoute(
    api,
    MANAGEMENT,
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
            ctx.scriptedModel ||
            (await ctx.store.tx((t) => usesFixtureModel(t))) ||
            (await vault.getHostModel()).configured,
          ...(ctx.stuckInvocations ? { stuckInvocations: ctx.stuckInvocations } : {}),
          streamsStatus: () => streamsStatus(ctx),
          harness: harnessStatusOf(ctx),
        }),
      );
    },
  );

  tenantRoute(
    api,
    MANAGEMENT,
    {
      method: "post",
      path: "/v1/tenant/reset",
      tags: ["Tenant"],
      summary: "Reset the Tenant",
      description:
        "Deletes its sessions, its Environments (with their vaults), or both, after draining or cancelling the turns in progress. The Tenant stays open.",
      request: { body: body(ResetTenantRequest) },
      responses: { 200: json(ResetTenantResponse, "Reset") },
    },
    async (c) => {
      const ctx = c.env.tenant;
      const request = ResetTenantRequestSchema.parse(await readJson(c));
      await drain(ctx, request.activeWork, hostTuning().tenant.drainTimeoutMs);
      // A sessions reset moves the Tenant to a new basin generation, so a session created
      // again with the same id, during or after the reset, starts in an empty basin at 0.
      const sessionsReset = request.scope !== "environments";
      await resetTenant(
        {
          store: ctx.store,
          sandbox: ctx.sandbox,
          paths: ctx.config.paths,
          blobs: ctx.blobs,
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
    MANAGEMENT,
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
      const request = SeedTenantConfigRequestSchema.parse(await readJson(c));
      return jsonResponse(200, await seedTenantConfig({ store: ctx.store, vault: ctx.vault, keys: ctx.keys }, request));
    },
  );

  tenantRoute(
    api,
    MANAGEMENT,
    {
      method: "get",
      path: "/v1/tenant/models",
      tags: ["Tenant"],
      summary: "List model providers and models",
      description:
        "Each model says what it reads (`inputs`: its catalog's inputs and those the operator added) and what may be added (`addableInputs`).",
      responses: { 200: json(HostModelCatalog, "Provider and model names, and their inputs") },
    },
    async (c) => {
      const added = await c.env.tenant.store.tx((t) => readAddedInputs(t));
      return jsonResponse(200, hostModelCatalog(added));
    },
  );

  tenantRoute(
    api,
    MANAGEMENT,
    {
      method: "put",
      path: "/v1/tenant/models/inputs",
      tags: ["Tenant"],
      summary: "Set what a catalog model reads",
      description:
        "Replaces the inputs the operator added to one catalog model (Tenant setting `model.inputs`): only those in its `addableInputs`, which its provider API carries. Its catalog's own inputs always stay; an empty list removes the additions. The agent's harness learns them in `turn.start.model` and decides how each file reaches the model. A custom endpoint sets `settings.inputs` on `PUT /v1/tenant/model` instead.",
      request: { body: body(PutModelInputsRequest) },
      responses: { 200: json(ModelInputsView, "What the model reads now") },
    },
    async (c) => {
      const { provider, model, inputs } = PutModelInputsRequestSchema.parse(await readJson(c));
      if (provider === "custom")
        fail(400, "A custom endpoint's inputs are its settings: set settings.inputs on PUT /v1/tenant/model.");
      const found = catalogModel(provider, model);
      if (!found) fail(400, `Unknown model ${provider}/${model}.`);
      const refused = inputsError(found!, inputs);
      if (refused) fail(400, refused);
      const added = inputs.filter((input) => addableInputs(found!).includes(input));
      await c.env.tenant.store.tx((t) => writeAddedInputs(t, `${provider}/${model}`, added));
      return jsonResponse(200, {
        provider,
        model,
        inputs: capabilitiesOf(found!, added).inputs,
      });
    },
  );

  tenantRoute(
    api,
    MANAGEMENT,
    {
      method: "get",
      path: "/v1/tenant/limits",
      tags: ["Tenant"],
      summary: "Get the Tenant's Runtime limits",
      description: `The sizes, counts and deadlines the Runtime holds what crosses it to: the Tenant's (Tenant setting \`limits.config\`), with the default for each it leaves out. Harnesses get the ones they must respect in \`turn.start.limits\` (record entry, model call, model file, tool answer, custom harness state, Harness API chunk, folder entries). ${LIMITS_TABLE}`,
      responses: { 200: json(TenantLimitsView, "The limits in force") },
    },
    async (c) => jsonResponse(200, { limits: await c.env.tenant.store.tx((t) => readRuntimeLimits(t)) }),
  );

  tenantRoute(
    api,
    MANAGEMENT,
    {
      method: "put",
      path: "/v1/tenant/limits",
      tags: ["Tenant"],
      summary: "Set the Tenant's Runtime limits",
      description: `Replaces the Tenant's Runtime limits: a limit left out takes its default. A limit above its ceiling, which a dependency sets, is \`400\` naming the ceiling, and nothing is written. Each is read where it is checked, so a new value holds for the next request, write, call or segment. ${LIMITS_TABLE}`,
      request: { body: body(PutTenantLimitsRequest) },
      responses: {
        200: json(TenantLimitsView, "The limits now in force"),
        400: { description: "A limit above its ceiling" },
      },
    },
    async (c) => {
      const { requestId: _requestId, ...config } = PutTenantLimitsRequestSchema.parse(await readJson(c));
      const issues = runtimeLimitIssues(config.limits);
      if (issues.length > 0) fail(400, issues.join(" "));
      await c.env.tenant.store.tx((t) => writeLimitsConfig(t, config));
      return jsonResponse(200, { limits: runtimeLimitsOf(config.limits) });
    },
  );

  tenantRoute(
    api,
    MANAGEMENT,
    {
      method: "get",
      path: "/v1/tenant/sandbox",
      tags: ["Tenant"],
      summary: "Get the Tenant's sandbox backend and Environment settings",
      responses: { 200: json(TenantSandboxView, "The backend in use and the configuration in force") },
    },
    async (c) => jsonResponse(200, await sandboxView(c.env.tenant)),
  );

  tenantRoute(
    api,
    MANAGEMENT,
    {
      method: "put",
      path: "/v1/tenant/sandbox",
      tags: ["Tenant"],
      summary: "Set the Tenant's Environment settings",
      description:
        "The limits every Environment's recipe must fit, the pods' stop grace and where harnesses may run (Tenant setting `environments.config`).",
      request: { body: body(PutTenantEnvironmentsRequest) },
      responses: { 200: json(TenantSandboxView, "The configuration now in force") },
    },
    async (c) => {
      const ctx = c.env.tenant;
      const { requestId: _requestId, ...config } = PutTenantEnvironmentsRequestSchema.parse(
        await readJson(c),
      );
      const errors = sandboxConfigErrors(effectiveSandboxConfig(config));
      if (errors.length > 0) fail(400, errors.join(" "));
      await ctx.store.tx((t) => writeSandboxConfig(t, config));
      // Pods' idle timers follow the new limits.idle (D36).
      await rearmPodTimers(ctx);
      return jsonResponse(200, await sandboxView(ctx));
    },
  );

  tenantRoute(
    api,
    MANAGEMENT,
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
    MANAGEMENT,
    {
      method: "get",
      path: "/v1/tenant/budgets",
      tags: ["Tenant"],
      summary: "Get the Tenant's model budgets",
      responses: { 200: json(ModelBudgets, "The hard caps on model spend") },
    },
    async (c) => {
      const rows = await c.env.tenant.store.tx((t) => t.listModelBudgets());
      return jsonResponse(200, { budgets: rows.map(budgetView) });
    },
  );

  tenantRoute(
    api,
    MANAGEMENT,
    {
      method: "put",
      path: "/v1/tenant/budgets",
      tags: ["Tenant"],
      summary: "Set the Tenant's model budgets",
      description:
        "Replaces every budget. Before each model call the gate checks the scope's spend against its cap; once a cap is reached the call fails with `budget_exhausted` and the turn with `model.budget_exhausted`. An empty list removes every cap.",
      request: { body: body(PutModelBudgetsRequest) },
      responses: { 200: json(ModelBudgets, "The budgets now in force") },
    },
    async (c) => {
      const { budgets } = PutModelBudgetsRequestSchema.parse(await readJson(c));
      const updatedAt = new Date().toISOString();
      const rows = await c.env.tenant.store.tx(async (t) => {
        await t.putModelBudgets(budgets.map((budget) => budgetRow(budget, updatedAt)));
        return t.listModelBudgets();
      });
      return jsonResponse(200, { budgets: rows.map(budgetView) });
    },
  );

  tenantRoute(
    api,
    MANAGEMENT,
    {
      method: "get",
      path: "/v1/tenant/tool-policy",
      tags: ["Tenant"],
      summary: "Get the Tenant's tool policy",
      responses: { 200: json(ToolPolicy, "The rules the Tool Gate applies to every MCP and HTTP tool call") },
    },
    async (c) => {
      try {
        return jsonResponse(200, await c.env.tenant.store.tx((t) => readToolPolicy(t)));
      } catch (error) {
        // A stored rule this Runtime refuses (an MCP tool named `server__tool`, protocol 15):
        // every call is denied until the policy is set again.
        if (error instanceof ToolPolicyUnreadable) return fail(409, error.message, { code: "request_rejected" });
        throw error;
      }
    },
  );

  tenantRoute(
    api,
    MANAGEMENT,
    {
      method: "put",
      path: "/v1/tenant/tool-policy",
      tags: ["Tenant"],
      summary: "Set the Tenant's tool policy",
      description:
        "Replaces every rule. The Tool Gate applies them to each MCP and HTTP tool call of every harness, before it sends the call: the strictest rule that matches decides. `deny` refuses the call (the model gets `tool.denied`), `ask` holds it and pauses the turn until a person answers it with an `approve` command on the session, `allow` runs it. A call no rule matches runs. A rule matches when every selector it sets matches: `tool` (the name the model calls it by; `*` matches any run of characters), `server` (an MCP server's name), `kind` (`mcp` or `http`), `agent` (the agent that calls it) and `when` (fields of the call's input by dotted path, each tested with `equals`, `in`, `gt`, `gte`, `lt`, `lte` or `matches`). Sandbox tools never cross the gate. An empty list allows every call.",
      request: { body: body(PutToolPolicyRequest) },
      responses: { 200: json(ToolPolicy, "The policy now in force") },
    },
    async (c) => {
      const { rules } = PutToolPolicyRequestSchema.parse(await readJson(c));
      const policy = { rules, updatedAt: new Date().toISOString() };
      await c.env.tenant.store.tx((t) => t.putSetting(TOOL_POLICY_SETTING, JSON.stringify(policy)));
      return jsonResponse(200, policy);
    },
  );

  tenantRoute(
    api,
    MANAGEMENT,
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
    MANAGEMENT,
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
    MANAGEMENT,
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
        await ctx.keys.putHostModel(PutHostModelRequestSchema.parse(await readJson(c))),
      );
    },
  );

  tenantRoute(
    api,
    MANAGEMENT,
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
        await ctx.keys.selectHostModel(
          SelectHostModelRequestSchema.parse(await readJson(c)),
        ),
      );
    },
  );
}
