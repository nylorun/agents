import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createAdmin, AdminError, stackHostRoot } from "../src/index.js";
import {
  ADMIN_KEY,
  healthBody,
  sampleStatus,
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
    stashEnv("NYLORUN_ADMIN_URL", "NYLORUN_ADMIN_KEY", "NYLORUN_HOME", "NYLORUN_STACK");
    process.env.NYLORUN_ADMIN_URL = "http://127.0.0.1:1";
    process.env.NYLORUN_ADMIN_KEY = "e".repeat(64);
    const server = await startStubServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(healthBody()));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(sampleStatus()));
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
      await admin.status();
    } finally {
      await server.close();
    }
  });

  it("uses environment when options are omitted", async () => {
    stashEnv("NYLORUN_ADMIN_URL", "NYLORUN_ADMIN_KEY", "NYLORUN_HOME", "NYLORUN_STACK");
    const server = await startStubServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(healthBody()));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(sampleStatus()));
    });
    try {
      process.env.NYLORUN_ADMIN_URL = server.url;
      process.env.NYLORUN_ADMIN_KEY = ADMIN_KEY;
      const admin = createAdmin();
      expect(admin.source).toBe("environment");
      expect(admin.url).toBe(server.url);
      await admin.status();
    } finally {
      await server.close();
    }
  });

  it("falls back to local Host host.json and host-credentials.json", async () => {
    stashEnv("NYLORUN_ADMIN_URL", "NYLORUN_ADMIN_KEY", "NYLORUN_HOME", "NYLORUN_STACK");
    const server = await startStubServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(healthBody()));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(sampleStatus()));
    });
    try {
      const port = Number(new URL(server.url).port);
      const home = await writeLocalHost({ port, format: 1 });
      const admin = createAdmin({ home });
      expect(admin.source).toBe("local-host");
      expect(admin.url).toBe(`http://127.0.0.1:${port}`);
      await admin.status();
    } finally {
      await server.close();
    }
  });

  it("sends Admin API requests to the operator port when host.json names one", async () => {
    stashEnv("NYLORUN_ADMIN_URL", "NYLORUN_ADMIN_KEY", "NYLORUN_HOME", "NYLORUN_STACK");
    const seen: string[] = [];
    const server = await startStubServer((request, response) => {
      seen.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(request.url === "/health" ? healthBody() : sampleStatus()));
    });
    try {
      const adminPort = Number(new URL(server.url).port);
      const home = await writeLocalHost({ port: 1, adminPort, format: 1 });
      const admin = createAdmin({ home });
      // The Tenant API stays on `port`; only admin requests move.
      expect(admin.url).toBe("http://127.0.0.1:1");
      expect(admin.adminUrl).toBe(`http://127.0.0.1:${adminPort}`);
      await admin.status();
      expect(seen).toContain("/v1/admin/status");
    } finally {
      await server.close();
    }
  });

  it("accepts format 0 host.json (missing format field)", async () => {
    stashEnv("NYLORUN_ADMIN_URL", "NYLORUN_ADMIN_KEY", "NYLORUN_STACK");
    const server = await startStubServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(healthBody()));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(sampleStatus()));
    });
    try {
      const port = Number(new URL(server.url).port);
      const home = await writeLocalHost({ port });
      const admin = createAdmin({ home });
      expect(admin.source).toBe("local-host");
      await admin.status();
    } finally {
      await server.close();
    }
  });

  it("fails a partial options pair and names every source tried", () => {
    stashEnv("NYLORUN_ADMIN_URL", "NYLORUN_ADMIN_KEY", "NYLORUN_HOME", "NYLORUN_STACK");
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
    stashEnv("NYLORUN_ADMIN_URL", "NYLORUN_ADMIN_KEY", "NYLORUN_HOME", "NYLORUN_STACK");
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
    stashEnv("NYLORUN_ADMIN_URL", "NYLORUN_ADMIN_KEY", "NYLORUN_HOME", "NYLORUN_STACK");
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

describe("B3 local stacks", () => {
  it("reads the Host root of the stack a Project link names", async () => {
    stashEnv("NYLORUN_ADMIN_URL", "NYLORUN_ADMIN_KEY", "NYLORUN_HOME", "NYLORUN_STACK");
    const project = await mkdtemp(join(tmpdir(), "nylorun-admin-project-"));
    try {
      await mkdir(join(project, ".nylorun"));
      await writeFile(
        join(project, ".nylorun", "link.json"),
        JSON.stringify({ format: 2, stack: "admin-test-missing-stack", hostUrl: "http://127.0.0.1:1", hostId: "h" }),
      );
      await mkdir(join(project, "src"));
      // The stack's Host root does not exist: the message names where it looked.
      expect(() => createAdmin({ cwd: join(project, "src") })).toThrow(
        stackHostRoot("admin-test-missing-stack"),
      );
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("prefers the stack option, then NYLORUN_STACK, and NYLORUN_HOME over both", () => {
    stashEnv("NYLORUN_ADMIN_URL", "NYLORUN_ADMIN_KEY", "NYLORUN_HOME", "NYLORUN_STACK");
    expect(() => createAdmin({ stack: "one" })).toThrow(stackHostRoot("one"));
    process.env.NYLORUN_STACK = "two";
    expect(() => createAdmin()).toThrow(stackHostRoot("two"));
    expect(() => createAdmin({ stack: "one" })).toThrow(stackHostRoot("one"));
    process.env.NYLORUN_HOME = "/tmp/nylorun-admin-missing-home-xyz";
    expect(() => createAdmin({ stack: "one" })).toThrow("/tmp/nylorun-admin-missing-home-xyz");
  });

  it("names how to pick a stack when nothing names one", async () => {
    stashEnv("NYLORUN_ADMIN_URL", "NYLORUN_ADMIN_KEY", "NYLORUN_HOME", "NYLORUN_STACK");
    const outside = await mkdtemp(join(tmpdir(), "nylorun-admin-outside-"));
    try {
      expect(() => createAdmin({ cwd: outside })).toThrow(/NYLORUN_STACK/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("puts a stack's Host root under ~/.nylorun/stacks", () => {
    expect(stackHostRoot("my-app")).toBe(join(homedir(), ".nylorun", "stacks", "my-app"));
  });
});

describe("B2 local Host credentials permissions", () => {
  it("rejects a group- or world-readable credentials file on POSIX", async () => {
    if (process.platform === "win32") return;
    stashEnv("NYLORUN_ADMIN_URL", "NYLORUN_ADMIN_KEY", "NYLORUN_STACK");
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
