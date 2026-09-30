/**
 * Action endpoints (design: Action endpoints §4.2): where the Runtime delivers each agent's
 * Actions, registered with the application key.
 *
 * While executors still exist, an agent is served by exactly one of them: registering an
 * endpoint removes the agent's executor and ends its streams, and `registerExecutors` refuses
 * an agent that has an endpoint (`actions.ts`).
 */
import {
  ENDPOINT_MAX_CONCURRENT_DEFAULT,
  ENDPOINT_TIMEOUT_DEFAULT_MS,
  type Endpoint,
  type PutEndpointsRequest,
} from "@nylorun/core/contracts";
import type { EndpointRow } from "../store/types.js";
import type { TenantContext } from "./context.js";
import { fail } from "./http.js";
import { endExecutorStreams } from "./live.js";

/** An endpoint as the Tenant API answers it. */
export function endpointView(row: EndpointRow): Endpoint {
  const served =
    row.servedImplementationVersion === undefined
      ? undefined
      : {
          implementationVersion: row.servedImplementationVersion,
          ...(row.servedManifestHash === undefined
            ? {}
            : { manifestHash: row.servedManifestHash }),
        };
  return {
    agentId: row.agentId,
    url: row.url,
    implementationVersion: row.implementationVersion,
    ...(row.manifestHash === undefined ? {} : { manifestHash: row.manifestHash }),
    timeoutMs: row.timeoutMs,
    maxConcurrent: row.maxConcurrent,
    health: {
      ...(row.lastDeliveryAt === undefined ? {} : { lastDeliveryAt: row.lastDeliveryAt }),
      ...(row.lastSuccessAt === undefined ? {} : { lastSuccessAt: row.lastSuccessAt }),
      ...(row.lastErrorCode === undefined
        ? {}
        : {
            lastError: {
              code: row.lastErrorCode,
              message: row.lastErrorMessage ?? "",
            },
          }),
      consecutiveFailures: row.consecutiveFailures,
      ...(served ? { served } : {}),
    },
    updatedAt: row.updatedAt,
  };
}

/** `GET /v1/endpoints`. */
export async function listEndpoints(ctx: TenantContext) {
  const rows = await ctx.store.tx((t) => t.listEndpoints());
  return { endpoints: rows.map(endpointView) };
}

/**
 * `PUT /v1/endpoints`: upsert the batch in one transaction and remove the executors of the
 * agents it covers. Answers every registered endpoint of the batch.
 */
export async function putEndpoints(
  ctx: TenantContext,
  principalId: string,
  body: PutEndpointsRequest,
) {
  const updatedAt = new Date().toISOString();
  const rows = await ctx.store.tx(async (t) => {
    const saved: EndpointRow[] = [];
    for (const endpoint of body.endpoints) {
      await t.putEndpoint({
        agentId: endpoint.agentId,
        url: endpoint.url,
        implementationVersion: endpoint.implementationVersion,
        ...(endpoint.manifestHash === undefined
          ? {}
          : { manifestHash: endpoint.manifestHash }),
        timeoutMs: endpoint.timeoutMs ?? ENDPOINT_TIMEOUT_DEFAULT_MS,
        maxConcurrent: endpoint.maxConcurrent ?? ENDPOINT_MAX_CONCURRENT_DEFAULT,
        principalId,
        updatedAt,
      });
      await t.deleteExecutor(endpoint.agentId);
      saved.push((await t.getEndpoint(endpoint.agentId))!);
    }
    return saved;
  });
  // The executors table committed without these agents; the registry follows it.
  for (const endpoint of body.endpoints) {
    const executor = ctx.registry.remove(endpoint.agentId);
    if (executor) endExecutorStreams(ctx.live, executor.tokenHash);
  }
  return { endpoints: rows.map(endpointView) };
}

/** `DELETE /v1/endpoints/:agentId`. The agent's pending Actions wait for a new endpoint. */
export async function deleteEndpoint(ctx: TenantContext, agentId: string) {
  await ctx.store.tx(async (t) => {
    if (!(await t.getEndpoint(agentId))) fail(404, "Endpoint not found");
    await t.deleteEndpoint(agentId);
  });
  return { agentId, deleted: true as const };
}
