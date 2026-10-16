/**
 * `POST /v1/tenant/credential-coverage` (the Management API): what a session on an Agent would
 * send for each URL its manifest version names, from the Agent's vault. A dry run of each call's
 * credential choice (`VaultService.coverage`); no secret is read. An Agent's secrets themselves
 * are written on the Runtime API (`/v1/agents/{id}/secrets`, `routes/agents.ts`).
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { CredentialCoverageRequestSchema } from "@nylorun/core/contracts";
import { loopManifestOf } from "@nylorun/core/define";
import { liveEnvironment } from "../../../tenant/agents.js";
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
      tags: ["Agents"],
      summary: "Check an Agent's credentials",
      description:
        "For each remote MCP server and each HTTP tool with a `credential` that Agent `agentId`'s manifest version declares (its own, its agents used as tools' and a flow's), the credential its sessions would send: the Agent's secret bound to the URL (`covered`), or none (`missing`). No secret is read and no server is called.",
      request: {
        body: { required: true, content: { "application/json": { schema: CredentialCoverageRequest } } },
      },
      responses: {
        200: json(CredentialCoverage, "One entry per declared URL"),
        404: json(Rejected, "No such Agent"),
      },
    },
    async (c) => {
      const request = CredentialCoverageRequestSchema.parse(await readJson(c));
      const tenant = c.env.tenant;
      const manifest = await tenant.store.tx(async (t) => {
        const agent = (await liveEnvironment(t, request.agentId)) ?? fail(404, "Agent not found");
        const version =
          (await t.agentManifest(agent.manifestName, agent.manifestVersion)) ?? fail(404, "Agent not found");
        return loopManifestOf(version.body);
      });
      return jsonResponse(200, await tenant.vault.coverage(manifest, request));
    },
  );
}
