/**
 * The Runtime's OpenAPI documents: valid OpenAPI 3.2 (as Scalar, which renders them, reads
 * them), served as generated, every declared route in them once, and the Admin API's kept to
 * the admin key on the listener that serves it.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validate } from "@scalar/openapi-parser";
import { afterAll, beforeAll, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import { tenantApi } from "../../src/api/http/app.js";
import { adminDocument, tenantDocument } from "../../src/api/openapi.js";
import { RUNTIME_VERSION } from "../../src/version.js";
import { startEphemeralRuntime, type EphemeralRuntime } from "../../src/tenant/ephemeral.js";
import { testPool } from "../support/store.js";

let root: string;
let rt: EphemeralRuntime;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "nylorun-openapi-"));
  rt = await startEphemeralRuntime({ database: testPool(), hostRoot: root, operatorListener: true, model: { kind: "fixture" } });
});
afterAll(async () => {
  await rt?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

const operations = (document: { paths?: Record<string, unknown> }) =>
  Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
    Object.keys(item as object)
      .filter((key) => ["get", "put", "post", "delete", "patch"].includes(key))
      .map((method) => `${method.toUpperCase()} ${path}`),
  );

it("makes valid OpenAPI 3.2 documents", async () => {
  for (const document of [tenantDocument(), adminDocument()]) {
    expect(document.openapi).toBe("3.2.0");
    expect(document.info.version).toBe(RUNTIME_VERSION);
    const { valid, errors } = await validate(structuredClone(document));
    expect(errors ?? []).toEqual([]);
    expect(valid).toBe(true);
  }
});

it("documents every Tenant operation once, with who may call it", () => {
  const document = tenantDocument();
  const listed = operations(document);
  expect(new Set(listed).size).toBe(listed.length);
  // Every Tenant route the app declares, and /health, /ready and /openapi.json.
  const routes = tenantApi().openAPIRegistry.definitions.filter((d) => d.type === "route");
  expect(listed.length).toBe(routes.length + 3);
  for (const [path, item] of Object.entries(document.paths ?? {}))
    if (path.startsWith("/v1/"))
      for (const operation of Object.values(item as Record<string, Record<string, unknown>>))
        expect(operation["x-nylorun-scopes"], path).toBeDefined();
  expect(Object.keys(document.components?.securitySchemes ?? {}).sort()).toEqual([
    "applicationKey",
    "deliveryToken",
    "issuerToken",
  ]);
});

it("serves the Tenant API's document to anyone, but not to a browser", async () => {
  const served = await fetch(`${rt.url}/openapi.json`);
  expect(served.status).toBe(200);
  expect(served.headers.get("cache-control")).toBe("no-cache");
  expect(await served.json()).toEqual(JSON.parse(JSON.stringify(tenantDocument())));
  const fromBrowser = await fetch(`${rt.url}/openapi.json`, {
    headers: { origin: "https://app.example.com" },
  });
  expect(fromBrowser.status).toBe(403);
});

it("serves the Admin API's document with the admin key, on the listener that serves it", async () => {
  const admin = { "nylorun-protocol": String(PROTOCOL_VERSION), authorization: `Bearer ${rt.adminKey}` };
  const served = await fetch(`${rt.adminUrl}/v1/admin/openapi.json`, { headers: admin });
  expect(served.status).toBe(200);
  expect(await served.json()).toEqual(JSON.parse(JSON.stringify(adminDocument())));
  expect(operations(adminDocument())).toContain("GET /v1/admin/openapi.json");
  expect((await fetch(`${rt.url}/v1/admin/openapi.json`, { headers: admin })).status).toBe(404);
  expect(
    (
      await fetch(`${rt.adminUrl}/v1/admin/openapi.json`, {
        headers: { ...admin, authorization: "Bearer wrong" },
      })
    ).status,
  ).toBe(404);
});
