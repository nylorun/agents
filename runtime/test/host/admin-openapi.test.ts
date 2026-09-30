/**
 * The Admin API's routes, as declared for serving, make an OpenAPI 3.2 document: every
 * operation once, under the admin key, with the contracts' schemas as named components.
 */
import { OpenApiGeneratorV32 } from "@asteasolutions/zod-to-openapi";
import { expect, it } from "vitest";
import { createAdminApi } from "../../src/host/admin-api.js";
import { createFakeModule } from "./support.js";

function adminDocument() {
  const api = createAdminApi({
    module: createFakeModule(),
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

it("documents every Admin operation once, under the admin key", () => {
  const document = adminDocument();
  const operations = Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
    Object.keys(item as object)
      .filter((key) => ["get", "post", "put", "delete"].includes(key))
      .map((method) => `${method.toUpperCase()} ${path}`),
  );
  expect(operations.sort()).toEqual([
    "DELETE /v1/admin/tenants/{tenantId}",
    "GET /v1/admin/host",
    "GET /v1/admin/openapi.json",
    "GET /v1/admin/status",
    "GET /v1/admin/tenants",
    "GET /v1/admin/tenants/{tenantId}",
    "POST /v1/admin/host/shutdown",
    "POST /v1/admin/tenants",
  ]);
  for (const item of Object.values(document.paths ?? {}))
    for (const operation of Object.values(item as Record<string, { security?: unknown }>))
      expect(operation.security).toEqual([{ adminKey: [] }]);
});

it("names the contracts' schemas as components and refers to them", () => {
  const document = adminDocument();
  expect(Object.keys(document.components?.schemas ?? {})).toEqual(
    expect.arrayContaining([
      "AdminStatus",
      "AdminTenantList",
      "AdminTenantStatus",
      "CreateTenantRequest",
      "ProtocolRejected",
      "Rejected",
      "TenantEnvelope",
    ]),
  );
  const create = (document.paths?.["/v1/admin/tenants"] as any).post;
  expect(create.requestBody.content["application/json"].schema).toEqual({
    $ref: "#/components/schemas/CreateTenantRequest",
  });
  expect(create.responses["201"].content["application/json"].schema).toEqual({
    $ref: "#/components/schemas/TenantEnvelope",
  });
  const remove = (document.paths?.["/v1/admin/tenants/{tenantId}"] as any).delete;
  expect(remove.parameters).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "tenantId", in: "path", required: true }),
      expect.objectContaining({ name: "activeWork", in: "query", required: false }),
    ]),
  );
});
