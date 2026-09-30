import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "../src/client.js";
import { resolveConnection } from "../src/connection.js";
import {
  ERROR_CODES,
  PROTOCOL_FEATURES,
  compareVersions,
} from "../src/index.js";

const TENANT = "tn_00000000000000000000000001";
const KEY = "a".repeat(64);
const URL = "http://127.0.0.1:8787";

const envKeys = [
  "NYLORUN_RUNTIME_URL",
  "NYLORUN_TENANT",
  "NYLORUN_SERVER_KEY",
] as const;

afterEach(() => {
  for (const key of envKeys) delete process.env[key];
});

async function writeProjectLink(
  root: string,
  options: {
    link?: Record<string, unknown>;
    credentials?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const dir = join(root, ".nylorun");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(dir, "link.json"),
    JSON.stringify(
      options.link ?? {
        format: 1,
        hostUrl: URL,
        hostId: "host_00000000000000000000000001",
        tenantId: TENANT,
      },
    ),
    { mode: 0o600 },
  );
  await writeFile(
    join(dir, "credentials.json"),
    JSON.stringify(
      options.credentials ?? {
        format: 1,
        applicationKey: KEY,
        principalId: "pr_00000000000000000000000001",
      },
    ),
    { mode: 0o600 },
  );
  return root;
}

describe("resolveConnection (C1)", () => {
  it("uses explicit options and never mixes with environment", async () => {
    process.env.NYLORUN_RUNTIME_URL = "http://env.example";
    process.env.NYLORUN_TENANT = "tn_00000000000000000000000099";
    process.env.NYLORUN_SERVER_KEY = "b".repeat(64);
    const resolved = await resolveConnection({
      url: URL,
      tenant: TENANT,
      key: KEY,
    });
    expect(resolved).toEqual({
      url: URL,
      tenant: TENANT,
      key: KEY,
      source: "options",
    });
  });

  it("fails when options are partial and names every source tried", async () => {
    await expect(
      resolveConnection({ url: URL, tenant: TENANT }),
    ).rejects.toMatchObject({
      code: "connection_missing",
    });
    await expect(resolveConnection({ url: URL, tenant: TENANT })).rejects.toThrow(
      /options.*environment.*project-link/s,
    );
  });

  it("uses the application key from a complete environment", async () => {
    process.env.NYLORUN_RUNTIME_URL = URL;
    process.env.NYLORUN_TENANT = TENANT;
    process.env.NYLORUN_SERVER_KEY = KEY;
    const resolved = await resolveConnection();
    expect(resolved).toEqual({
      url: URL,
      tenant: TENANT,
      key: KEY,
      source: "environment",
    });
  });

  it("ignores the removed NYLORUN_EXECUTOR_KEY", async () => {
    const root = await mkdtemp(join(tmpdir(), "nylorun-conn-"));
    await writeProjectLink(root);
    process.env.NYLORUN_EXECUTOR_KEY = "c".repeat(64);
    try {
      const resolved = await resolveConnection({ cwd: root });
      expect(resolved).toMatchObject({ key: KEY, source: "project-link" });
    } finally {
      delete process.env.NYLORUN_EXECUTOR_KEY;
    }
  });

  it("fails on a partial environment without reading a project link", async () => {
    const root = await mkdtemp(join(tmpdir(), "nylorun-conn-"));
    await writeProjectLink(root);
    process.env.NYLORUN_RUNTIME_URL = URL;
    await expect(resolveConnection({ cwd: root })).rejects.toMatchObject({
      code: "connection_missing",
    });
    await expect(resolveConnection({ cwd: root })).rejects.toThrow(
      /environment/i,
    );
  });

  it("finds the project link from a nested directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "nylorun-conn-"));
    await writeProjectLink(root);
    const nested = join(root, "src", "deep");
    await mkdir(nested, { recursive: true });
    const resolved = await resolveConnection({ cwd: nested });
    expect(resolved).toEqual({
      url: URL,
      tenant: TENANT,
      key: KEY,
      source: "project-link",
    });
  });

  it("reads format-0 link and credentials (missing format defaults to 0)", async () => {
    const root = await mkdtemp(join(tmpdir(), "nylorun-conn-"));
    await writeProjectLink(root, {
      link: {
        hostUrl: `${URL}/`,
        hostId: "host_00000000000000000000000001",
        tenantId: TENANT,
      },
      credentials: {
        applicationKey: KEY,
        principalId: "pr_00000000000000000000000001",
        executors: { assistant: "d".repeat(64) },
      },
    });
    const resolved = await resolveConnection({ cwd: root });
    expect(resolved.source).toBe("project-link");
    expect(resolved.url).toBe(URL);
    expect(resolved.key).toBe(KEY);
  });

  it("names every source tried when nothing resolves", async () => {
    const root = await mkdtemp(join(tmpdir(), "nylorun-conn-empty-"));
    await expect(resolveConnection({ cwd: root })).rejects.toMatchObject({
      code: "connection_missing",
    });
    const error = await resolveConnection({ cwd: root }).catch((e) => e);
    expect(String(error.message)).toMatch(/options/i);
    expect(String(error.message)).toMatch(/environment/i);
    expect(String(error.message)).toMatch(/project-link/i);
  });
});

describe("createClient (C2)", () => {
  it("with no arguments uses resolveConnection (project-link)", async () => {
    const root = await mkdtemp(join(tmpdir(), "nylorun-client-"));
    await writeProjectLink(root);
    const previous = process.cwd();
    process.chdir(root);
    try {
      const client = await createClient();
      expect(client.transport.url).toBe(URL);
      expect(client.transport.tenant).toBe(TENANT);
      expect(client.transport.key).toBe(KEY);
    } finally {
      process.chdir(previous);
    }
  });

  it("keeps explicit destination behavior synchronous", () => {
    const client = createClient({
      url: URL,
      key: KEY,
      tenant: TENANT,
    });
    expect(client.transport.tenant).toBe(TENANT);
  });

  it("keeps environment resolution for explicit-partial destinations", () => {
    process.env.NYLORUN_TENANT = TENANT;
    const client = createClient({ url: URL, key: KEY });
    expect(client.transport.tenant).toBe(TENANT);
  });
});

describe("compatibility re-exports (C7)", () => {
  it("re-exports PROTOCOL_FEATURES, ERROR_CODES, ErrorCode and compareVersions", () => {
    expect(PROTOCOL_FEATURES).toContain("admin-status");
    expect(ERROR_CODES).toContain("connection_missing");
    expect(compareVersions("1.0.0", "1.0.1")).toBe(-1);
  });
});
