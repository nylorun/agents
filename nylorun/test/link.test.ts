import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveTenantKey } from "../src/project/derived-key.js";
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
  it("reads a format 2 link: the stack, its URL and Host, and the Tenant as information", async () => {
    const root = await project({
      format: 2,
      stack: "shop",
      hostUrl: "http://localhost:8787/",
      hostId: "host_x",
      tenantId: "tn_x",
    });
    expect(await readProjectLink(root)).toEqual({
      format: 2,
      stack: "shop",
      hostUrl: "http://localhost:8787",
      hostId: "host_x",
      tenantId: "tn_x",
    });
  });

  it("reads an older link (format 0 or 1) as such, so start replaces it", async () => {
    const root = await project({ format: 1, hostUrl: "http://localhost:8787", hostId: "host_x", tenantId: "tn_x" });
    expect(await readProjectLink(root)).toMatchObject({ format: 1, tenantId: "tn_x" });
    expect((await readProjectLink(root))?.stack).toBeUndefined();
    const legacy = await project({ hostUrl: "http://localhost:8787", hostId: "host_x", tenantId: "tn_x" });
    expect((await readProjectLink(legacy))?.format).toBe(0);
  });

  it("is undefined without a link, and an error for a broken or newer one", async () => {
    expect(await readProjectLink(await project())).toBeUndefined();
    await expect(readProjectLink(await project("{"))).rejects.toThrow(/Invalid or newer Project link/);
    await expect(
      readProjectLink(await project({ format: 3, hostUrl: "h", hostId: "x" })),
    ).rejects.toThrow(/Upgrade nylorun/);
  });

  it("writes link.json and credentials.json (0600) in a private .nylorun/ ignored by git", async () => {
    const root = await project();
    await writeProjectLink(root, {
      stack: "shop",
      hostUrl: "http://localhost:8787/",
      hostId: "host_x",
      tenantId: "tn_x",
    });
    await writeProjectCredentials(root, { applicationKey: "ab".repeat(32), principalId: "project" });
    const dir = join(root, ".nylorun");
    expect(JSON.parse(await readFile(join(dir, "link.json"), "utf8"))).toEqual({
      format: 2,
      stack: "shop",
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
});

describe("deriveTenantKey (a copy of @nylorun/admin's)", () => {
  const ADMIN_KEY = "a".repeat(64);
  const TENANT = "tn_00000000000000000000000001";

  it("matches the fixed vectors computed independently (Python hmac)", () => {
    // hmac.new(b"a"*64, b"nylorun/principal/v1\x00babai\x00" + tenant, sha256).hexdigest()
    expect(deriveTenantKey(ADMIN_KEY, TENANT, "babai")).toBe(
      "e75e386ac70503370967006bf76ba46b6c9603ca52e282bcfac2f8f972ea771c",
    );
    // hmac.new(b"a"*64, b"nylorun/principal/v1\x00project\x00" + tenant, sha256).hexdigest()
    expect(deriveTenantKey(ADMIN_KEY, TENANT, "project")).toBe(
      "8fc08b225d4a5809f65c8d0f5e4052404b00b8137fda7ed792ba1148f4216d4f",
    );
  });
});
