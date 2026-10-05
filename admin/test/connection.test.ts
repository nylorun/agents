import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createAdmin, AdminError, tenantHostRoot } from "../src/index.js";
import {
  MANAGEMENT_KEY,
  healthBody,
  sampleTenantStatus,
  startStubServer,
  writeCredentials,
  writeLocalHost,
} from "./helpers.js";

const ENV = ["NYLORUN_RUNTIME_URL", "NYLORUN_MANAGEMENT_KEY", "NYLORUN_HOME", "NYLORUN_TENANT", "HOME"];
const saved: Record<string, string | undefined> = {};
for (const name of ENV) saved[name] = process.env[name];

function clearEnv() {
  for (const name of ENV) if (name !== "HOME") delete process.env[name];
}

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** A Runtime stub that records the bearer of every Management API request. */
async function stub() {
  const bearers: (string | undefined)[] = [];
  const server = await startStubServer((request, response) => {
    if (request.url !== "/health") bearers.push(request.headers.authorization);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.url === "/health" ? healthBody() : sampleTenantStatus()));
  });
  return { ...server, bearers, port: Number(new URL(server.url).port) };
}

const missing = (run: () => unknown): AdminError => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AdminError);
    expect((error as AdminError).code).toBe("connection_missing");
    return error as AdminError;
  }
  throw new Error("expected connection_missing");
};

describe("createAdmin connection resolution", () => {
  it("prefers explicit options over the environment and the local Host", async () => {
    clearEnv();
    process.env.NYLORUN_RUNTIME_URL = "http://127.0.0.1:1";
    process.env.NYLORUN_MANAGEMENT_KEY = "e".repeat(64);
    const server = await stub();
    try {
      const home = await writeLocalHost({ port: 9 });
      const admin = createAdmin({ url: server.url, key: MANAGEMENT_KEY, home });
      expect(admin.source).toBe("options");
      expect(admin.url).toBe(server.url);
      await admin.tenant.status();
      expect(server.bearers).toEqual([`Bearer ${MANAGEMENT_KEY}`]);
    } finally {
      await server.close();
    }
  });

  it("uses NYLORUN_RUNTIME_URL and NYLORUN_MANAGEMENT_KEY when options are omitted", async () => {
    clearEnv();
    const server = await stub();
    try {
      process.env.NYLORUN_RUNTIME_URL = server.url;
      process.env.NYLORUN_MANAGEMENT_KEY = "e".repeat(64);
      const admin = createAdmin();
      expect(admin.source).toBe("environment");
      expect(admin.url).toBe(server.url);
      await admin.tenant.status();
      expect(server.bearers).toEqual([`Bearer ${"e".repeat(64)}`]);
    } finally {
      await server.close();
    }
  });

  it("leaves NYLORUN_RUNTIME_URL alone (an app's) to the local Host, and needs it with the key", async () => {
    clearEnv();
    const server = await stub();
    try {
      process.env.NYLORUN_RUNTIME_URL = "http://127.0.0.1:1";
      const home = await writeLocalHost({ port: server.port });
      const admin = createAdmin({ home });
      expect(admin.source).toBe("local-host");
      expect(admin.url).toBe(server.url);

      delete process.env.NYLORUN_RUNTIME_URL;
      process.env.NYLORUN_MANAGEMENT_KEY = "e".repeat(64);
      expect(missing(() => createAdmin({ home })).message).toMatch(
        /NYLORUN_MANAGEMENT_KEY needs NYLORUN_RUNTIME_URL/,
      );
    } finally {
      await server.close();
    }
  });

  it("falls back to the local Host: host.json and project-credentials.json, else cli-credentials.json", async () => {
    clearEnv();
    const server = await stub();
    try {
      const home = await writeLocalHost({ port: server.port, format: 1 });
      const admin = createAdmin({ home });
      expect(admin.source).toBe("local-host");
      expect(admin.url).toBe(`http://127.0.0.1:${server.port}`);
      await admin.tenant.status();

      const cli = await writeLocalHost({
        port: server.port,
        credentialsFile: "cli-credentials.json",
        managementKey: "c".repeat(64),
      });
      await createAdmin({ home: cli }).tenant.status();
      expect(server.bearers).toEqual([`Bearer ${MANAGEMENT_KEY}`, `Bearer ${"c".repeat(64)}`]);
    } finally {
      await server.close();
    }
  });

  it("accepts format 0 host.json (missing format field)", async () => {
    clearEnv();
    const server = await stub();
    try {
      const home = await writeLocalHost({ port: server.port });
      const admin = createAdmin({ home });
      expect(admin.source).toBe("local-host");
      await admin.tenant.status();
    } finally {
      await server.close();
    }
  });

  it("fails a partial options pair and names every source tried", () => {
    clearEnv();
    const message = missing(() => createAdmin({ url: "http://127.0.0.1:8787" })).message;
    expect(message).toMatch(/options/i);
    expect(message).toMatch(/NYLORUN_RUNTIME_URL/);
    expect(message).toMatch(/NYLORUN_MANAGEMENT_KEY/);
    expect(message).toMatch(/local Host/);
  });

  it("throws connection_missing naming every source when nothing resolves", async () => {
    clearEnv();
    process.env.NYLORUN_HOME = "/tmp/nylorun-admin-missing-home-xyz";
    const message = missing(() => createAdmin()).message;
    expect(message).toMatch(/options/i);
    expect(message).toMatch(/NYLORUN_MANAGEMENT_KEY/);
    expect(message).toMatch(/host\.json under \/tmp\/nylorun-admin-missing-home-xyz/);

    // A Host root without a management key names where it looked for one.
    const home = await writeLocalHost({ port: 8787, credentialsFile: null });
    expect(missing(() => createAdmin({ home })).message).toMatch(
      /project-credentials\.json or\s+cli-credentials\.json/,
    );
  });
});

describe("local Tenants", () => {
  it("reads the linked Project's management key, before its Host root's", async () => {
    clearEnv();
    const server = await stub();
    const temporary = await realpath(await mkdtemp(join(tmpdir(), "nylorun-admin-link-")));
    try {
      // The Tenant's Host root under a home of the test's own: ~/.nylorun/tenants/my-app.
      process.env.HOME = join(temporary, "home");
      const root = tenantHostRoot("my-app");
      expect(root).toBe(join(temporary, "home", ".nylorun", "tenants", "my-app"));
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "host.json"), JSON.stringify({ host: "127.0.0.1", port: server.port }));
      await writeCredentials(join(root, "project-credentials.json"), "a".repeat(64));

      const project = join(temporary, "project");
      await mkdir(join(project, ".nylorun"), { recursive: true });
      await mkdir(join(project, "src"));
      await writeFile(
        join(project, ".nylorun", "link.json"),
        JSON.stringify({ format: 3, tenant: "my-app", hostUrl: server.url, hostId: "h" }),
      );
      await writeCredentials(join(project, ".nylorun", "credentials.json"), "f".repeat(64));

      const admin = createAdmin({ cwd: join(project, "src") });
      expect(admin.source).toBe("local-host");
      expect(admin.url).toBe(server.url);
      await admin.tenant.status();
      // A Project whose credentials hold no management key uses the Host root's.
      await writeFile(
        join(project, ".nylorun", "credentials.json"),
        JSON.stringify({ format: 1, applicationKey: "b".repeat(64), principalId: "project" }),
        { mode: 0o600 },
      );
      await createAdmin({ cwd: project }).tenant.status();
      // Another Host root named explicitly does not take the Project's key.
      await writeCredentials(join(project, ".nylorun", "credentials.json"), "f".repeat(64));
      const other = await writeLocalHost({ port: server.port, managementKey: "c".repeat(64) });
      await createAdmin({ cwd: project, home: other }).tenant.status();
      expect(server.bearers).toEqual([
        `Bearer ${"f".repeat(64)}`,
        `Bearer ${"a".repeat(64)}`,
        `Bearer ${"c".repeat(64)}`,
      ]);
    } finally {
      await server.close();
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("names the Host root of the Tenant a Project link names when it is missing", async () => {
    clearEnv();
    const project = await mkdtemp(join(tmpdir(), "nylorun-admin-project-"));
    try {
      await mkdir(join(project, ".nylorun"));
      await writeFile(
        join(project, ".nylorun", "link.json"),
        JSON.stringify({ format: 3, tenant: "admin-test-missing-tenant", hostUrl: "http://127.0.0.1:1", hostId: "h" }),
      );
      await mkdir(join(project, "src"));
      expect(() => createAdmin({ cwd: join(project, "src") })).toThrow(
        tenantHostRoot("admin-test-missing-tenant"),
      );
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("refuses a Project link from an older nylorun, unless something else names the Host", async () => {
    clearEnv();
    const project = await realpath(await mkdtemp(join(tmpdir(), "nylorun-admin-project-")));
    try {
      await mkdir(join(project, ".nylorun"));
      const linkPath = join(project, ".nylorun", "link.json");
      await writeFile(
        linkPath,
        JSON.stringify({ format: 2, stack: "my-app", hostUrl: "http://127.0.0.1:1", hostId: "h" }),
      );
      expect(() => createAdmin({ cwd: project })).toThrow(
        `The Project link at ${linkPath} is from an older nylorun. Run "npx nylorun start" in this project to link it again.`,
      );
      expect(() => createAdmin({ cwd: project, tenant: "one" })).toThrow(tenantHostRoot("one"));
      expect(createAdmin({ cwd: project, url: "http://127.0.0.1:1", key: MANAGEMENT_KEY }).source).toBe(
        "options",
      );
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it("prefers the tenant option, then NYLORUN_TENANT, and NYLORUN_HOME over both", () => {
    clearEnv();
    expect(() => createAdmin({ tenant: "one" })).toThrow(tenantHostRoot("one"));
    process.env.NYLORUN_TENANT = "two";
    expect(() => createAdmin()).toThrow(tenantHostRoot("two"));
    expect(() => createAdmin({ tenant: "one" })).toThrow(tenantHostRoot("one"));
    process.env.NYLORUN_HOME = "/tmp/nylorun-admin-missing-home-xyz";
    expect(() => createAdmin({ tenant: "one" })).toThrow("/tmp/nylorun-admin-missing-home-xyz");
  });

  it("names how to pick a Tenant when nothing names one", async () => {
    clearEnv();
    const outside = await mkdtemp(join(tmpdir(), "nylorun-admin-outside-"));
    try {
      expect(() => createAdmin({ cwd: outside })).toThrow(/NYLORUN_TENANT/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("puts a Tenant's Host root under ~/.nylorun/tenants", () => {
    expect(tenantHostRoot("my-app")).toBe(join(homedir(), ".nylorun", "tenants", "my-app"));
  });
});

describe("local credentials permissions", () => {
  it("rejects a group- or world-readable credentials file on POSIX", async () => {
    if (process.platform === "win32") return;
    clearEnv();
    const home = await writeLocalHost({ port: 8787, credentialsMode: 0o640 });
    expect(missing(() => createAdmin({ home })).message).toMatch(
      /project-credentials\.json is group- or world-readable/,
    );
  });
});
