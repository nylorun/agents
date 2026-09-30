/**
 * The Admin API (`/v1/admin/**`): Tenants and the Host's status, for a caller with the admin
 * key. The Host checks the listener, the protocol and the admin key first (`app.ts`); what
 * gets here is authorized. Routes are declared once, for serving and for the OpenAPI document.
 */
import { OpenAPIHono, type RouteConfig } from "@hono/zod-openapi";
import { z } from "zod";
import { CreateTenantRequestSchema, type AdminStatus } from "@nylorun/core/contracts";
import {
  AdminStatus as AdminStatusBody,
  AdminTenantList,
  AdminTenantStatus,
  CreateTenantRequest,
  HostShutdownResponse,
  ProtocolRejected,
  Rejected,
  TenantEnvelope,
} from "../api/components.js";
import { serveRoute } from "../api/route.js";
import { TenantBusyError, TenantConflictError } from "../tenant/quarantine.js";
import {
  TenantNotFoundError,
  type NodeBindings,
  type TenantModule,
} from "../tenant/types.js";
import {
  jsonResponse,
  opaqueNotFoundResponse,
  readJsonBody,
  rejectedResponse,
} from "./http.js";

export interface AdminApiOptions {
  module: TenantModule;
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
  404: rejected("Not found: an unknown admin key, the public listener, or an unknown Tenant"),
  426: json(ProtocolRejected, "`Nylorun-Protocol` missing or unsupported"),
};
const tenantId = z.object({
  tenantId: z.string().meta({ example: "tn_0123456789abcdefghjkmnpqrs" }),
});

function adminRoute(route: Omit<RouteConfig, "tags" | "security">): RouteConfig {
  return {
    ...route,
    tags: ["Admin"],
    security: [{ adminKey: [] }],
    responses: { ...gated, ...route.responses },
  };
}

export function createAdminApi(options: AdminApiOptions): OpenAPIHono<AdminEnv> {
  const { module } = options;
  const api = new OpenAPIHono<AdminEnv>();

  // HEAD is not a GET here: an Admin route answers only the methods it declares.
  api.use(async (c, next) => {
    if (c.req.method === "HEAD") return notFound();
    await next();
  });

  serveRoute(
    api,
    adminRoute({
      method: "get",
      path: "/v1/admin/tenants",
      summary: "List Tenants",
      responses: { 200: json(AdminTenantList, "Every Tenant on the Host") },
    }),
    async () => jsonResponse(200, await module.list()),
  );

  serveRoute(
    api,
    adminRoute({
      method: "post",
      path: "/v1/admin/tenants",
      summary: "Create a Tenant",
      description: "Idempotent on `idempotencyKey`: a replay answers 200 with the same Tenant.",
      request: {
        body: {
          required: true,
          content: { "application/json": { schema: CreateTenantRequest } },
        },
      },
      responses: {
        200: json(TenantEnvelope, "The Tenant, created earlier by the same request"),
        201: json(TenantEnvelope, "The Tenant, created"),
        400: rejected("Invalid JSON or request body (`invalid_request`)"),
        409: rejected("Another Tenant has this id or idempotency key (`tenant_conflict`)"),
        413: rejected("Request body over 1 MiB"),
      },
    }),
    async (c) => {
      const body = CreateTenantRequestSchema.parse(await readJsonBody(c.req.raw));
      try {
        const result = await module.create({
          tenantId: body.tenantId,
          name: body.name,
          principalId: body.principalId,
          credentialHash: body.credentialHash,
          idempotencyKey: body.idempotencyKey,
          ...(body.studioCredentialHash
            ? { studioCredentialHash: body.studioCredentialHash }
            : {}),
          ...(body.derivedPrincipals?.length
            ? { derivedPrincipals: body.derivedPrincipals }
            : {}),
        });
        return jsonResponse(result.created ? 201 : 200, result.envelope);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (
          error instanceof TenantConflictError ||
          (error as { name?: string }).name === "TenantConflictError" ||
          code === "conflict" ||
          code === "tenant_conflict"
        )
          return rejectedResponse(
            409,
            "tenant_conflict",
            error instanceof Error ? error.message : "Tenant conflict",
          );
        throw error;
      }
    },
  );

  serveRoute(
    api,
    adminRoute({
      method: "get",
      path: "/v1/admin/tenants/{tenantId}",
      summary: "Get a Tenant's status",
      request: { params: tenantId },
      responses: { 200: json(AdminTenantStatus, "The Tenant and its state") },
    }),
    async (c) => {
      const status = await module.status(c.req.param("tenantId")!);
      return status ? jsonResponse(200, status) : opaqueNotFoundResponse();
    },
  );

  serveRoute(
    api,
    adminRoute({
      method: "delete",
      path: "/v1/admin/tenants/{tenantId}",
      summary: "Delete a Tenant",
      request: {
        params: tenantId,
        query: z.object({
          activeWork: z.enum(["refuse", "drain", "cancel"]).optional().meta({
            description:
              "What to do with turns in progress: refuse to delete (default), wait for them, or cancel them",
          }),
        }),
      },
      responses: {
        204: { description: "Deleted" },
        400: rejected("`activeWork` is not refuse, drain or cancel (`invalid_request`)"),
        409: rejected("The Tenant has work in progress and `activeWork` is refuse (`active_work`)"),
      },
    }),
    async (c) => {
      const activeWork = c.req.query("activeWork") ?? "refuse";
      if (activeWork !== "refuse" && activeWork !== "drain" && activeWork !== "cancel")
        return rejectedResponse(
          400,
          "invalid_request",
          "activeWork must be refuse, drain, or cancel",
        );
      try {
        await module.delete(c.req.param("tenantId")!, activeWork);
        return new Response(null, { status: 204 });
      } catch (error) {
        if (error instanceof TenantNotFoundError) return opaqueNotFoundResponse();
        const code = (error as { code?: string }).code;
        if (
          error instanceof TenantBusyError ||
          (error as { name?: string }).name === "TenantBusyError" ||
          code === "active_work" ||
          code === "conflict"
        )
          return rejectedResponse(
            409,
            "active_work",
            error instanceof Error ? error.message : "Active work",
          );
        throw error;
      }
    },
  );

  // D12: `/v1/admin/status` and `/v1/admin/host` are one answer.
  for (const path of ["/v1/admin/status", "/v1/admin/host"])
    serveRoute(
      api,
      adminRoute({
        method: "get",
        path,
        summary: path.endsWith("host") ? "Get the Host's status (alias)" : "Get the Host's status",
        responses: { 200: json(AdminStatusBody, "Version, protocol, Tenants and the Host") },
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
