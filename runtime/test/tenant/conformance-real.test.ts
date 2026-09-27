/**
 * Integration I1: module conformance against the real Tenant Runtime, on the store
 * `NYLORUN_TEST_STORE` selects (the directory with SQLite, or Postgres schemas).
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { createTenantModule } from "../../src/tenant/module.js";
import { createFsTenantStore } from "../../src/tenant/store-fs.js";
import { createPostgresTenantStore } from "../../src/tenant/store-pg.js";
import { openTenantRuntime } from "../../src/tenant/runtime.js";
import { tenantPaths } from "../../src/tenant/paths.js";
import type { TenantConfig } from "../../src/tenant/types.js";
import { MemoryStreams } from "../../src/streams/memory.js";
import { TEST_STORE, testPool } from "../support/store.js";
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

describe(`real Tenant Runtime module conformance (I1, ${TEST_STORE})`, () => {
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
    const streams = new MemoryStreams();
    const store =
      TEST_STORE === "postgres"
        ? createPostgresTenantStore({
            hostRoot,
            sql: testPool(),
            configFor,
            openRuntime: (config, opened) =>
              openTenantRuntime(config, {
                createKekIfMissing: true,
                streams,
                ...opened,
              }),
          })
        : createFsTenantStore({ hostRoot, openRuntime, configFor });
    const module = createTenantModule({
      store,
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
    expect(await module.worker(tenantId)).toBe(resolution.handle.worker);
    // The admin views and the Tenant's own status agree on the envelope.
    const status = await module.status(tenantId);
    const listed = (await module.list()).find((t) => t.id === tenantId);
    expect(status?.envelope).toEqual(resolution.handle.envelope);
    expect(listed?.envelope).toEqual(resolution.handle.envelope);
    const paths = tenantPaths(hostRoot, tenantId);
    expect(existsSync(paths.pluginData)).toBe(true);
    if (TEST_STORE === "sqlite") expect(existsSync(paths.database)).toBe(true);
    else expect(existsSync(paths.database)).toBe(false);
    await module.delete(tenantId, "refuse");
    expect((await module.resolve(tenantId)).kind).toBe("not-found");
    await module.close();
  });
});
