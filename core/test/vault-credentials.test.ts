/**
 * R2b C2: the vault credential bodies. A `bearer` or a `headers` map, each with an optional
 * `via` (where requests go) and identity header.
 */
import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "../src/compatibility.js";
import {
  CreateCredentialRequestSchema,
  CredentialInfoSchema,
  ENVIRONMENT_SECRET_SENTINEL,
  isInjectFormat,
  renderInjectFormat,
  RotateCredentialRequestSchema,
} from "../src/contracts.js";

const base = { requestId: "r", idempotencyKey: "k", name: "c" };
const headers = (auth: Record<string, unknown>) =>
  CreateCredentialRequestSchema.safeParse({
    ...base,
    auth: { type: "headers", url: "https://vendor.test/mcp", headers: { "x-api-key": "k1" }, ...auth },
  });

describe("credential bodies", () => {
  it("accepts a header map, with a gateway and an identity header", () => {
    expect(
      headers({
        headers: { "DD-API-KEY": "a", "DD-APPLICATION-KEY": "b" },
        via: "https://gateway.test/mcp/datadog",
        identity: { header: "X-User-Id" },
      }).success,
    ).toBe(true);
    expect(
      CreateCredentialRequestSchema.safeParse({
        ...base,
        auth: { type: "bearer", url: "https://vendor.test/mcp", token: "t", via: "http://127.0.0.1:8080/mcp" },
      }).success,
    ).toBe(true);
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

  it("rotates a secret, and may change or remove via and identity", () => {
    const rotate = (auth: Record<string, unknown>) =>
      RotateCredentialRequestSchema.safeParse({ requestId: "r", idempotencyKey: "k", auth });
    expect(rotate({ type: "headers", headers: { "x-api-key": "k2" } }).success).toBe(true);
    expect(rotate({ type: "bearer", token: "t2", via: null, identity: null }).success).toBe(true);
    expect(rotate({ type: "bearer", token: "t2", via: "https://gateway.test/mcp?x=1" }).success).toBe(false);
    expect(rotate({ type: "headers", headers: { "x-api-key": "k2" }, url: "https://x.test" }).success).toBe(false);
  });

  it("describes a credential with its header names, via and identity header", () => {
    expect(
      CredentialInfoSchema.safeParse({
        id: "c",
        vaultId: "v",
        name: "n",
        type: "headers",
        binding: { url: "https://vendor.test/mcp" },
        headerNames: ["dd-api-key"],
        via: "https://gateway.test/mcp",
        identity: { header: "x-user-id" },
        createdAt: "2026-10-07T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("names credential_rejected among the error codes (R2b C1)", () => {
    expect(ERROR_CODES).toContain("credential_rejected");
  });
});

describe("shell credentials (R2c)", () => {
  const secret = (auth: Record<string, unknown>) =>
    CreateCredentialRequestSchema.safeParse({
      ...base,
      auth: { type: "environment_secret", secretName: "GH_TOKEN", secretValue: "ghp_x", allowedHosts: ["api.github.com"], ...auth },
    });

  it("accepts a secret with hosts and a header format, and a plain variable", () => {
    expect(secret({}).success).toBe(true);
    expect(secret({ inject: { header: "PRIVATE-TOKEN", format: "{value}" } }).success).toBe(true);
    expect(secret({ inject: { header: "Authorization", format: "Basic {base64:x-access-token:{value}}" } }).success).toBe(true);
    const parsed = secret({ allowedHosts: ["GitHub.com", "api.github.com"] });
    expect(parsed.success && parsed.data.auth).toMatchObject({ allowedHosts: ["github.com", "api.github.com"] });
    expect(
      CreateCredentialRequestSchema.safeParse({
        ...base,
        auth: { type: "environment_variable", variableName: "REGION", variableValue: "eu-west-1" },
      }).success,
    ).toBe(true);
  });

  it("refuses reserved names, wildcard or IP hosts, repeated hosts and bad formats", () => {
    for (const secretName of ["PATH", "HTTPS_PROXY", "SSL_CERT_FILE", "NYLORUN_TOKEN", "1BAD", "has space"])
      expect(secret({ secretName }).success, secretName).toBe(false);
    for (const allowedHosts of [[], ["*.github.com"], ["1.2.3.4"], ["api.github.com", "API.github.com"], ["https://api.github.com"]])
      expect(secret({ allowedHosts }).success, JSON.stringify(allowedHosts)).toBe(false);
    for (const format of ["Bearer", "{value} {value}", "Bearer {token}", "Bearer {value}\r\nx: y"])
      expect(secret({ inject: { header: "Authorization", format } }).success, format).toBe(false);
    expect(secret({ secretValue: "a\nb" }).success).toBe(false);
  });

  it("renders a format with the value and its base64 groups", () => {
    expect(isInjectFormat("Bearer {value}")).toBe(true);
    expect(renderInjectFormat("Bearer {value}", "t")).toBe("Bearer t");
    expect(renderInjectFormat("Basic {base64:x-access-token:{value}}", "ghp_x")).toBe(
      `Basic ${Buffer.from("x-access-token:ghp_x").toString("base64")}`,
    );
    expect(ENVIRONMENT_SECRET_SENTINEL).toBe("nylorun-managed");
  });

  it("rotates either kind by its value; a conflict has its own code", () => {
    expect(RotateCredentialRequestSchema.safeParse({ requestId: "r", idempotencyKey: "k", auth: { type: "environment_secret", secretValue: "n" } }).success).toBe(true);
    expect(RotateCredentialRequestSchema.safeParse({ requestId: "r", idempotencyKey: "k", auth: { type: "environment_variable", variableValue: "n" } }).success).toBe(true);
    expect(ERROR_CODES).toContain("credential_conflict");
  });
});
