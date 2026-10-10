import { describe, expect, it } from "vitest";
import { AdminError, rejection } from "../src/errors.js";
import { createManagementClient } from "../src/management.js";

/** A Management client behind Studio's proxy: every request answers `status` with `body`. */
function behindProxy(status: number, body: unknown) {
  const fetcher = (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  return createManagementClient({ url: "http://localhost:4161/_studio/runtime", fetch: fetcher });
}

describe("rejection", () => {
  it("keeps the Runtime's rejection: its code, message and details", () => {
    const error = rejection(
      409,
      { status: "rejected", code: "request_rejected", message: "Busy", details: { id: "x" } },
      "PUT /v1/tenant/model failed",
    );
    expect(error).toBeInstanceOf(AdminError);
    expect(error).toMatchObject({ code: "request_rejected", message: "Busy", status: 409, details: { id: "x" } });
  });

  it("keeps the message of Studio's own answers, with a code from the status", async () => {
    const expired = { message: "This Studio session is invalid or has expired." };
    await expect(behindProxy(401, expired).tenant.status()).rejects.toMatchObject({
      code: "credential_invalid",
      message: "This Studio session is invalid or has expired.",
      status: 401,
      details: expired,
    });
    await expect(
      behindProxy(403, { message: "Studio mutations require a same-origin request" }).tenant.status(),
    ).rejects.toMatchObject({
      code: "request_rejected",
      message: "Studio mutations require a same-origin request",
      status: 403,
    });
    await expect(
      behindProxy(502, { message: "Runtime is unavailable" }).tenant.status(),
    ).rejects.toMatchObject({ code: "internal_error", message: "Runtime is unavailable", status: 502 });
    await expect(
      behindProxy(404, { message: "Unsupported Studio operation" }).tenant.status(),
    ).rejects.toMatchObject({ code: "not_found", message: "Unsupported Studio operation" });
    expect(rejection(400, { message: "Invalid JSON" }, "x")).toMatchObject({ code: "invalid_request" });
    expect(rejection(415, { message: "JSON required" }, "x")).toMatchObject({
      code: "unsupported_media_type",
    });
  });

  it("names the request and the status for any other body", async () => {
    // A body with a code that is not the Runtime's rejection is not Studio's.
    const unknown = { code: "tenant_unavailable", message: "The Tenant is not open." };
    expect(rejection(503, unknown, "GET /v1/tenant failed")).toMatchObject({
      code: "internal_error",
      message: "GET /v1/tenant failed (503)",
      details: unknown,
    });
    await expect(behindProxy(503, "Service Unavailable").tenant.status()).rejects.toMatchObject({
      code: "internal_error",
      message: "GET /v1/tenant failed (503)",
      status: 503,
      details: "Service Unavailable",
    });
    expect(rejection(404, { message: 7 }, "GET /v1/tenant failed")).toMatchObject({
      code: "not_found",
      message: "GET /v1/tenant failed (404)",
      details: { message: 7 },
    });
    expect(rejection(405, undefined, "DELETE /v1/tenant failed")).toMatchObject({
      code: "request_rejected",
      message: "DELETE /v1/tenant failed (405)",
    });
  });
});
