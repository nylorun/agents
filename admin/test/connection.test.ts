import { afterEach, describe, expect, it } from "vitest";
import { createAdmin, AdminError } from "../src/index.js";
import {
  ADMIN_KEY,
  healthBody,
  startStubServer,
  writeLocalHost,
} from "./helpers.js";

const saved: Record<string, string | undefined> = {};

function stashEnv(...names: string[]) {
  for (const name of names) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
}

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const key of Object.keys(saved)) delete saved[key];
});

describe("B1 createAdmin connection resolution", () => {
  it("prefers explicit options over environment and local Host", async () => {
    stashEnv("NYLORUN_ADMIN_URL", "NYLORUN_ADMIN_KEY", "NYLORUN_HOME");
    process.env.NYLORUN_ADMIN_URL = "http://127.0.0.1:1";
    process.env.NYLORUN_ADMIN_KEY = "e".repeat(64);
    const server = await startStubServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(healthBody()));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([]));
    });
    try {
      const home = await writeLocalHost({ port: 9 });
      const admin = createAdmin({
        url: server.url,
        key: ADMIN_KEY,
        home,
      });
      expect(admin.source).toBe("options");
      expect(admin.url).toBe(server.url);
      await admin.listTenants();
    } finally {
      await server.close();
    }
  });

  it("uses environment when options are omitted", async () => {
    stashEnv("NYLORUN_ADMIN_URL", "NYLORUN_ADMIN_KEY", "NYLORUN_HOME");
    const server = await startStubServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(healthBody()));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([]));
    });
    try {
      process.env.NYLORUN_ADMIN_URL = server.url;
      process.env.NYLORUN_ADMIN_KEY = ADMIN_KEY;
      const admin = createAdmin();
      expect(admin.source).toBe("environment");
      expect(admin.url).toBe(server.url);
      await admin.listTenants();
    } finally {
      await server.close();
    }
  });

  it("falls back to local Host host.json and host-credentials.json", async () => {
    stashEnv("NYLORUN_ADMIN_URL", "NYLORUN_ADMIN_KEY", "NYLORUN_HOME");
    const server = await startStubServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(healthBody()));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([]));
    });
    try {
      const port = Number(new URL(server.url).port);
      const home = await writeLocalHost({ port, format: 1 });
      const admin = createAdmin({ home });
      expect(admin.source).toBe("local-host");
      expect(admin.url).toBe(`http://127.0.0.1:${port}`);
      await admin.listTenants();
    } finally {
      await server.close();
    }
  });

  it("sends Admin API requests to the operator port when host.json names one", async () => {
    stashEnv("NYLORUN_ADMIN_URL", "NYLORUN_ADMIN_KEY", "NYLORUN_HOME");
    const seen: string[] = [];
    const server = await startStubServer((request, response) => {
      seen.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(request.url === "/health" ? healthBody() : []));
    });
    try {
      const adminPort = Number(new URL(server.url).port);
      const home = await writeLocalHost({ port: 1, adminPort, format: 1 });
      const admin = createAdmin({ home });
      // The Tenant API stays on `port`; only admin requests move.
      expect(admin.url).toBe("http://127.0.0.1:1");
      expect(admin.adminUrl).toBe(`http://127.0.0.1:${adminPort}`);
      await admin.listTenants();
      expect(seen).toContain("/v1/admin/tenants");
    } finally {
      await server.close();
    }
  });

  it("accepts format 0 host.json (missing format field)", async () => {
    stashEnv("NYLORUN_ADMIN_URL", "NYLORUN_ADMIN_KEY");
    const server = await startStubServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(healthBody()));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([]));
    });
    try {
      const port = Number(new URL(server.url).port);
      const home = await writeLocalHost({ port });
      const admin = createAdmin({ home });
      expect(admin.source).toBe("local-host");
      await admin.listTenants();
    } finally {
      await server.close();
    }
  });

  it("fails a partial options pair and names every source tried", () => {
    stashEnv("NYLORUN_ADMIN_URL", "NYLORUN_ADMIN_KEY", "NYLORUN_HOME");
    expect(() => createAdmin({ url: "http://127.0.0.1:8787" })).toThrow(
      AdminError,
    );
    try {
      createAdmin({ url: "http://127.0.0.1:8787" });
    } catch (error) {
      expect(error).toBeInstanceOf(AdminError);
      expect((error as AdminError).code).toBe("connection_missing");
      const message = (error as AdminError).message;
      expect(message).toMatch(/options/i);
      expect(message).toMatch(/NYLORUN_ADMIN_URL/);
      expect(message).toMatch(/NYLORUN_ADMIN_KEY/);
      expect(message).toMatch(/local Host|host\.json|local-host/i);
    }
  });

  it("fails a partial environment pair and names every source tried", () => {
    stashEnv("NYLORUN_ADMIN_URL", "NYLORUN_ADMIN_KEY", "NYLORUN_HOME");
    process.env.NYLORUN_ADMIN_URL = "http://127.0.0.1:8787";
    expect(() => createAdmin()).toThrow(AdminError);
    try {
      createAdmin();
    } catch (error) {
      expect(error).toBeInstanceOf(AdminError);
      expect((error as AdminError).code).toBe("connection_missing");
      const message = (error as AdminError).message;
      expect(message).toMatch(/options/i);
      expect(message).toMatch(/NYLORUN_ADMIN_URL/);
      expect(message).toMatch(/NYLORUN_ADMIN_KEY/);
      expect(message).toMatch(/local Host|host\.json|local-host/i);
    }
  });

  it("throws connection_missing naming every source when nothing resolves", () => {
    stashEnv("NYLORUN_ADMIN_URL", "NYLORUN_ADMIN_KEY", "NYLORUN_HOME");
    process.env.NYLORUN_HOME = "/tmp/nylorun-admin-missing-home-xyz";
    expect(() => createAdmin()).toThrow(AdminError);
    try {
      createAdmin();
    } catch (error) {
      expect(error).toBeInstanceOf(AdminError);
      expect((error as AdminError).code).toBe("connection_missing");
      const message = (error as AdminError).message;
      expect(message).toMatch(/options/i);
      expect(message).toMatch(/NYLORUN_ADMIN_URL/);
      expect(message).toMatch(/local Host|host\.json|local-host/i);
    }
  });
});

describe("B2 local Host credentials permissions", () => {
  it("rejects a group- or world-readable credentials file on POSIX", async () => {
    if (process.platform === "win32") return;
    stashEnv("NYLORUN_ADMIN_URL", "NYLORUN_ADMIN_KEY");
    const home = await writeLocalHost({
      port: 8787,
      credentialsMode: 0o640,
    });
    expect(() => createAdmin({ home })).toThrow(AdminError);
    try {
      createAdmin({ home });
    } catch (error) {
      expect(error).toBeInstanceOf(AdminError);
      expect((error as AdminError).code).toBe("connection_missing");
      expect((error as AdminError).message).toMatch(
        /host-credentials|readable|permission/i,
      );
    }
  });
});
