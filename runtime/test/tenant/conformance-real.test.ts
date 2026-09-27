/**
 * Integration I1: module conformance against the real Tenant Runtime.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { createTenantModule } from "../../src/tenant/module.js";
import { createFsTenantStore } from "../../src/tenant/store-fs.js";
import { openTenantRuntime } from "../../src/tenant/runtime.js";
import { bootstrapPrincipal } from "../../src/tenant/principals.js";
import { migrateTenantDatabase } from "../../src/tenant/schema.js";
import { tenantPaths } from "../../src/tenant/paths.js";
import type { TenantConfig } from "../../src/tenant/types.js";
import { configForRoot, silentLogger } from "./support.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

describe("real Tenant Runtime module conformance (I1)", () => {
  it("creates, opens, and resolves a Tenant with openTenantRuntime", async () => {
    const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-i1-"));
    roots.push(hostRoot);
    const configFor = (id: string): TenantConfig => {
      const base = configForRoot(hostRoot)(id);
      return {
        ...base,
        mode: "test",
        model: { kind: "scripted", output: "ok" },
        sandbox: { backend: "virtual" },
      };
    };
    const openRuntime = (config: TenantConfig) =>
      openTenantRuntime(config, { createKekIfMissing: true });
    const store = createFsTenantStore({
      hostRoot,
      openRuntime,
      configFor,
      writeBootstrap: (db, bootstrap) => {
        migrateTenantDatabase(db);
        bootstrapPrincipal(db, bootstrap);
      },
    });
    const module = createTenantModule({
      hostRoot,
      store,
      openRuntime,
      configFor,
      logger: silentLogger(),
    });
    await module.start();
    const tenantId = newTenantId();
    const token = randomBytes(32).toString("hex");
    const created = await module.create({
      tenantId,
      name: "i1",
      principalId: "principal_i1",
      credentialHash: hashToken(token),
      idempotencyKey: "i1-key",
    });
    expect(created.created).toBe(true);
    const resolution = await module.resolve(tenantId);
    expect(resolution.kind).toBe("open");
    if (resolution.kind !== "open") return;
    expect(resolution.handle.envelope.id).toBe(tenantId);
    expect((await resolution.handle.summary()).ready).toBe(true);
    const paths = tenantPaths(hostRoot, tenantId);
    expect(paths.database).toContain(tenantId);
    await module.close();
  });
});
