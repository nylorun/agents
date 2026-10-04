/**
 * The Admin API's routes, as declared for serving, make an OpenAPI 3.2 document: every
 * operation once, under the admin key, with the contracts' schemas as named components.
 */
import { OpenApiGeneratorV32 } from "@asteasolutions/zod-to-openapi";
import { expect, it } from "vitest";
import { createAdminApi } from "../../src/host/admin-api.js";

function adminDocument() {
  const api = createAdminApi({
    status: async () => {
      throw new Error("not called");
    },
    shutdown: () => {},
  });
  return new OpenApiGeneratorV32(api.openAPIRegistry.definitions).generateDocument({
    openapi: "3.2.0",
    info: { title: "Nylorun Runtime Admin API", version: "test" },
  });
}

it("documents every Admin operation once, under the admin key: no Tenant routes", () => {
  const document = adminDocument();
  const operations = Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
    Object.keys(item as object)
      .filter((key) => ["get", "post", "put", "delete"].includes(key))
      .map((method) => `${method.toUpperCase()} ${path}`),
  );
  expect(operations.sort()).toEqual([
    "DELETE /v1/admin/keys/{id}",
    "GET /v1/admin/host",
    "GET /v1/admin/keys",
    "GET /v1/admin/openapi.json",
    "GET /v1/admin/status",
    "POST /v1/admin/host/shutdown",
    "PUT /v1/admin/keys/{id}",
  ]);
  for (const item of Object.values(document.paths ?? {}))
    for (const operation of Object.values(item as Record<string, { security?: unknown }>))
      expect(operation.security).toEqual([{ adminKey: [] }]);
});

it("names the contracts' schemas as components and refers to them", () => {
  const document = adminDocument();
  const schemas = document.components?.schemas ?? {};
  expect(Object.keys(schemas)).toEqual(
    expect.arrayContaining([
      "AdminStatus",
      "HostShutdownResponse",
      "ListOperatorKeysResponse",
      "PutOperatorKeyResponse",
      "DeleteOperatorKeyResponse",
      "ProtocolRejected",
      "Rejected",
    ]),
  );
  for (const removed of ["AdminTenantList", "AdminTenantStatus", "CreateTenantRequest"])
    expect(schemas).not.toHaveProperty(removed);
  const status = (document.paths?.["/v1/admin/status"] as any).get;
  expect(status.responses["200"].content["application/json"].schema).toEqual({
    $ref: "#/components/schemas/AdminStatus",
  });
  const statusSchema = schemas.AdminStatus as { properties: Record<string, unknown> };
  expect(statusSchema.properties).toHaveProperty("tenant");
  expect(statusSchema.properties).not.toHaveProperty("tenants");
});
