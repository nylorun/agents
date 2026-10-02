import { describe, expect, it } from "vitest";
import {
  createAdmin,
  PROJECT_PRINCIPAL_ID,
  deriveStudioToken,
  deriveTenantKey,
} from "../src/index.js";
import { PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import {
  ADMIN_KEY,
  healthBody,
  sampleStatus,
  startStubServer,
} from "./helpers.js";

function sendJson(
  response: import("node:http").ServerResponse,
  status: number,
  body: unknown,
) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

describe("B4 Admin API methods", () => {
  it("status parses the Host's one Tenant and sends the admin key and protocol", async () => {
    const server = await startStubServer((request, response) => {
      if (request.url === "/health") {
        sendJson(response, 200, healthBody());
        return;
      }
      expect(request.headers.authorization).toBe(`Bearer ${ADMIN_KEY}`);
      expect(request.headers["nylorun-protocol"]).toBe(String(PROTOCOL_VERSION));
      expect(request.headers["nylorun-tenant"]).toBeUndefined();
      if (request.url === "/v1/admin/status" && request.method === "GET") {
        sendJson(response, 200, sampleStatus());
        return;
      }
      sendJson(response, 404, {
        status: "rejected",
        code: "not_found",
        message: `unexpected ${request.method} ${request.url}`,
      });
    });
    try {
      const admin = createAdmin({ url: server.url, key: ADMIN_KEY });
      await expect(admin.status()).resolves.toMatchObject({
        service: "nylorun-runtime",
        tenant: { id: "tn_00000000000000000000000001", state: "open" },
        host: { hostId: "host_00000000000000000000000001", pid: 42 },
      });
    } finally {
      await server.close();
    }
  });

  it("has no Tenant management methods: the Host creates its one Tenant", () => {
    const admin = createAdmin({ url: "http://127.0.0.1:1", key: ADMIN_KEY });
    for (const name of ["listTenants", "getTenant", "deleteTenant", "createTenant"])
      expect(name in admin).toBe(false);
  });

  it("throws AdminError with a registry code on rejected responses", async () => {
    const server = await startStubServer((request, response) => {
      if (request.url === "/health") {
        sendJson(response, 200, healthBody());
        return;
      }
      sendJson(response, 401, {
        status: "rejected",
        code: "host_rejected",
        message: "bad admin key",
      });
    });
    try {
      const admin = createAdmin({ url: server.url, key: ADMIN_KEY });
      await expect(admin.status()).rejects.toMatchObject({
        name: "AdminError",
        code: "host_rejected",
        status: 401,
      });
    } finally {
      await server.close();
    }
  });
});

describe("B5 derived keys", () => {
  it("derives the Studio and project keys of the Host's Tenant from the admin key", () => {
    const admin = createAdmin({ url: "http://127.0.0.1:1", key: ADMIN_KEY });
    const tenantId = sampleStatus().tenant.id;
    expect(admin.deriveTenantKey(tenantId, PROJECT_PRINCIPAL_ID)).toBe(
      deriveTenantKey(ADMIN_KEY, tenantId, "project"),
    );
    expect(admin.deriveTenantKey(tenantId, "project")).not.toBe(
      deriveStudioToken(ADMIN_KEY, tenantId),
    );
    expect(admin.deriveTenantKey(tenantId, "project")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("B6 package isolation", () => {
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
    const files = await walk(join(process.cwd(), "src"));
    for (const file of files) {
      const text = await readFile(file, "utf8");
      expect(text).not.toMatch(/@nylorun\/runtime/);
    }
  });
});
