/**
 * Tenant administration and vault routes: `/v1/tenant` (status, reset, config seed, host
 * model and providers, sandbox report) and `/v1/vaults` (vaults and credentials).
 * A reset that deletes sessions abandons their streams (a session created again gets a new
 * incarnation) and collects them afterwards; it never deletes the Tenant's basin.
 *
 * Later waves: Wave 2 / X changes what reset clears once work leaves process memory.
 */
import type { IncomingMessage } from "node:http";
import {
  CreateCredentialRequestSchema,
  CreateVaultRequestSchema,
  PutHostModelRequestSchema,
  ResetTenantRequestSchema,
  RotateCredentialRequestSchema,
  SeedTenantConfigRequestSchema,
  SelectHostModelRequestSchema,
} from "@nylorun/core/contracts";
import { hostModelCatalog } from "../model/catalog.js";
import { resetTenant } from "./reset.js";
import { buildTenantStatus, seedTenantConfig } from "./status.js";
import type { AuthScope, TenantContext } from "./context.js";
import { fail, readBody } from "./http.js";
import { clearExecutorStreams, clearObservers } from "./live.js";
import {
  requestStreamCollection,
  sessionStreamsAbandoned,
} from "./streams.js";
import { clearWork, drain } from "./scheduler.js";

export async function dispatchTenant(
  ctx: TenantContext,
  scope: AuthScope,
  method: string | undefined,
  path: string[],
  request: IncomingMessage
): Promise<unknown> {
  const { vault } = ctx;
  if (scope.kind !== "application") {
    await vault.reject(path.join("/"));
    fail(403, "Application credential required");
  }
  if (path.length === 2 && method === "GET")
    return await buildTenantStatus({
      envelope: ctx.envelope,
      config: ctx.config,
      store: ctx.store,
      registry: ctx.registry,
      vault,
      sandbox: ctx.sandbox,
      closing: ctx.closing || ctx.closed,
      modelConfigured: ctx.useVaultModel
        ? (await vault.getHostModel()).configured
        : true,
      executorStreams: ctx.live.executorStreams,
      ...(ctx.stuckInvocations
        ? { stuckInvocations: ctx.stuckInvocations }
        : {}),
    });
  if (path[2] === "reset" && path.length === 3 && method === "POST") {
    const body = ResetTenantRequestSchema.parse(await readBody(request));
    await drain(ctx, body.activeWork, 30_000);
    // The deleted sessions' streams are abandoned: a session created again with the same id,
    // during or after the reset, gets a new incarnation and starts at sequence 0. The pending
    // collection is recorded first, so a crash before it runs leaves it to the sweep.
    const sessionsReset = body.scope !== "sandboxes";
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
      body.scope
    );
    if (sessionsReset) sessionStreamsAbandoned(ctx);
    // Reset leaves the Tenant open for new work.
    ctx.closing = false;
    return { ok: true };
  }
  if (
    path[2] === "config" &&
    path[3] === "seed" &&
    path.length === 4 &&
    method === "PUT"
  ) {
    const body = SeedTenantConfigRequestSchema.parse(await readBody(request));
    return await seedTenantConfig({ store: ctx.store, vault }, body);
  }
  if (path[2] === "models" && path.length === 3 && method === "GET")
    return hostModelCatalog();
  if (path[2] === "sandbox" && path.length === 3 && method === "GET")
    return ctx.sandbox.report();
  if (path[2] === "providers" && path.length === 3 && method === "GET")
    return vault.listHostProviders();
  if (path[2] === "model" && path.length === 3 && method === "GET")
    return vault.getHostModel();
  if (path[2] === "model" && path.length === 3 && method === "PUT")
    return vault.putHostModel(
      PutHostModelRequestSchema.parse(await readBody(request))
    );
  if (
    path[2] === "model" &&
    path[3] === "selection" &&
    path.length === 4 &&
    method === "PUT"
  )
    return vault.selectHostModel(
      SelectHostModelRequestSchema.parse(await readBody(request))
    );
  fail(404, "Route not found");
}

export async function dispatchVault(
  ctx: TenantContext,
  scope: AuthScope,
  method: string | undefined,
  path: string[],
  url: URL,
  request: IncomingMessage
): Promise<unknown> {
  const { vault } = ctx;
  if (scope.kind !== "application") {
    await vault.reject(path.join("/"));
    fail(403, "Application credential required");
  }
  if (path.length === 2 && method === "POST") {
    const body = CreateVaultRequestSchema.parse(await readBody(request));
    return vault.createVault(body);
  }
  if (path.length === 2 && method === "GET") {
    const ownerUserId =
      url.searchParams.get("ownerUserId") ??
      fail(400, "ownerUserId is required");
    return { vaults: await vault.listVaults(ownerUserId) };
  }
  const vaultId = path[2];
  if (!vaultId) fail(404, "Vault not found");
  if (path.length === 3 && method === "GET") return vault.getVault(vaultId);
  if (path.length === 3 && method === "DELETE")
    return vault.deleteVault(vaultId);
  if (path[3] !== "credentials") fail(404, "Route not found");
  if (path.length === 4 && method === "POST") {
    const body = CreateCredentialRequestSchema.parse(await readBody(request));
    return vault.createCredential(vaultId, body);
  }
  if (path.length === 4 && method === "GET")
    return { credentials: await vault.listCredentials(vaultId) };
  const credentialId = path[4];
  if (!credentialId) fail(404, "Credential not found");
  if (path.length === 5 && method === "GET")
    return vault.getCredential(vaultId, credentialId);
  if (path.length === 5 && method === "POST") {
    const body = RotateCredentialRequestSchema.parse(await readBody(request));
    return vault.rotateCredential(vaultId, credentialId, body);
  }
  if (path.length === 5 && method === "DELETE")
    return vault.deleteCredential(vaultId, credentialId);
  fail(404, "Route not found");
}
