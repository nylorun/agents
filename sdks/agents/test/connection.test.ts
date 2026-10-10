import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
const TENANT_LINK = {
  format: 3,
  tenant: "my-app",
  hostUrl: URL,
  hostId: "host_00000000000000000000000001",
  tenantId: TENANT,
};

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
      options.link ?? TENANT_LINK,
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
    const resolved = await resolveConnection({ url: URL, key: KEY });
    expect(resolved).toEqual({ url: URL, key: KEY, source: "options" });
  });

  it("fails when options are partial and names every source tried", async () => {
    await expect(resolveConnection({ url: URL })).rejects.toMatchObject({
      code: "connection_missing",
    });
    await expect(resolveConnection({ url: URL })).rejects.toThrow(
      /options.*environment.*project-link/s,
    );
  });

  it("uses the application key from a complete environment, which names no Tenant", async () => {
    process.env.NYLORUN_RUNTIME_URL = URL;
    process.env.NYLORUN_SERVER_KEY = KEY;
    const resolved = await resolveConnection();
    expect(resolved).toEqual({ url: URL, key: KEY, source: "environment" });
  });

  it("ignores NYLORUN_TENANT, which only nylorun reads", async () => {
    process.env.NYLORUN_TENANT = "tn_00000000000000000000000099";
    await expect(resolveConnection({ cwd: tmpdir() })).rejects.toMatchObject({
      code: "connection_missing",
    });
    process.env.NYLORUN_RUNTIME_URL = URL;
    process.env.NYLORUN_SERVER_KEY = KEY;
    expect(await resolveConnection()).toEqual({ url: URL, key: KEY, source: "environment" });
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

  it("never reads the project link for options or a complete environment", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "nylorun-conn-")));
    try {
      // A link that cannot be read (EISDIR here; EACCES for a root-owned file).
      await mkdir(join(root, ".nylorun", "link.json"), { recursive: true });
      expect(await resolveConnection({ url: URL, key: KEY, cwd: root })).toEqual({
        url: URL,
        key: KEY,
        source: "options",
      });
      process.env.NYLORUN_RUNTIME_URL = URL;
      process.env.NYLORUN_SERVER_KEY = KEY;
      expect(await resolveConnection({ cwd: root })).toEqual({
        url: URL,
        key: KEY,
        source: "environment",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("finds the project link from a nested directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "nylorun-conn-"));
    await writeProjectLink(root);
    const nested = join(root, "src", "deep");
    await mkdir(nested, { recursive: true });
    const resolved = await resolveConnection({ cwd: nested });
    expect(resolved).toEqual({ url: URL, key: KEY, source: "project-link" });
  });

  it("reads a format 3 link without a Tenant id and format-0 credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "nylorun-conn-"));
    await writeProjectLink(root, {
      link: { format: 3, tenant: "my-app", hostUrl: `${URL}/`, hostId: "host_1" },
      credentials: {
        applicationKey: KEY,
        principalId: "project",
        executors: { assistant: "d".repeat(64) },
      },
    });
    const resolved = await resolveConnection({ cwd: root });
    expect(resolved).toEqual({ url: URL, key: KEY, source: "project-link" });
  });

  it("refuses a link from an older nylorun (format 0 to 2), naming nylorun start", async () => {
    for (const format of [undefined, 0, 1, 2]) {
      const root = await realpath(await mkdtemp(join(tmpdir(), "nylorun-conn-")));
      await writeProjectLink(root, {
        link: {
          ...(format === undefined ? {} : { format }),
          ...(format === 2 ? { stack: "my-app" } : {}),
          hostUrl: URL,
          hostId: "host_00000000000000000000000001",
          tenantId: TENANT,
        },
      });
      const error = await resolveConnection({ cwd: root }).catch((e) => e);
      expect(error).toMatchObject({ code: "connection_missing" });
      expect(String(error.message)).toBe(
        `connection_missing: the Project link at ${join(root, ".nylorun", "link.json")} is from an older nylorun. ` +
          `Run "npx nylorun start" in this project to link it again.`,
      );
    }
  });

  it("refuses a link without credentials, and a broken link, with connection_missing", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "nylorun-conn-")));
    try {
      await writeProjectLink(root);
      await rm(join(root, ".nylorun", "credentials.json"));
      const error = await resolveConnection({ cwd: root }).catch((e) => e);
      expect(error).toMatchObject({ code: "connection_missing" });
      expect(String(error.message)).toMatch(/has a link but no credentials/);
      await writeFile(join(root, ".nylorun", "link.json"), "{");
      const broken = await resolveConnection({ cwd: root }).catch((e) => e);
      expect(broken).toMatchObject({ code: "connection_missing" });
      expect(String(broken.message)).toContain(
        `Invalid Project link at ${join(root, ".nylorun", "link.json")}`,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never reads a link at or above the home directory", async () => {
    const above = await realpath(await mkdtemp(join(tmpdir(), "nylorun-conn-home-")));
    const home = join(above, "home");
    const previous = process.env.HOME;
    try {
      await writeProjectLink(above);
      await mkdir(join(home, "code"), { recursive: true });
      process.env.HOME = home;
      await expect(resolveConnection({ cwd: join(home, "code") })).rejects.toMatchObject({
        code: "connection_missing",
      });
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
      await rm(above, { recursive: true, force: true });
    }
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
      expect(client.transport.key).toBe(KEY);
    } finally {
      process.chdir(previous);
    }
  });

  it("keeps explicit destination behavior synchronous", () => {
    const client = createClient({ url: URL, key: KEY });
    expect(client.transport.url).toBe(URL);
    expect(client.transport.key).toBe(KEY);
  });

  it("keeps environment resolution for explicit-partial destinations", () => {
    process.env.NYLORUN_SERVER_KEY = KEY;
    const client = createClient({ url: URL });
    expect(client.transport.key).toBe(KEY);
  });
});

describe("compatibility re-exports (C7)", () => {
  it("re-exports PROTOCOL_FEATURES, ERROR_CODES, ErrorCode and compareVersions", () => {
    expect(PROTOCOL_FEATURES).toContain("management-api");
    expect(ERROR_CODES).toContain("connection_missing");
    expect(compareVersions("1.0.0", "1.0.1")).toBe(-1);
  });
});
