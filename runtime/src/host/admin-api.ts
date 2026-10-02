/**
 * The Admin API (`/v1/admin/**`): the Host's status and shutdown, for a caller with the admin
 * key. A Host serves one Tenant, so there are no Tenant routes: the status names the Tenant
 * and, when it could not be opened, why (tenancy.md §9). The Host checks the listener, the
 * protocol and the admin key first (`app.ts`); what gets here is authorized. Routes are
 * declared once, for serving and for the OpenAPI document.
 */
import { OpenAPIHono, type RouteConfig } from "@hono/zod-openapi";
import { z } from "zod";
import type { AdminStatus } from "@nylorun/core/contracts";
import {
  AdminStatus as AdminStatusBody,
  HostShutdownResponse,
  ProtocolRejected,
  Rejected,
} from "../api/components.js";
import { serveRoute } from "../api/route.js";
import type { NodeBindings } from "../tenant/types.js";
import { jsonResponse, rejectedResponse } from "./http.js";

export interface AdminApiOptions {
  /** `GET /v1/admin/status`. */
  status(): Promise<AdminStatus>;
  /** Stops the Host once the shutdown answer is sent. */
  shutdown(): void;
  /** `GET /v1/admin/openapi.json`: this API's OpenAPI document (`api/openapi.ts`). */
  document?(): unknown;
}

type AdminEnv = { Bindings: NodeBindings };

const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const rejected = (description: string) => json(Rejected, description);
/** What every Admin route may answer before its own logic runs. */
const gated = {
  404: rejected("Not found: an unknown admin key, or the public listener"),
  426: json(ProtocolRejected, "`Nylorun-Protocol` missing or unsupported"),
};

function adminRoute(route: Omit<RouteConfig, "tags" | "security">): RouteConfig {
  return {
    ...route,
    tags: ["Admin"],
    security: [{ adminKey: [] }],
    responses: { ...gated, ...route.responses },
  };
}

export function createAdminApi(options: AdminApiOptions): OpenAPIHono<AdminEnv> {
  const api = new OpenAPIHono<AdminEnv>();

  // HEAD is not a GET here: an Admin route answers only the methods it declares.
  api.use(async (c, next) => {
    if (c.req.method === "HEAD") return notFound();
    await next();
  });

  // D12: `/v1/admin/status` and `/v1/admin/host` are one answer.
  for (const path of ["/v1/admin/status", "/v1/admin/host"])
    serveRoute(
      api,
      adminRoute({
        method: "get",
        path,
        summary: path.endsWith("host") ? "Get the Host's status (alias)" : "Get the Host's status",
        responses: { 200: json(AdminStatusBody, "Version, protocol, the Tenant and the Host") },
      }),
      async () => jsonResponse(200, await options.status()),
    );

  serveRoute(
    api,
    adminRoute({
      method: "post",
      path: "/v1/admin/host/shutdown",
      summary: "Shut the Host down",
      description: "Answers, then stops the Host. Served by a self-hosted Runtime only.",
      responses: { 200: json(HostShutdownResponse, "The Host is stopping") },
    }),
    (c) => {
      c.env.outgoing.once("finish", () => options.shutdown());
      return jsonResponse(200, { status: "shutting_down" });
    },
  );

  serveRoute(
    api,
    adminRoute({
      method: "get",
      path: "/v1/admin/openapi.json",
      summary: "Get this document",
      responses: { 200: { description: "The Admin API's OpenAPI document" } },
    }),
    () =>
      options.document
        ? jsonResponse(200, options.document(), { "cache-control": "no-cache" })
        : notFound(),
  );

  api.notFound(() => notFound());
  // The Host answers what a route throws (`app.ts`), as it did before Hono.
  api.onError((error) => {
    throw error;
  });
  return api;
}

function notFound(): Response {
  return rejectedResponse(404, "not_found", "Route not found");
}
