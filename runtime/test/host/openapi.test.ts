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
import { managementDocument, runtimeDocument } from "../../src/api/openapi.js";
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

it("makes two valid OpenAPI 3.2 documents", async () => {
  for (const document of [runtimeDocument(), managementDocument()]) {
    expect(document.openapi).toBe("3.2.0");
    expect(document.info.version).toBe(RUNTIME_VERSION);
    const { valid, errors } = await validate(structuredClone(document));
    expect(errors ?? []).toEqual([]);
    expect(valid).toBe(true);
    expect(operations(document).filter((operation) => operation.includes("/v1/admin"))).toEqual([]);
  }
  expect(runtimeDocument().info.title).toBe("Nylorun Runtime API");
  expect(managementDocument().info.title).toBe("Nylorun Management API");
});

it("documents every operation in one document, with who may call it; /v1/me in both", () => {
  const runtime = operations(runtimeDocument());
  const management = operations(managementDocument());
  expect(new Set(runtime).size).toBe(runtime.length);
  expect(new Set(management).size).toBe(management.length);
  // Every Tenant route the app declares, and /health, /ready and the three document paths;
  // /v1/me is the one operation in both.
  const routes = tenantApi().openAPIRegistry.definitions.filter((d) => d.type === "route");
  expect(new Set([...runtime, ...management]).size).toBe(routes.length + 5);
  expect(runtime.filter((operation) => management.includes(operation))).toEqual(["GET /v1/me"]);
  // The Management API is /v1/tenant/*, the OAuth callback, /v1/me and its document.
  for (const operation of management)
    expect(operation, operation).toMatch(
      /^(GET|PUT|POST|DELETE) (\/v1\/tenant(\/|$)|\/v1\/oauth\/callback$|\/v1\/me$|\/openapi\/management\.json$)/,
    );
  for (const operation of runtime) expect(operation, operation).not.toMatch(/ \/v1\/tenant/);
  for (const document of [runtimeDocument(), managementDocument()])
    for (const [path, item] of Object.entries(document.paths ?? {}))
      if (path.startsWith("/v1/"))
        for (const operation of Object.values(item as Record<string, Record<string, unknown>>))
          expect(operation["x-nylorun-scopes"], path).toBeDefined();
});

it("describes and groups the tags, every operation in one of them, in the order they are used", () => {
  const runtime = runtimeDocument() as unknown as {
    tags: { name: string; description: string }[];
    "x-tagGroups": { name: string; tags: string[] }[];
    paths: Record<string, Record<string, { tags: string[] }>>;
  };
  expect(runtime["x-tagGroups"].map((group) => group.name)).toEqual([
    "Get started",
    "Agents",
    "Sessions",
    "Sandboxes & artifacts",
  ]);
  expect(runtime["x-tagGroups"].find((group) => group.name === "Sessions")?.tags).toEqual([
    "Sessions API",
    "AG-UI",
    "A2A",
  ]);
  // Every tag is in a group (Scalar hides the others) and described.
  const grouped = runtime["x-tagGroups"].flatMap((group) => group.tags);
  expect(runtime.tags.map((tag) => tag.name)).toEqual(grouped);
  for (const tag of runtime.tags) expect(tag.description.length, tag.name).toBeGreaterThan(20);
  const management = managementDocument() as unknown as typeof runtime;
  expect(management.tags.map((tag) => tag.name)).toEqual([
    "Tenant",
    "Application keys",
    "Models",
    "Vaults",
    "Signing keys",
    "Settings",
  ]);
  for (const document of [runtime, management])
    for (const item of Object.values(document.paths))
      for (const operation of Object.values(item))
        expect(document.tags.map((tag) => tag.name)).toContain(operation.tags[0]);
  // Use order: opening a session comes before sending it a command.
  const sessionPaths = Object.keys(runtime.paths).filter((path) => path.startsWith("/v1/sessions"));
  expect(sessionPaths[0]).toBe("/v1/sessions/{sessionId}");
});

it("serves both documents to anyone, but not to a browser", async () => {
  for (const [path, document] of [
    ["/openapi.json", runtimeDocument()],
    ["/openapi/runtime.json", runtimeDocument()],
    ["/openapi/management.json", managementDocument()],
  ] as const) {
    const served = await fetch(`${rt.url}${path}`);
    expect(served.status, path).toBe(200);
    expect(served.headers.get("cache-control")).toBe("no-cache");
    expect(await served.json()).toEqual(JSON.parse(JSON.stringify(document)));
    const fromBrowser = await fetch(`${rt.url}${path}`, {
      headers: { origin: "https://app.example.com" },
    });
    expect(fromBrowser.status, path).toBe(403);
  }
});
