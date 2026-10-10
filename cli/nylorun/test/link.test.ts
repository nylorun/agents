import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectCredentialsFileSchema } from "@nylorun/core/contracts";
import {
  readProjectCredentials,
  readProjectLink,
  writeProjectCredentials,
  writeProjectLink,
} from "../src/project/link.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(link?: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nylorun-link-"));
  roots.push(root);
  await writeFile(join(root, "package.json"), "{}");
  if (link !== undefined) {
    await mkdir(join(root, ".nylorun"));
    await writeFile(
      join(root, ".nylorun", "link.json"),
      typeof link === "string" ? link : JSON.stringify(link),
    );
  }
  return root;
}

const mode = async (path: string) => (await stat(path)).mode & 0o777;

describe("the Project link", () => {
  it("reads a format 3 link: the Tenant's name, its URL and Host, and the Tenant id as information", async () => {
    const root = await project({
      format: 3,
      tenant: "shop",
      hostUrl: "http://localhost:8787/",
      hostId: "host_x",
      tenantId: "tn_x",
    });
    expect(await readProjectLink(root)).toEqual({
      format: 3,
      tenant: "shop",
      hostUrl: "http://localhost:8787",
      hostId: "host_x",
      tenantId: "tn_x",
    });
  });

  it("reads an older link (format 0 to 2) as such, without a Tenant, so start replaces it", async () => {
    const root = await project({ format: 1, hostUrl: "http://localhost:8787", hostId: "host_x", tenantId: "tn_x" });
    expect(await readProjectLink(root)).toMatchObject({ format: 1, tenantId: "tn_x" });
    const two = await project({ format: 2, stack: "shop", hostUrl: "http://localhost:8787", hostId: "host_x" });
    expect(await readProjectLink(two)).toEqual({ format: 2, hostUrl: "http://localhost:8787", hostId: "host_x" });
    const legacy = await project({ hostUrl: "http://localhost:8787", hostId: "host_x", tenantId: "tn_x" });
    expect((await readProjectLink(legacy))?.format).toBe(0);
  });

  it("is undefined without a link, and an error for a broken or newer one", async () => {
    expect(await readProjectLink(await project())).toBeUndefined();
    await expect(readProjectLink(await project("{"))).rejects.toThrow(/Invalid or newer Project link/);
    await expect(
      readProjectLink(await project({ format: 4, hostUrl: "h", hostId: "x" })),
    ).rejects.toThrow(/Upgrade nylorun/);
  });

  it("writes link.json and credentials.json (0600) in a private .nylorun/ ignored by git", async () => {
    const root = await project();
    await writeProjectLink(root, {
      tenant: "shop",
      hostUrl: "http://localhost:8787/",
      hostId: "host_x",
      tenantId: "tn_x",
    });
    await writeProjectCredentials(root, { applicationKey: "ab".repeat(32), principalId: "project" });
    const dir = join(root, ".nylorun");
    expect(JSON.parse(await readFile(join(dir, "link.json"), "utf8"))).toEqual({
      format: 3,
      tenant: "shop",
      hostUrl: "http://localhost:8787",
      hostId: "host_x",
      tenantId: "tn_x",
    });
    expect(JSON.parse(await readFile(join(dir, "credentials.json"), "utf8"))).toEqual({
      format: 1,
      applicationKey: "ab".repeat(32),
      principalId: "project",
    });
    expect(await readProjectCredentials(root)).toEqual({
      applicationKey: "ab".repeat(32),
      principalId: "project",
    });
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe("*\n");
    expect(await mode(dir)).toBe(0o700);
    expect(await mode(join(dir, "link.json"))).toBe(0o600);
    expect(await mode(join(dir, "credentials.json"))).toBe(0o600);
  });

  it("keeps both keys in credentials.json, still format 1, and reads a file with one", async () => {
    const root = await project();
    const credentials = {
      applicationKey: "ab".repeat(32),
      principalId: "project",
      management: { key: "cd".repeat(32), principalId: "project-management" },
    };
    await writeProjectCredentials(root, credentials);
    const file = join(root, ".nylorun", "credentials.json");
    const written = JSON.parse(await readFile(file, "utf8"));
    expect(written).toEqual({
      format: 1,
      applicationKey: "ab".repeat(32),
      principalId: "project",
      managementKey: "cd".repeat(32),
      managementPrincipalId: "project-management",
    });
    // Readers that predate management keys (the schema @nylorun/agents parses) still accept it.
    expect(ProjectCredentialsFileSchema.parse(written).applicationKey).toBe("ab".repeat(32));
    expect(await readProjectCredentials(root)).toEqual(credentials);
    // A file from before management keys has none.
    await writeFile(file, JSON.stringify({ format: 1, applicationKey: "ab".repeat(32), principalId: "project" }));
    expect(await readProjectCredentials(root)).toEqual({
      applicationKey: "ab".repeat(32),
      principalId: "project",
    });
  });

  it("reads broken credentials as none, so start replaces them, and refuses newer ones", async () => {
    const root = await project();
    await mkdir(join(root, ".nylorun"));
    const file = join(root, ".nylorun", "credentials.json");
    await writeFile(file, "{");
    expect(await readProjectCredentials(root)).toBeUndefined();
    await writeFile(file, JSON.stringify({ format: 2, applicationKey: "ab".repeat(32), principalId: "project" }));
    await expect(readProjectCredentials(root)).rejects.toThrow(
      `Newer credentials at ${file}. Upgrade nylorun, or remove the file and run "npx nylorun start" again.`,
    );
  });
});
