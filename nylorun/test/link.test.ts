import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { linkedTenantId } from "../src/project/link.js";

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
    await writeFile(join(root, ".nylorun", "link.json"), JSON.stringify(link));
  }
  return root;
}

describe("linkedTenantId (nylorun studio's landing page)", () => {
  it("reads the linked Tenant from a Project or its subdirectory, and writes nothing", async () => {
    const tenantId = newTenantId();
    const link = { format: 1, hostUrl: "http://localhost:8787", hostId: "host_x", tenantId };
    const root = await project(link);
    await mkdir(join(root, "src"));
    expect(await linkedTenantId(root)).toBe(tenantId);
    expect(await linkedTenantId(join(root, "src"))).toBe(tenantId);
    expect(JSON.parse(await readFile(join(root, ".nylorun", "link.json"), "utf8"))).toEqual(link);
  });

  it("is undefined without a link, or with an invalid one", async () => {
    expect(await linkedTenantId(await project())).toBeUndefined();
    expect(await linkedTenantId(await project({ tenantId: "not-a-tenant" }))).toBeUndefined();
  });
});
