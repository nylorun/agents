import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createAdmin, AdminError, deriveStudioToken } from "../src/index.js";
import {
  ADMIN_KEY,
  healthBody,
  sampleEnvelope,
  sampleStatus,
  sampleTenant,
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
  it("status, listTenants, getTenant, and deleteTenant parse schemas and auth", async () => {
    const server = await startStubServer((request, response, body) => {
      if (request.url === "/health") {
        sendJson(response, 200, healthBody());
        return;
      }
      expect(request.headers.authorization).toBe(`Bearer ${ADMIN_KEY}`);
      expect(request.headers["nylorun-protocol"]).toBe("2");
      if (request.url === "/v1/admin/status" && request.method === "GET") {
        sendJson(response, 200, sampleStatus());
        return;
      }
      if (request.url === "/v1/admin/tenants" && request.method === "GET") {
        sendJson(response, 200, [sampleTenant()]);
        return;
      }
      if (
        request.url === "/v1/admin/tenants/tn_00000000000000000000000001" &&
        request.method === "GET"
      ) {
        sendJson(response, 200, {
          ...sampleTenant(),
          quarantine: {
            code: "locked",
            message: "locked",
            repair: "remove the lock",
          },
        });
        return;
      }
      if (
        request.url ===
          "/v1/admin/tenants/tn_00000000000000000000000001?activeWork=drain" &&
        request.method === "DELETE"
      ) {
        expect(body).toBe("");
        response.writeHead(204);
        response.end();
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
        host: { hostId: "host_00000000000000000000000001", pid: 42 },
      });
      await expect(admin.listTenants()).resolves.toEqual([sampleTenant()]);
      await expect(
        admin.getTenant("tn_00000000000000000000000001"),
      ).resolves.toMatchObject({
        id: "tn_00000000000000000000000001",
        quarantine: { code: "locked" },
      });
      await expect(
        admin.deleteTenant("tn_00000000000000000000000001", {
          activeWork: "drain",
        }),
      ).resolves.toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("throws AdminError with a registry code on rejected responses", async () => {
    const server = await startStubServer((request, response) => {
      if (request.url === "/health") {
        sendJson(response, 200, healthBody());
        return;
      }
      sendJson(response, 409, {
        status: "rejected",
        code: "active_work",
        message: "sessions running",
        details: { runningSessions: 1 },
      });
    });
    try {
      const admin = createAdmin({ url: server.url, key: ADMIN_KEY });
      await expect(
        admin.deleteTenant("tn_00000000000000000000000001"),
      ).rejects.toMatchObject({
        name: "AdminError",
        code: "active_work",
        status: 409,
      });
    } finally {
      await server.close();
    }
  });
});

describe("B5 createTenant", () => {
  it("POSTs only credential hashes and retries identical values on 5xx", async () => {
    let posts = 0;
    const bodies: unknown[] = [];
    const server = await startStubServer((request, response, body) => {
      if (request.url === "/health") {
        sendJson(response, 200, healthBody());
        return;
      }
      if (request.url === "/v1/admin/tenants" && request.method === "POST") {
        posts += 1;
        const parsed = JSON.parse(body) as Record<string, unknown>;
        bodies.push(parsed);
        expect(parsed).not.toHaveProperty("applicationKey");
        expect(typeof parsed.credentialHash).toBe("string");
        expect(parsed.credentialHash).toMatch(/^[0-9a-f]{64}$/);
        expect(Object.keys(parsed).sort()).toEqual([
          "credentialHash",
          "idempotencyKey",
          "name",
          "principalId",
          "studioCredentialHash",
          "tenantId",
        ]);
        if (posts < 3) {
          sendJson(response, 503, {
            status: "rejected",
            code: "not_found",
            message: "temporary",
          });
          return;
        }
        sendJson(response, 201, sampleEnvelope(String(parsed.tenantId)));
        return;
      }
      sendJson(response, 404, {
        status: "rejected",
        code: "not_found",
        message: "no",
      });
    });
    try {
      const admin = createAdmin({ url: server.url, key: ADMIN_KEY });
      const result = await admin.createTenant({ name: "demo" });
      expect(posts).toBe(3);
      expect(bodies).toHaveLength(3);
      expect(bodies[0]).toEqual(bodies[1]);
      expect(bodies[1]).toEqual(bodies[2]);
      expect(result.tenant.name).toBe("demo");
      expect(result.applicationKey).toMatch(/^[0-9a-f]{64}$/);
      const expectedHash = createHash("sha256")
        .update(result.applicationKey, "utf8")
        .digest("hex");
      expect((bodies[0] as { credentialHash: string }).credentialHash).toBe(
        expectedHash,
      );
      expect(JSON.stringify(bodies)).not.toContain(result.applicationKey);
      const sent = bodies[0] as { tenantId: string; studioCredentialHash: string };
      const studioToken = deriveStudioToken(ADMIN_KEY, sent.tenantId);
      expect(sent.studioCredentialHash).toBe(
        createHash("sha256").update(studioToken, "utf8").digest("hex"),
      );
      expect(JSON.stringify(bodies)).not.toContain(studioToken);
      expect(JSON.stringify(bodies)).not.toContain(ADMIN_KEY);
    } finally {
      await server.close();
    }
  });

  it("retries identical values after a network error", async () => {
    let posts = 0;
    const bodies: string[] = [];
    const server = await startStubServer((request, response, body) => {
      if (request.url === "/health") {
        sendJson(response, 200, healthBody());
        return;
      }
      if (request.url === "/v1/admin/tenants" && request.method === "POST") {
        posts += 1;
        bodies.push(body);
        if (posts === 1) {
          request.socket.destroy();
          return;
        }
        const parsed = JSON.parse(body) as { tenantId: string };
        sendJson(response, 201, sampleEnvelope(parsed.tenantId));
        return;
      }
      sendJson(response, 404, {
        status: "rejected",
        code: "not_found",
        message: "no",
      });
    });
    try {
      const admin = createAdmin({ url: server.url, key: ADMIN_KEY });
      const result = await admin.createTenant({ name: "retry-net" });
      expect(posts).toBe(2);
      expect(bodies[0]).toBe(bodies[1]);
      expect(result.applicationKey).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await server.close();
    }
  });

  it("throws tenant_conflict on 409", async () => {
    const server = await startStubServer((request, response) => {
      if (request.url === "/health") {
        sendJson(response, 200, healthBody());
        return;
      }
      sendJson(response, 409, {
        status: "rejected",
        code: "tenant_conflict",
        message: "id taken",
      });
    });
    try {
      const admin = createAdmin({ url: server.url, key: ADMIN_KEY });
      await expect(admin.createTenant({ name: "x" })).rejects.toMatchObject({
        code: "tenant_conflict",
        status: 409,
      });
      await expect(admin.createTenant({ name: "x" })).rejects.toBeInstanceOf(
        AdminError,
      );
    } finally {
      await server.close();
    }
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
