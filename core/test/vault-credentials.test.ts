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
  EnvironmentSecretViewSchema,
  environmentSecretNameError,
  isInjectFormat,
  PutEnvironmentSecretRequestSchema,
  renderInjectFormat,
} from "../src/contracts.js";

const put = (body: Record<string, unknown>) => PutEnvironmentSecretRequestSchema.safeParse(body);
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
      identity: { header: "x-user-id" },
      createdAt: "2026-10-07T00:00:00.000Z",
    };
    expect(EnvironmentSecretViewSchema.safeParse(view).success).toBe(true);
    expect(EnvironmentSecretViewSchema.safeParse({ ...view, value: "k" }).success).toBe(false);
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
    expect(ENVIRONMENT_SECRET_SENTINEL).toBe("nylorun-managed");
  });
});
