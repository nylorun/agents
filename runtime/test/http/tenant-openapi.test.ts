/**
 * The Tenant API's routes, as declared for serving, make an OpenAPI 3.2 document: security
 * from who may call each route, the `Nylorun-*` headers, `x-nylorun-*` access fields, and event
 * streams as `itemSchema`.
 */
import { OpenApiGeneratorV32 } from "@asteasolutions/zod-to-openapi";
import { expect, it } from "vitest";
import { EVENT_TYPES } from "@nylorun/core/contracts";
import { eventComponentName } from "../../src/api/components.js";
import { tenantApi } from "../../src/api/http/app.js";

const document = new OpenApiGeneratorV32(tenantApi().openAPIRegistry.definitions).generateDocument({
  openapi: "3.2.0",
  info: { title: "Nylorun Runtime Tenant API", version: "test" },
});
const operation = (method: string, path: string) =>
  (document.paths?.[path] as Record<string, any> | undefined)?.[method];

it("documents the session reads with the same privileged credentials as serving", () => {
  const access = {
    "/v1/sessions/{sessionId}/manifest": [["application", "subject"], ["agents:read", "agents:write"]],
    "/v1/sessions/{sessionId}/usage": [["application"], "never"],
    "/v1/sessions/{sessionId}/calls/model": [["application"], "never"],
    "/v1/tenant/calls/model": [["management"], "never"],
  } as const;
  for (const [path, [credentials, scopes]] of Object.entries(access)) {
    const op = operation("get", path);
    expect(op.security).toEqual([
      { [path.startsWith("/v1/tenant") ? "managementKey" : "applicationKey"]: [] },
    ]);
    expect(op["x-nylorun-credentials"]).toEqual(credentials);
    expect(op["x-nylorun-browser"]).toBeUndefined();
    expect(op["x-nylorun-scopes"]).toEqual(scopes);
  }
  for (const path of ["/v1/sessions", "/v1/sessions/{sessionId}/items", "/v1/sandboxes"]) {
    expect(operation("get", path).parameters.find((p: {name: string}) => p.name === "limit").required).toBe(false);
  }
});

it("documents no executor routes, Action endpoints or delivery callbacks", () => {
  for (const [method, path] of [
    ["get", "/v1/executors/connect"],
    ["get", "/v1/actions"],
    ["post", "/v1/actions/{actionId}/claim"],
    ["get", "/v1/executors"],
    ["put", "/v1/executors"],
    ["delete", "/v1/executors/{agentId}"],
    ["put", "/v1/endpoints"],
    ["get", "/v1/endpoints"],
    ["delete", "/v1/endpoints/{agentId}"],
    ["post", "/v1/endpoints/{agentId}/ping"],
    ["post", "/v1/actions/{actionId}/heartbeat"],
    ["post", "/v1/actions/{actionId}/sandbox/{tool}"],
    ["post", "/v1/actions/{actionId}/result"],
  ] as const)
    expect(operation(method, path), `${method} ${path}`).toBeUndefined();
  expect(document.components?.schemas?.ExecutorNotification).toBeUndefined();
  expect(document.components?.securitySchemes?.deliveryToken).toBeUndefined();
});

it("documents session commands for every caller that sends them, with their headers", () => {
  const op = operation("post", "/v1/sessions/{sessionId}/commands");
  expect(op.deprecated).toBeUndefined();
  expect(op.security).toEqual([{ applicationKey: [] }, { issuerToken: [] }]);
  expect(op["x-nylorun-scopes"]).toEqual(["sessions:own"]);
  expect(op.requestBody.content["application/json"].schema).toEqual({
    $ref: "#/components/schemas/SessionCommand",
  });
  const headers = Object.fromEntries(
    op.parameters
      .filter((parameter: { in: string }) => parameter.in === "header")
      .map((parameter: { name: string; required?: boolean }) => [parameter.name, parameter.required ?? false]),
  );
  // Protocol 5: no request names the Tenant.
  expect(headers).toEqual({
    "Nylorun-Protocol": true,
    "Nylorun-Subject": false,
    "Nylorun-Scopes": false,
  });
  expect(Object.keys(op.responses)).toEqual(
    expect.arrayContaining(["200", "400", "401", "403", "404", "409", "426", "503"]),
  );
  // Turn limits per role are gone (protocol 7): the operator's proxy limits requests.
  expect(op.responses["429"]).toBeUndefined();
});

it("documents session events as server-sent catalog events, ending with the closed frame", () => {
  const op = operation("get", "/v1/sessions/{sessionId}/events");
  expect(op.security).toEqual([{ applicationKey: [] }, { issuerToken: [] }]);
  expect(op.responses["200"].content["text/event-stream"].itemSchema).toEqual({
    anyOf: [
      ...EVENT_TYPES.map((type) => ({
        $ref: `#/components/schemas/${eventComponentName(type)}`,
      })),
      { $ref: "#/components/schemas/StreamClosedFrame" },
    ],
  });
});

it("publishes one component per event type, on the nylorun.event/2 envelope", () => {
  const schemas = (document as unknown as { components: { schemas: Record<string, any> } })
    .components.schemas;
  for (const type of EVENT_TYPES) {
    const component = schemas[eventComponentName(type)];
    expect(component.properties.type).toEqual({ type: "string", enum: [type] });
    expect(component.properties.schema).toEqual({ type: "string", enum: ["nylorun.event/2"] });
  }
  expect(schemas.SessionItemsResponse.properties.items.items).toEqual({
    $ref: "#/components/schemas/SessionEvent",
  });
});

it("documents the agent list for issuer tokens too, and agent puts for application keys", () => {
  expect(operation("get", "/v1/agents").security).toEqual([
    { applicationKey: [] },
    { issuerToken: [] },
  ]);
  expect(operation("put", "/v1/agents/{agentId}").security).toEqual([{ applicationKey: [] }]);
  expect(operation("post", "/v1/sessions/{sessionId}/sandbox/{tool}")["x-nylorun-scopes"]).toBe(
    "never",
  );
});

it("documents vaults and Tenant settings for management keys only (protocol 8)", () => {
  for (const [method, path] of [
    ["post", "/v1/tenant/vaults"],
    ["get", "/v1/tenant/vaults"],
    ["get", "/v1/tenant/vaults/{vaultId}/credentials/{credentialId}"],
    ["delete", "/v1/tenant/vaults/{vaultId}"],
    ["post", "/v1/tenant/reset"],
    ["get", "/v1/tenant/models"],
    ["get", "/v1/tenant/providers"],
    ["put", "/v1/tenant/sandbox"],
  ] as const) {
    const op = operation(method, path);
    expect(op.security, `${method} ${path}`).toEqual([{ managementKey: [] }]);
    expect(op["x-nylorun-scopes"], `${method} ${path}`).toBe("never");
  }
  // The old vault paths are gone, and the MCP OAuth connect (protocol 10).
  for (const [method, path] of [
    ["post", "/v1/vaults"],
    ["get", "/v1/vaults"],
    ["get", "/v1/vaults/{vaultId}/credentials/{credentialId}"],
    ["delete", "/v1/vaults/{vaultId}"],
    ["post", "/v1/tenant/vaults/{vaultId}/oauth/start"],
    ["get", "/v1/oauth/callback"],
  ] as const)
    expect(operation(method, path), `${method} ${path}`).toBeUndefined();
  expect(operation("put", "/v1/tenant/sandbox").requestBody.content["application/json"].schema).toEqual({
    $ref: "#/components/schemas/PutTenantSandboxRequest",
  });
  // `tenant:settings` is retired: no route names it.
  expect(JSON.stringify(document)).not.toContain("tenant:settings");
});

it("documents the public keys for every caller or none, and signing keys for management keys", () => {
  const jwks = operation("get", "/v1/access/jwks");
  expect(jwks["x-nylorun-scopes"]).toBe("any");
  // `{}`: no credential needed.
  expect(jwks.security).toEqual([{ applicationKey: [] }, { managementKey: [] }, { issuerToken: [] }, {}]);
  for (const [method, path] of [
    ["get", "/v1/tenant/signing-keys"],
    ["post", "/v1/tenant/signing-keys/rotate"],
    ["post", "/v1/tenant/signing-keys/{kid}/revoke"],
  ] as const) {
    expect(operation(method, path).security, `${method} ${path}`).toEqual([{ managementKey: [] }]);
    expect(operation(method, path)["x-nylorun-scopes"]).toBe("never");
  }
  // The old signing-key paths are gone.
  for (const [method, path] of [
    ["get", "/v1/access/signing-keys"],
    ["post", "/v1/access/signing-keys/rotate"],
    ["post", "/v1/access/signing-keys/{kid}/revoke"],
  ] as const)
    expect(operation(method, path), `${method} ${path}`).toBeUndefined();
});

it("documents no subject tokens, access policy, browser keys or revocations (protocol 7)", () => {
  for (const [method, path] of [
    ["post", "/v1/tokens"],
    ["get", "/v1/access/policy"],
    ["put", "/v1/access/policy"],
    ["get", "/v1/access/publishable-keys"],
    ["post", "/v1/access/publishable-keys"],
    ["put", "/v1/access/publishable-keys/{keyId}"],
    ["delete", "/v1/access/publishable-keys/{keyId}"],
    ["post", "/v1/access/revocations"],
  ] as const)
    expect(operation(method, path), `${method} ${path}`).toBeUndefined();
  const text = JSON.stringify(document);
  for (const gone of ["Nylorun-Key", "x-nylorun-browser", "CreateTokenRequest", "AccessPolicy", "PublishableKey"])
    expect(text).not.toContain(gone);
});

it("documents the AG-UI endpoint with AG-UI's own schemas", () => {
  const run = operation("post", "/v1/ag-ui/agents/{agentId}");
  expect(run.security).toEqual([{ applicationKey: [] }, { issuerToken: [] }]);
  expect(run.requestBody.content["application/json"].schema).toEqual({
    $ref: "#/components/schemas/AgUiRunAgentInput",
  });
  expect(run.responses["200"].content["text/event-stream"].itemSchema).toEqual({
    $ref: "#/components/schemas/AgUiEvent",
  });
  for (const name of ["AgUiRunAgentInput", "AgUiEvent", "AgUiMessage"])
    expect(document.components?.schemas?.[name], name).toMatchObject({});
  expect(
    operation("get", "/v1/ag-ui/agents/{agentId}/threads/{threadId}/events").responses["204"],
  ).toBeDefined();
});

it("documents the A2A endpoint's JSON-RPC envelope and links the specification", () => {
  const call = operation("post", "/v1/a2a/agents/{agentId}");
  expect(call.security).toEqual([{ applicationKey: [] }, { issuerToken: [] }]);
  expect(call.externalDocs.url).toMatch(/^https:\/\/a2a-protocol\.org\//);
  expect(call.requestBody.content["application/json"].schema).toEqual({
    $ref: "#/components/schemas/A2aJsonRpcRequest",
  });
  expect(operation("get", "/v1/a2a/agents/{agentId}/card")["x-nylorun-scopes"]).toEqual([
    "agents:read",
    "sessions:own",
  ]);
});

it("documents no Nylorun-Tenant header anywhere (protocol 5)", () => {
  const text = JSON.stringify(document);
  expect(text).not.toContain('"name":"Nylorun-Tenant"');
});
