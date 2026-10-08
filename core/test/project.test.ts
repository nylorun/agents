import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProjectFileError,
  findLinkedProject,
  findLinkedProjectRoot,
  findProjectRoot,
  nylorunHome,
  readCredentialsFile,
  readProjectCredentials,
  readProjectLink,
  tenantHostRoot,
} from "../src/project.js";

const KEY = "a".repeat(64);
const roots: string[] = [];
async function temporary(prefix = "nylorun-project-") {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}
async function link(root: string, value: unknown, credentials?: unknown) {
  await mkdir(join(root, ".nylorun"), { recursive: true });
  await writeFile(
    join(root, ".nylorun", "link.json"),
    typeof value === "string" ? value : JSON.stringify(value),
  );
  if (credentials !== undefined)
    await writeFile(
      join(root, ".nylorun", "credentials.json"),
      typeof credentials === "string" ? credentials : JSON.stringify(credentials),
    );
}
const LINK = { format: 3, tenant: "demo", hostUrl: "http://127.0.0.1:8787/", hostId: "host_1" };

beforeEach(() => {
  vi.stubEnv("NYLORUN_HOME", "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("the Project root", () => {
  it("prefers the nearest .nylorun over a closer package.json", async () => {
    const root = await temporary();
    await mkdir(join(root, ".nylorun"), { recursive: true });
    const nested = join(root, "packages/app/src");
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, "packages/app/package.json"), "{}");
    expect(findProjectRoot(nested)).toBe(root);
    expect(findLinkedProjectRoot(nested)).toBe(root);
  });

  it("falls back to the nearest package.json, which holds no link", async () => {
    const root = await temporary();
    const nested = join(root, "packages/app/src");
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, "package.json"), "{}");
    await writeFile(join(root, "packages/app/package.json"), "{}");
    expect(findProjectRoot(nested)).toBe(join(root, "packages/app"));
    expect(findLinkedProjectRoot(nested)).toBeUndefined();
  });

  it("never treats the home directory, or anything above it, as a Project", async () => {
    const above = await temporary("nylorun-above-");
    await link(above, LINK, { format: 1, applicationKey: KEY, principalId: "project" });
    const home = join(above, "home");
    await mkdir(join(home, ".nylorun"), { recursive: true });
    await writeFile(join(home, "package.json"), "{}");
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    expect(findProjectRoot(home)).toBeUndefined();
    expect(findLinkedProject(home)).toBeUndefined();
    const below = join(home, "code");
    await mkdir(below);
    expect(findLinkedProject(below)).toBeUndefined();
  });

  it("finds a new Project below the home directory without .nylorun", async () => {
    const home = await temporary("nylorun-home-");
    const project = join(home, "code/my-agent");
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(join(project, "package.json"), "{}");
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    expect(findProjectRoot(join(project, "src"))).toBe(project);
  });

  it("puts the Nylorun home at NYLORUN_HOME or ~/.nylorun, and a Tenant's Host root under it", () => {
    expect(nylorunHome()).toBe(join(homedir(), ".nylorun"));
    expect(nylorunHome(undefined, { NYLORUN_HOME: "/srv/nylorun" })).toBe("/srv/nylorun");
    expect(nylorunHome("/explicit", { NYLORUN_HOME: "/srv/nylorun" })).toBe("/explicit");
    expect(tenantHostRoot("my-app")).toBe(join(homedir(), ".nylorun", "tenants", "my-app"));
  });
});

describe("the Project link and credentials", () => {
  it("finds the linked Project from a subdirectory, with its credentials", async () => {
    const root = await temporary();
    await link(root, { ...LINK, tenantId: "tn_x", extra: true }, {
      format: 1,
      applicationKey: KEY,
      principalId: "project",
      managementKey: "b".repeat(64),
      managementPrincipalId: "project-management",
    });
    const nested = join(root, "src", "deep");
    await mkdir(nested, { recursive: true });
    expect(findLinkedProject(nested)).toEqual({
      root,
      linkPath: join(root, ".nylorun", "link.json"),
      link: {
        format: 3,
        tenant: "demo",
        hostUrl: "http://127.0.0.1:8787",
        hostId: "host_1",
        tenantId: "tn_x",
      },
      credentials: {
        format: 1,
        applicationKey: KEY,
        principalId: "project",
        managementKey: "b".repeat(64),
        managementPrincipalId: "project-management",
      },
    });
  });

  it("stops at the nearest .nylorun/: a Project without a link is not linked by a parent's", async () => {
    const root = await temporary();
    await link(root, LINK, { format: 1, applicationKey: KEY, principalId: "project" });
    const inner = join(root, "packages", "app");
    await mkdir(join(inner, ".nylorun"), { recursive: true });
    expect(findLinkedProject(inner)).toBeUndefined();
  });

  it("reads a link without credentials, and older formats without a Tenant", async () => {
    const root = await temporary();
    await link(root, LINK);
    expect(findLinkedProject(root)?.credentials).toBeUndefined();
    await link(root, { format: 2, stack: "demo", hostUrl: "http://h", hostId: "host_1" });
    expect(readProjectLink(root)).toEqual({ format: 2, hostUrl: "http://h", hostId: "host_1" });
    await link(root, { hostUrl: "http://h", hostId: "host_1" });
    expect(readProjectLink(root)?.format).toBe(0);
  });

  it("refuses a broken or newer link, and broken or newer credentials", async () => {
    const root = await temporary();
    const failure = (read: () => unknown) => {
      try {
        read();
      } catch (error) {
        expect(error).toBeInstanceOf(ProjectFileError);
        return error as ProjectFileError;
      }
      throw new Error("expected a ProjectFileError");
    };
    await link(root, "{");
    expect(failure(() => readProjectLink(root))).toMatchObject({ file: "link", reason: "invalid" });
    await link(root, { format: 3, hostId: "host_1" });
    expect(failure(() => findLinkedProject(root)).message).toBe(
      `Invalid Project link at ${join(root, ".nylorun", "link.json")}. Remove .nylorun/link.json and run "npx nylorun start".`,
    );
    await link(root, { format: 4, hostUrl: "http://h", hostId: "host_1" });
    expect(failure(() => readProjectLink(root))).toMatchObject({ file: "link", reason: "newer" });

    await link(root, LINK, { format: 1, applicationKey: "short", principalId: "project" });
    expect(failure(() => findLinkedProject(root))).toMatchObject({
      file: "credentials",
      reason: "invalid",
    });
    await link(root, LINK, { format: 2, applicationKey: KEY, principalId: "project" });
    expect(failure(() => readProjectCredentials(root))).toMatchObject({ reason: "newer" });
  });

  it("reads format 0 credentials, ignoring a legacy executors map, and no file as none", async () => {
    const root = await temporary();
    const path = join(root, "cli-credentials.json");
    expect(readCredentialsFile(path)).toBeUndefined();
    await writeFile(path, JSON.stringify({ applicationKey: KEY, principalId: "p", executors: {} }));
    await chmod(path, 0o600);
    expect(readCredentialsFile(path)).toEqual({ format: 0, applicationKey: KEY, principalId: "p" });
  });
});
