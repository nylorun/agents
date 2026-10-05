/**
 * Application keys (`/v1/tenant/keys`, the Management API, protocol 8): a management key
 * creates, rotates, lists and deletes the Tenant's application keys by name. It never touches a
 * management key, `studio` or `bootstrap`: those come only from the Tenant's machine
 * (`nylorun-operate`, `NYLORUN_MANAGEMENT_KEY_FILE`), so a leaked management key cannot mint
 * another. A rotated or deleted key stops authenticating on its next request.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import {
  DeleteOperatorKeyResponse,
  ListOperatorKeysResponse,
  PutOperatorKeyResponse,
} from "../../components.js";
import { fail } from "../../../tenant/http.js";
import { operatorKeys, type OperatorKeyRefusal } from "../../../tenant/operator-keys.js";
import type { TenantEnv } from "../app.js";
import { tenantRoute, type RouteAccess } from "../define.js";
import { jsonResponse } from "../respond.js";

const MANAGEMENT: RouteAccess = { credentials: ["management"], scopes: "never" };

const keyId = z.object({
  keyId: z
    .string()
    .meta({ description: "The key's name: `^[a-z][a-z0-9-]{0,31}$`, never `studio` or `bootstrap`" }),
});
const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { "application/json": { schema } },
});

function refused(refusal: OperatorKeyRefusal): never {
  return fail(400, refusal.message, {
    code: refusal.reason === "invalid" ? "invalid_request" : "request_rejected",
  });
}

export function keyRoutes(api: OpenAPIHono<TenantEnv>): void {
  tenantRoute(
    api,
    MANAGEMENT,
    {
      method: "get",
      path: "/v1/tenant/keys",
      tags: ["Application keys"],
      summary: "List the Tenant's keys",
      description:
        "Every key of the Tenant by name, with its role (`application`, `management` or `studio`) and when it was issued. Keys themselves are never shown again.",
      responses: { 200: json(ListOperatorKeysResponse, "The keys, by id") },
    },
    async (c) => jsonResponse(200, { keys: await operatorKeys(c.env.tenant.store).list() }),
  );

  tenantRoute(
    api,
    MANAGEMENT,
    {
      method: "put",
      path: "/v1/tenant/keys/{keyId}",
      tags: ["Application keys"],
      summary: "Create or rotate an application key",
      description:
        "Issues a new application key named `keyId` and returns it this once. An application key of that name is replaced: the old one stops authenticating at once. A management key, `studio` and `bootstrap` are refused.",
      request: { params: keyId },
      responses: {
        200: json(PutOperatorKeyResponse, "The new key, shown once"),
        400: { description: "Not a key name, a reserved name, or a management key's name" },
      },
    },
    async (c) => {
      const put = await operatorKeys(c.env.tenant.store).put(c.req.param("keyId")!, "application");
      return "reason" in put ? refused(put) : jsonResponse(200, put);
    },
  );

  tenantRoute(
    api,
    MANAGEMENT,
    {
      method: "delete",
      path: "/v1/tenant/keys/{keyId}",
      tags: ["Application keys"],
      summary: "Delete an application key",
      description: "The key stops authenticating at once. A management key, `studio` and `bootstrap` are refused.",
      request: { params: keyId },
      responses: {
        200: json(DeleteOperatorKeyResponse, "The key is deleted"),
        400: { description: "Not a key name, a reserved name, or a management key's name" },
      },
    },
    async (c) => {
      const id = c.req.param("keyId")!;
      const deleted = await operatorKeys(c.env.tenant.store).delete(id, "application");
      if (typeof deleted !== "boolean") return refused(deleted);
      return deleted ? jsonResponse(200, { id, deleted: true }) : fail(404, `No key ${id}`);
    },
  );
}
