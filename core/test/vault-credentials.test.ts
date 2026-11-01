/**
 * The secrets of an Environment's vault (D56, R2d): `PUT /v1/environments/{id}/secrets/{name}`
 * bodies. A `bearer` or a `headers` map for a tool URL, each with an optional `via` and identity
 * header (R2b C2); an `environment_secret` bound to hosts or a plain `environment_variable` for
 * the shell (R2c).
 */
import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "../src/compatibility.js";
import {
  ENVIRONMENT_SECRET_SENTINEL,
  AgentSecretViewSchema,
  EnvironmentSecretSlotSchema,
  environmentSecretNameError,
  isInjectFormat,
  PutAgentSecretRequestSchema,
  PutAgentSecretValueRequestSchema,
  renderInjectFormat,
} from "../src/contracts.js";

const put = (body: Record<string, unknown>) => PutAgentSecretRequestSchema.safeParse(body);
const headers = (body: Record<string, unknown>) =>
  put({ type: "headers", url: "https://vendor.test/mcp", headers: { "x-api-key": "k1" }, ...body });

describe("tool credentials", () => {
  it("accepts a header map, with a gateway and an identity header", () => {
    expect(
      headers({
        headers: { "DD-API-KEY": "a", "DD-APPLICATION-KEY": "b" },
        via: "https://gateway.test/mcp/datadog",
        identity: { header: "X-User-Id" },
      }).success,
    ).toBe(true);
    expect(put({ type: "bearer", url: "https://vendor.test/mcp", value: "t", via: "http://127.0.0.1:8080/mcp" }).success).toBe(true);
    expect(headers({ via: "http://localhost:9/mcp" }).success).toBe(true);
    expect(headers({ via: "http://[::1]:9/mcp" }).success).toBe(true);
  });

  it("refuses a via with a query string, userinfo, a fragment or plain http to another host", () => {
    for (const via of [
      "https://gateway.test/mcp?user=ada",
      "https://gateway.test/mcp?",
      "https://key:secret@gateway.test/mcp",
      "https://gateway.test/mcp#x",
      "http://gateway.test/mcp",
      "http://10.0.0.1/mcp",
      "ftp://gateway.test/mcp",
      "/relative",
    ])
      expect(headers({ via }).success, via).toBe(false);
  });

  it("takes a gateway's tool prefix only with via on a typed secret", () => {
    expect(headers({ via: "https://gateway.test/mcp/github", toolPrefix: "github-" }).success).toBe(true);
    expect(
      put({ type: "bearer", url: "https://vendor.test/mcp", value: "t", via: "https://gateway.test/mcp", toolPrefix: "x-" })
        .success,
    ).toBe(true);
    expect(headers({ toolPrefix: "github-" }).success).toBe(false);
    for (const toolPrefix of ["", "has space", "x".repeat(65)])
      expect(headers({ via: "https://gateway.test/mcp", toolPrefix }).success, toolPrefix).toBe(false);
    expect(PutAgentSecretValueRequestSchema.safeParse({ headers: { "x-api-key": "k" }, toolPrefix: "x-" }).success).toBe(true);
  });

  it("lets a bearer or headers slot name the gateway's tool prefix, with or without via (secret-routing)", () => {
    const slot = (body: Record<string, unknown>) => EnvironmentSecretSlotSchema.safeParse(body).success;
    // The folder names how the gateway lists tools; the installation binds where requests go.
    expect(slot({ type: "headers", url: "https://vendor.test/mcp", toolPrefix: "web-" })).toBe(true);
    expect(slot({ type: "bearer", url: "https://vendor.test/mcp", toolPrefix: "web-", required: true })).toBe(true);
    expect(slot({ type: "headers", url: "https://vendor.test/mcp", via: "https://gateway.test/mcp", toolPrefix: "x-" })).toBe(true);
    for (const toolPrefix of ["", "has space", "x".repeat(65)])
      expect(slot({ type: "headers", url: "https://vendor.test/mcp", toolPrefix }), toolPrefix).toBe(false);
    expect(slot({ type: "environment_variable", toolPrefix: "x-" })).toBe(false);
    expect(slot({ type: "environment_secret", allowedHosts: ["api.vendor.test"], toolPrefix: "x-" })).toBe(false);
  });

  it("takes via on a slot's value write, with the manifest's URL rules (secret-routing)", () => {
    const value = (body: Record<string, unknown>) => PutAgentSecretValueRequestSchema.safeParse(body).success;
    expect(value({ headers: { "x-api-key": "k" }, via: "http://localhost:4100/mcp/web" })).toBe(true);
    expect(value({ value: "t", via: "https://gateway.test/delegate" })).toBe(true);
    expect(value({ value: "t", via: "https://gateway.test/mcp", toolPrefix: "x-" })).toBe(true);
    for (const via of ["https://gateway.test/mcp?user=ada", "https://key:secret@gateway.test/mcp", "https://gateway.test/mcp#x", "http://gateway.test/mcp", "/relative"])
      expect(value({ value: "t", via }), via).toBe(false);
  });

  it("refuses an empty map, a bad name, a repeated name and a value with a line break", () => {
    expect(headers({ headers: {} }).success).toBe(false);
    expect(headers({ headers: { "x api key": "v" } }).success).toBe(false);
    expect(headers({ headers: { "X-Key": "a", "x-key": "b" } }).success).toBe(false);
    expect(headers({ headers: { "x-key": "a\r\nx-other: b" } }).success).toBe(false);
    expect(headers({ identity: { header: "x user" } }).success).toBe(false);
  });

  it("describes a secret with its header names, via and identity header, never its value", () => {
    const view = {
      name: "datadog",
      type: "headers",
      binding: { url: "https://vendor.test/mcp" },
      headerNames: ["dd-api-key"],
      via: "https://gateway.test/mcp",
      toolPrefix: "datadog-",
      identity: { header: "x-user-id" },
      createdAt: "2026-10-07T00:00:00.000Z",
    };
    expect(AgentSecretViewSchema.safeParse(view).success).toBe(true);
    expect(AgentSecretViewSchema.safeParse({ ...view, value: "k" }).success).toBe(false);
  });

  it("names credential_rejected and credential_conflict among the error codes", () => {
    expect(ERROR_CODES).toContain("credential_rejected");
    expect(ERROR_CODES).toContain("credential_conflict");
  });

  it("takes a label as a tool credential's name", () => {
    expect(environmentSecretNameError("bearer", "linear")).toBeUndefined();
    expect(environmentSecretNameError("headers", "dd.api-key_1")).toBeUndefined();
    expect(environmentSecretNameError("bearer", "has space")).toBeDefined();
    expect(environmentSecretNameError("bearer", "x".repeat(65))).toBeDefined();
  });
});

describe("shell credentials (R2c)", () => {
  const secret = (body: Record<string, unknown>) =>
    put({ type: "environment_secret", value: "ghp_x", allowedHosts: ["api.github.com"], ...body });

  it("accepts a secret with hosts and a header format, and a plain variable", () => {
    expect(secret({}).success).toBe(true);
    expect(secret({ inject: { header: "PRIVATE-TOKEN", format: "{value}" } }).success).toBe(true);
    expect(secret({ inject: { header: "Authorization", format: "Basic {base64:x-access-token:{value}}" } }).success).toBe(true);
    const parsed = secret({ allowedHosts: ["GitHub.com", "api.github.com"] });
    expect(parsed.success && parsed.data).toMatchObject({ allowedHosts: ["github.com", "api.github.com"] });
    expect(put({ type: "environment_variable", value: "eu-west-1" }).success).toBe(true);
  });

  it("refuses reserved names, wildcard or IP hosts, repeated hosts and bad formats", () => {
    for (const name of ["PATH", "HTTPS_PROXY", "SSL_CERT_FILE", "NYLORUN_TOKEN", "1BAD", "has space"])
      expect(environmentSecretNameError("environment_secret", name), name).toBeDefined();
    expect(environmentSecretNameError("environment_variable", "REGION")).toBeUndefined();
    for (const allowedHosts of [[], ["*.github.com"], ["1.2.3.4"], ["api.github.com", "API.github.com"], ["https://api.github.com"]])
      expect(secret({ allowedHosts }).success, JSON.stringify(allowedHosts)).toBe(false);
    for (const format of ["Bearer", "{value} {value}", "Bearer {token}", "Bearer {value}\r\nx: y"])
      expect(secret({ inject: { header: "Authorization", format } }).success, format).toBe(false);
    expect(secret({ value: "a\nb" }).success).toBe(false);
  });

  it("renders a format with the value and its base64 groups", () => {
    expect(isInjectFormat("Bearer {value}")).toBe(true);
    expect(renderInjectFormat("Bearer {value}", "t")).toBe("Bearer t");
    expect(renderInjectFormat("Basic {base64:x-access-token:{value}}", "ghp_x")).toBe(
      `Basic ${Buffer.from("x-access-token:ghp_x").toString("base64")}`,
    );
    expect(ENVIRONMENT_SECRET_SENTINEL).toBe("nylorun_managed");
  });

  it("keeps the sentinel to word characters, which CLIs that check a token's format accept", () => {
    // The Vercel CLI refuses a VERCEL_TOKEN that matches /\W/ before it sends a request.
    expect(ENVIRONMENT_SECRET_SENTINEL).toMatch(/^\w+$/);
  });
});
