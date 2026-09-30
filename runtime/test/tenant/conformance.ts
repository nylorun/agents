/**
 * Module conformance suite (§23 bullets that do not need a real Tenant Runtime), on the
 * in-memory Tenant store with an injected fake OpenTenantRuntime. The Postgres store runs the
 * module against a real Tenant Runtime in `conformance-real.test.ts` and
 * `store-pg.integration.test.ts`.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { createTenantModule } from "../../src/tenant/module.js";
import { createMemoryTenantStore } from "../../src/tenant/store-memory.js";
import {
  TenantBusyError,
  TenantConflictError,
  quarantine,
} from "../../src/tenant/quarantine.js";
import { tenantPaths } from "../../src/tenant/paths.js";
import type { TenantStore } from "../../src/tenant/types.js";
import {
  bootstrapMaterial,
  configForRoot,
  createFakeOpenRuntime,
  silentLogger,
} from "./support.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nylorun-tenant-"));
  roots.push(root);
  return root;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function setup() {
  const hostRoot = await tempRoot();
  const opened: string[] = [];
  const openRuntime = createFakeOpenRuntime({
    hostRoot,
    beforeOpen: (config) => void opened.push(config.tenantId),
  });
  const configFor = configForRoot(hostRoot);
  const store = createMemoryTenantStore({ hostRoot, openRuntime, configFor });
  const module = createTenantModule({ store, logger: silentLogger() });
  return { hostRoot, store, module, opened };
}

describe("tenant module conformance", () => {
  it("creates a Tenant and resolves it open after start", async () => {
    const { module } = await setup();
    const id = newTenantId();
    const boot = bootstrapMaterial({
      credentialHash: hashToken(randomBytes(32).toString("hex")),
    });
    const created = await module.create({
      tenantId: id,
      name: "alpha",
      ...boot,
    });
    expect(created.created).toBe(true);
    expect(created.envelope.id).toBe(id);
    expect(created.envelope.name).toBe("alpha");

    await module.start();
    expect(module.started).toBe(true);
    const resolution = await module.resolve(id);
    expect(resolution.kind).toBe("open");
    if (resolution.kind === "open") {
      expect(resolution.handle.envelope.id).toBe(id);
    }
  });

  it("create is idempotent when bootstrap material matches", async () => {
    const { module } = await setup();
    const id = newTenantId();
    const boot = bootstrapMaterial();
    const first = await module.create({
      tenantId: id,
      name: "once",
      ...boot,
    });
    const second = await module.create({
      tenantId: id,
      name: "once-again",
      ...boot,
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.envelope.id).toBe(id);
    expect(second.envelope.name).toBe(first.envelope.name);
  });

  it("create conflicts when bootstrap material differs (409)", async () => {
    const { module } = await setup();
    const id = newTenantId();
    await module.create({
      tenantId: id,
      name: "a",
      ...bootstrapMaterial(),
    });
    await expect(
      module.create({
        tenantId: id,
        name: "b",
        ...bootstrapMaterial({
          credentialHash: "cd".repeat(32),
        }),
      })
    ).rejects.toBeInstanceOf(TenantConflictError);
  });

  it("lists open Tenants and quarantines unreadable envelopes", async () => {
    const { store } = await setup();
    const bad = newTenantId();
    const invalid = () =>
      quarantine("envelope-invalid", "the Tenant envelope is invalid", {
        tenantId: bad,
      });
    // A store holding one Tenant whose envelope does not read.
    const broken: TenantStore = {
      ...store,
      enumerate: async () => [...(await store.enumerate()), bad],
      readEnvelope: (id) =>
        id === bad ? Promise.reject(invalid()) : store.readEnvelope(id),
      open: (id) => (id === bad ? Promise.reject(invalid()) : store.open(id)),
    };
    const module = createTenantModule({
      store: broken,
      logger: silentLogger(),
    });
    const id = newTenantId();
    await module.create({
      tenantId: id,
      name: "listed",
      ...bootstrapMaterial(),
    });
    await module.start();
    const listed = await module.list();
    expect(listed.some((t) => t.id === id && t.state === "open")).toBe(true);
    const row = listed.find((t) => t.id === bad);
    expect(row?.state).toBe("quarantined");
    expect(row?.name).toBeNull();
    const status = await module.status(bad);
    expect(status?.quarantine?.code).toBe("envelope-invalid");
    expect(status?.quarantine?.repair).toMatch(/nylo tenant status/);
  });

  it("delete refuses live work and trashes after drain", async () => {
    const { module } = await setup();
    const id = newTenantId();
    await module.create({
      tenantId: id,
      name: "busy",
      ...bootstrapMaterial(),
    });
    await module.start();
    const resolution = await module.resolve(id);
    expect(resolution.kind).toBe("open");
    if (resolution.kind !== "open") return;
    (
      resolution.handle as {
        setSummary?(s: {
          ready: boolean;
          runningSessions: number;
          inFlightDeliveries: number;
          pendingActions: number;
          uncertainEffects: number;
        }): void;
      }
    ).setSummary?.({
      ready: true,
      runningSessions: 1,
      inFlightDeliveries: 0,
      pendingActions: 0,
      uncertainEffects: 0,
    });
    await expect(module.delete(id, "refuse")).rejects.toBeInstanceOf(
      TenantBusyError
    );
    await module.delete(id, "drain");
    expect((await module.resolve(id)).kind).toBe("not-found");
    expect(await module.status(id)).toBeUndefined();
  });

  it("summarize aggregates counts only", async () => {
    const { module } = await setup();
    const id = newTenantId();
    await module.create({
      tenantId: id,
      name: "sum",
      ...bootstrapMaterial(),
    });
    await module.start();
    const resolution = await module.resolve(id);
    if (resolution.kind === "open") {
      (
        resolution.handle as {
          setSummary?(s: {
            ready: boolean;
            runningSessions: number;
            inFlightDeliveries: number;
            pendingActions: number;
            uncertainEffects: number;
          }): void;
        }
      ).setSummary?.({
        ready: true,
        runningSessions: 2,
        inFlightDeliveries: 3,
        pendingActions: 1,
        uncertainEffects: 4,
      });
    }
    const aggregate = await module.summarize();
    expect(aggregate).toEqual({
      runningSessions: 2,
      inFlightDeliveries: 3,
      pendingActions: 1,
      uncertainEffects: 4,
    });
    for (const value of Object.values(aggregate)) {
      expect(typeof value).toBe("number");
    }
  });

  it("one Tenant failing to open leaves others available", async () => {
    const hostRoot = await tempRoot();
    const failId = newTenantId();
    const okId = newTenantId();
    const openRuntime = createFakeOpenRuntime({
      hostRoot,
      failFor: (id) => (id === failId ? new Error("boom") : undefined),
    });
    const configFor = configForRoot(hostRoot);
    const store = createMemoryTenantStore({ hostRoot, openRuntime, configFor });

    const iso = new Date().toISOString();
    const boot = bootstrapMaterial();
    await store.create(
      {
        id: okId,
        name: "ok",
        createdAt: iso,
        updatedAt: iso,
        schemaVersion: 1,
      },
      boot
    );
    await store.create(
      {
        id: failId,
        name: "bad",
        createdAt: iso,
        updatedAt: iso,
        schemaVersion: 1,
      },
      bootstrapMaterial()
    );

    const module = createTenantModule({ store, logger: silentLogger() });
    await module.start();
    expect((await module.resolve(okId)).kind).toBe("open");
    const bad = await module.resolve(failId);
    expect(bad.kind).toBe("quarantined");
    if (bad.kind === "quarantined") {
      expect(bad.quarantine.code).toBe("open-failed");
      expect(bad.quarantine.repair).toMatch(/nylo tenant status/);
    }
  });

  it("opens a Tenant restored after start on first use, and list opens nothing", async () => {
    const { module, store, opened } = await setup();
    await module.start();
    expect(module.started).toBe(true);
    const id = newTenantId();
    const iso = new Date().toISOString();
    await store.create(
      {
        id,
        name: "restored",
        createdAt: iso,
        updatedAt: iso,
        schemaVersion: 1,
      },
      bootstrapMaterial()
    );
    const listed = await module.list();
    expect(listed.find((t) => t.id === id)).toMatchObject({
      state: "open",
      name: "restored",
    });
    expect(opened).toEqual([]);
    expect(await module.summarize()).toMatchObject({ runningSessions: 0 });
    const [first, second] = await Promise.all([
      module.resolve(id),
      module.resolve(id),
    ]);
    expect(first.kind).toBe("open");
    // Concurrent first uses share one open.
    if (first.kind === "open" && second.kind === "open")
      expect(second.handle).toBe(first.handle);
    expect((await module.resolve(newTenantId())).kind).toBe("not-found");
  });

  it("creates the Tenant directory with the Tenant and removes it on delete", async () => {
    const { module, hostRoot } = await setup();
    const id = newTenantId();
    await module.create({
      tenantId: id,
      name: "directory",
      ...bootstrapMaterial(),
    });
    const paths = tenantPaths(hostRoot, id);
    for (const dir of [
      paths.home,
      paths.tmp,
      paths.sandboxes,
      paths.pluginData,
      paths.logs,
    ])
      expect(existsSync(dir)).toBe(true);
    await module.start();
    await module.delete(id, "refuse");
    expect(existsSync(paths.root)).toBe(false);
  });
});
