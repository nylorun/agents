/**
 * A remote MCP server's tools before an agent names it (`POST /v1/tenant/mcp/preview`, R2b C12,
 * the Management API): a management key (or Studio's key, acting as itself), as the vault routes
 * take. The keys service runs it (`Keys.previewMcp`), since it sends an installation vault's
 * credential; this process never reads the plaintext.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { McpPreviewRequestSchema } from "@nylorun/core/contracts";
import { McpPreview, McpPreviewRequest, Rejected } from "../../components.js";
import type { TenantEnv } from "../app.js";
import { readJson } from "../body.js";
import { tenantRoute, type RouteAccess } from "../define.js";
import { jsonResponse } from "../respond.js";

/** The vault routes' access: a management key. */
const MANAGEMENT: RouteAccess = { credentials: ["management"], scopes: "never" };
const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { "application/json": { schema } },
});

export function mcpRoutes(api: OpenAPIHono<TenantEnv>): void {
  tenantRoute(
    api,
    MANAGEMENT,
    {
      method: "post",
      path: "/v1/tenant/mcp/preview",
      tags: ["MCP servers"],
      summary: "Preview an MCP server's tools",
      description:
        "Connects to the remote MCP server at `url` with the installation vault's credential for that URL (its headers and `via`; never an identity header), under the Host's address policy, lists its tools within 15 s and closes the connection. It never calls a tool. Each tool comes with the name the model would call it (`modelName`, made with `name`), its annotations and its input schema's size. A server that answers `401` is `authRequired`, with its RFC 9728 protected-resource metadata when it publishes any: it needs a person's sign-in, so reach it through a gateway (`via`), or with a key. No credential value is in the answer.",
      request: {
        body: { required: true, content: { "application/json": { schema: McpPreviewRequest } } },
      },
      responses: {
        200: json(McpPreview, "The server's tools, or that it needs a credential (`authRequired`)"),
        409: json(
          Rejected,
          "Several installation vaults hold a credential for the URL (name one with `vaultId`), or the one there cannot be used",
        ),
        502: json(
          Rejected,
          "The server could not be listed (`mcp_preview_failed`): `details.failure` is the code a tool call would have failed with, such as `mcp.unreachable` for an address the Host refuses",
        ),
      },
    },
    async (c) => {
      const request = McpPreviewRequestSchema.parse(await readJson(c.req.raw));
      return jsonResponse(200, await c.env.tenant.keys.previewMcp(request));
    },
  );
}
