/**
 * `createAdmin()`: the Management API client for the installation (`/v1/tenant/*`), with a
 * management key. The Admin API is gone (protocol 8): no `status()`, no `adminUrl`, no Admin
 * API keys.
 */
import { describe, expect, it } from "vitest";
import * as sdk from "../src/index.js";
import { createAdmin, deriveStudioToken, ManagementClient } from "../src/index.js";
import { PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import {
  ADMIN_KEY,
  MANAGEMENT_KEY,
  healthBody,
  sampleTenantStatus,
  startStubServer,
} from "./helpers.js";

function sendJson(response: import("node:http").ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

describe("the Management API client", () => {
  it("reads the Tenant with the management key and the protocol, naming no Tenant", async () => {
    const server = await startStubServer((request, response) => {
      if (request.url === "/health") return sendJson(response, 200, healthBody());
      expect(request.headers.authorization).toBe(`Bearer ${MANAGEMENT_KEY}`);
      expect(request.headers["nylorun-protocol"]).toBe(String(PROTOCOL_VERSION));
      expect(request.headers["nylorun-tenant"]).toBeUndefined();
      if (request.url === "/v1/tenant" && request.method === "GET")
        return sendJson(response, 200, sampleTenantStatus());
      sendJson(response, 404, { status: "rejected", code: "not_found", message: `unexpected ${request.url}` });
    });
    try {
      const admin = createAdmin({ url: server.url, key: MANAGEMENT_KEY });
      expect(admin).toBeInstanceOf(ManagementClient);
      await expect(admin.tenant.status()).resolves.toEqual(sampleTenantStatus());
    } finally {
      await server.close();
    }
  });

  it("has no Admin API: no status(), adminUrl, operator keys feature or Tenant routes", () => {
    const admin = createAdmin({ url: "http://127.0.0.1:1", key: MANAGEMENT_KEY });
    for (const name of ["status", "adminUrl", "listTenants", "getTenant", "deleteTenant", "createTenant"])
      expect(name in admin, name).toBe(false);
    expect("OPERATOR_KEYS_FEATURE" in sdk).toBe(false);
    for (const group of ["tenant", "keys", "models", "vaults", "signingKeys", "settings"] as const)
      expect(admin[group], group).toBeDefined();
  });

  it("throws AdminError with a registry code on rejected responses", async () => {
    const server = await startStubServer((request, response) => {
      if (request.url === "/health") return sendJson(response, 200, healthBody());
      sendJson(response, 403, {
        status: "rejected",
        code: "key_role_mismatch",
        message: "This is the Management API: use a management key",
      });
    });
    try {
      const admin = createAdmin({ url: server.url, key: MANAGEMENT_KEY });
      await expect(admin.tenant.status()).rejects.toMatchObject({
        name: "AdminError",
        code: "key_role_mismatch",
        status: 403,
      });
    } finally {
      await server.close();
    }
  });

  it("puts, lists and deletes application keys on /v1/tenant/keys", async () => {
    const KEY = "c".repeat(64);
    const server = await startStubServer((request, response) => {
      if (request.url === "/health") return sendJson(response, 200, healthBody());
      const route = `${request.method} ${request.url}`;
      if (route === "PUT /v1/tenant/keys/backend")
        return sendJson(response, 200, {
          id: "backend",
          role: "application",
          createdAt: "2026-10-04T00:00:00.000Z",
          key: KEY,
          rotated: false,
        });
      if (route === "GET /v1/tenant/keys")
        return sendJson(response, 200, {
          keys: [{ id: "backend", role: "application", createdAt: "2026-10-04T00:00:00.000Z" }],
        });
      if (route === "DELETE /v1/tenant/keys/backend") return sendJson(response, 200, { id: "backend", deleted: true });
      if (route === "DELETE /v1/tenant/keys/ghost")
        return sendJson(response, 404, { status: "rejected", code: "not_found", message: "No key ghost" });
      sendJson(response, 404, { status: "rejected", code: "not_found", message: "Not found" });
    });
    try {
      const admin = createAdmin({ url: server.url, key: MANAGEMENT_KEY });
      await expect(admin.keys.put("backend")).resolves.toMatchObject({ id: "backend", key: KEY });
      expect((await admin.keys.list()).map((key) => key.id)).toEqual(["backend"]);
      await expect(admin.keys.delete("backend")).resolves.toBe(true);
      await expect(admin.keys.delete("ghost")).resolves.toBe(false);
      // The opaque 404 (an unknown key) is an error, not a missing key.
      await expect(admin.keys.delete("other")).rejects.toMatchObject({ code: "not_found", status: 404 });
      expect(server.recorded.filter((r) => r.url === "/health")).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});

describe("derived keys", () => {
  it("derives only Studio's key, from the admin key", () => {
    const admin = createAdmin({ url: "http://127.0.0.1:1", key: MANAGEMENT_KEY });
    expect("deriveTenantKey" in admin).toBe(false);
    expect(deriveStudioToken(ADMIN_KEY)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("package isolation", () => {
  it("does not import @nylorun/runtime from admin sources", async () => {
    const { readFile, readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    async function walk(dir: string): Promise<string[]> {
      const entries = await readdir(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) files.push(...(await walk(path)));
        else if (entry.name.endsWith(".ts")) files.push(path);
      }
      return files;
    }
    for (const file of await walk(join(process.cwd(), "src")))
      expect(await readFile(file, "utf8")).not.toMatch(/@nylorun\/runtime/);
  });
});
