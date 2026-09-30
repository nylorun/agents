/**
 * The Tenant API's routes, as declared for serving, make an OpenAPI 3.2 document: security
 * from who may call each route, the `Nylorun-*` headers, `x-nylorun-*` access fields, event
 * streams as `itemSchema`, and deprecated routes marked.
 */
import { OpenApiGeneratorV32 } from "@asteasolutions/zod-to-openapi";
import { expect, it } from "vitest";
import { tenantApi } from "../../src/api/http/app.js";

const document = new OpenApiGeneratorV32(tenantApi().openAPIRegistry.definitions).generateDocument({
  openapi: "3.2.0",
  info: { title: "Nylorun Runtime Tenant API", version: "test" },
});
const operation = (method: string, path: string) =>
  (document.paths?.[path] as Record<string, any> | undefined)?.[method];

it("documents the executor routes as deprecated, for executor or application keys", () => {
  for (const [method, path, scheme] of [
    ["get", "/v1/executors/connect", "executorKey"],
    ["get", "/v1/actions", "executorKey"],
    ["post", "/v1/actions/{actionId}/claim", "executorKey"],
    ["post", "/v1/actions/{actionId}/heartbeat", "executorKey"],
    ["post", "/v1/actions/{actionId}/sandbox/{tool}", "executorKey"],
    ["get", "/v1/executors", "applicationKey"],
    ["put", "/v1/executors", "applicationKey"],
    ["delete", "/v1/executors/{agentId}", "applicationKey"],
  ] as const) {
    const op = operation(method, path);
    expect(op, `${method} ${path}`).toBeDefined();
    expect(op.deprecated).toBe(true);
    expect(op.security).toEqual([{ [scheme]: [] }]);
    expect(op["x-nylorun-scopes"]).toBe("never");
  }
});

it("documents the work stream as server-sent events of ExecutorNotification", () => {
  const stream = operation("get", "/v1/executors/connect").responses["200"].content;
  expect(stream["text/event-stream"].itemSchema).toEqual({
    $ref: "#/components/schemas/ExecutorNotification",
  });
});

it("documents session commands for every caller that sends them, with their headers", () => {
  const op = operation("post", "/v1/sessions/{sessionId}/commands");
  expect(op.deprecated).toBeUndefined();
  expect(op.security).toEqual([{ applicationKey: [] }, { subjectToken: [] }, { executorKey: [] }]);
  expect(op["x-nylorun-scopes"]).toEqual(["sessions:own"]);
  expect(op["x-nylorun-browser"]).toBe(true);
  expect(op.requestBody.content["application/json"].schema).toEqual({
    $ref: "#/components/schemas/SessionCommand",
  });
  const headers = Object.fromEntries(
    op.parameters
      .filter((parameter: { in: string }) => parameter.in === "header")
      .map((parameter: { name: string; required?: boolean }) => [parameter.name, parameter.required ?? false]),
  );
  expect(headers).toEqual({
    "Nylorun-Protocol": true,
    "Nylorun-Tenant": false,
    "Nylorun-Subject": false,
    "Nylorun-Scopes": false,
  });
  expect(Object.keys(op.responses)).toEqual(
    expect.arrayContaining(["200", "400", "401", "403", "404", "409", "426", "429", "503"]),
  );
});

it("documents session events as server-sent LiveEvents, ending with the closed frame", () => {
  const op = operation("get", "/v1/sessions/{sessionId}/events");
  expect(op.security).toEqual([{ applicationKey: [] }, { subjectToken: [] }]);
  expect(op["x-nylorun-browser"]).toBe(true);
  expect(op.responses["200"].content["text/event-stream"].itemSchema).toEqual({
    anyOf: [
      { $ref: "#/components/schemas/LiveEvent" },
      { $ref: "#/components/schemas/StreamClosedFrame" },
    ],
  });
});

it("documents the agent list for publishable keys too, and agent puts for application keys", () => {
  expect(operation("get", "/v1/agents").security).toEqual([
    { applicationKey: [] },
    { subjectToken: [] },
    { publishableKey: [] },
  ]);
  expect(operation("put", "/v1/agents/{agentId}").security).toEqual([{ applicationKey: [] }]);
  expect(operation("post", "/v1/sessions/{sessionId}/sandbox/{tool}")["x-nylorun-scopes"]).toBe(
    "never",
  );
});
