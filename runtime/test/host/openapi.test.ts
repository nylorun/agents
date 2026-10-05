/**
 * The Runtime's OpenAPI document: valid OpenAPI 3.2 (as Scalar, which renders it, reads it),
 * served as generated, with every declared route in it once.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validate } from "@scalar/openapi-parser";
import { afterAll, beforeAll, expect, it } from "vitest";
import { tenantApi } from "../../src/api/http/app.js";
import { tenantDocument } from "../../src/api/openapi.js";
import { RUNTIME_VERSION } from "../../src/version.js";
import { startEphemeralRuntime, type EphemeralRuntime } from "../../src/tenant/ephemeral.js";
import { testPool } from "../support/store.js";

let root: string;
let rt: EphemeralRuntime;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "nylorun-openapi-"));
  rt = await startEphemeralRuntime({ database: testPool(), hostRoot: root, model: { kind: "fixture" } });
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

it("makes a valid OpenAPI 3.2 document", async () => {
  const document = tenantDocument();
  expect(document.openapi).toBe("3.2.0");
  expect(document.info.version).toBe(RUNTIME_VERSION);
  const { valid, errors } = await validate(structuredClone(document));
  expect(errors ?? []).toEqual([]);
  expect(valid).toBe(true);
  expect(operations(document).filter((operation) => operation.includes("/v1/admin"))).toEqual([]);
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
    "managementKey",
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
