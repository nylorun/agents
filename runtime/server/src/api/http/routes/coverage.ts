/**
 * `POST /v1/tenant/credential-coverage` (the Management API): what a session of a saved agent
 * would send for each URL it names, in a given Environment. A dry run of each call's credential
 * choice (`VaultService.coverage`); no secret is read. An Environment's secrets themselves are
 * written on the Runtime API (`/v1/environments/{id}/secrets`, `routes/environments.ts`).
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { CredentialCoverageRequestSchema } from "@nylorun/core/contracts";
import type { AgentManifest, WorkflowManifest } from "@nylorun/core/define";
import { CredentialCoverage, CredentialCoverageRequest, Rejected } from "../../components.js";
import type { TenantEnv } from "../app.js";
import { readJson } from "../body.js";
import { tenantRoute, type RouteAccess } from "../define.js";
import { jsonResponse } from "../respond.js";
import { fail } from "../../../tenant/http.js";

/** A Management API route: a management key. */
const MANAGEMENT: RouteAccess = { credentials: ["management"], scopes: "never" };
const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { "application/json": { schema } },
});

export function coverageRoutes(api: OpenAPIHono<TenantEnv>): void {
  tenantRoute(
    api,
    MANAGEMENT,
    {
      method: "post",
      path: "/v1/tenant/credential-coverage",
      tags: ["Environments"],
      summary: "Check an agent's credentials against an Environment",
      description:
        "For each remote MCP server and each HTTP tool with a `credential` that the saved agent `agentId` declares (its own, its agents used as tools' and a flow's), the credential a session that names `environmentId` would send: the Environment's secret bound to the URL (`covered`), or none (`missing`). No secret is read and no server is called.",
      request: {
        body: { required: true, content: { "application/json": { schema: CredentialCoverageRequest } } },
      },
      responses: {
        200: json(CredentialCoverage, "One entry per declared URL"),
        404: json(Rejected, "No such agent, or no such Environment"),
      },
    },
    async (c) => {
      const request = CredentialCoverageRequestSchema.parse(await readJson(c.req.raw));
      const tenant = c.env.tenant;
      const definition =
        (await tenant.store.tx((t) =>
          t.get<{ manifest: AgentManifest | WorkflowManifest }>("definitions", request.agentId),
        )) ?? fail(404, "Definition not found");
      return jsonResponse(200, await tenant.vault.coverage(definition.manifest, request));
    },
  );
}
