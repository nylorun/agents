/**
 * Module conformance suite (§23 bullets that do not need a real Tenant Runtime).
 * Runs against both FS and memory adapters with an injected fake OpenTenantRuntime.
 */
import { createHash, randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { createTenantModule } from "../../src/tenant/module.js";
import { createFsTenantStore } from "../../src/tenant/store-fs.js";
import { createMemoryTenantStore } from "../../src/tenant/store-memory.js";
import {
  TenantBusyError,
  TenantConflictError,
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

type AdapterName = "fs" | "memory";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function setup(adapter: AdapterName) {
  const hostRoot = await tempRoot();
  const openRuntime = createFakeOpenRuntime({
    hostRoot,
  });
  const configFor = configForRoot(hostRoot);
  const store: TenantStore =
    adapter === "fs"
      ? createFsTenantStore({ hostRoot, openRuntime, configFor })
      : createMemoryTenantStore({ openRuntime, configFor });
  const module = createTenantModule({
    hostRoot,
    store,
    openRuntime,
    configFor,
    logger: silentLogger(),
  });
  return { hostRoot, store, module };
}

function conformance(adapter: AdapterName) {
  describe(`${adapter} tenant module conformance`, () => {
    it("creates a Tenant and resolves it open after start", async () => {
      const { module } = await setup(adapter);
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
      const { module } = await setup(adapter);
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
      const { module } = await setup(adapter);
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
        }),
      ).rejects.toBeInstanceOf(TenantConflictError);
    });

    it("lists open Tenants and quarantines unreadable envelopes", async () => {
      const { module, hostRoot } = await setup(adapter);
      const id = newTenantId();
      await module.create({
        tenantId: id,
        name: "listed",
        ...bootstrapMaterial(),
      });
      await module.start();
      const listed = await module.list();
      expect(listed.some((t) => t.id === id && t.state === "open")).toBe(true);

      if (adapter === "fs") {
        const bad = newTenantId();
        const paths = tenantPaths(hostRoot, bad);
        await mkdir(paths.root, { recursive: true });
        await writeFile(paths.envelope, "{not-json");
        const again = await module.list();
        const row = again.find((t) => t.id === bad);
        expect(row?.state).toBe("quarantined");
        expect(row?.name).toBeNull();
        const status = await module.status(bad);
        expect(status?.quarantine?.code).toBe("envelope-invalid");
        expect(status?.quarantine?.repair).toMatch(/nylorun tenant status/);
      }
    });

    it("delete refuses live work and trashes after drain", async () => {
      const { module } = await setup(adapter);
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
            connectedExecutors: number;
            pendingActions: number;
            uncertainEffects: number;
          }): void;
        }
      ).setSummary?.({
        ready: true,
        runningSessions: 1,
        connectedExecutors: 0,
        pendingActions: 0,
        uncertainEffects: 0,
      });
      await expect(module.delete(id, "refuse")).rejects.toBeInstanceOf(
        TenantBusyError,
      );
      await module.delete(id, "drain");
      expect((await module.resolve(id)).kind).toBe("not-found");
      expect(await module.status(id)).toBeUndefined();
    });

    it("summarize aggregates counts only", async () => {
      const { module } = await setup(adapter);
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
              connectedExecutors: number;
              pendingActions: number;
              uncertainEffects: number;
            }): void;
          }
        ).setSummary?.({
          ready: true,
          runningSessions: 2,
          connectedExecutors: 3,
          pendingActions: 1,
          uncertainEffects: 4,
        });
      }
      const aggregate = await module.summarize();
      expect(aggregate).toEqual({
        runningSessions: 2,
        connectedExecutors: 3,
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
      const store: TenantStore =
        adapter === "fs"
          ? createFsTenantStore({ hostRoot, openRuntime, configFor })
          : createMemoryTenantStore({ openRuntime, configFor });

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
        boot,
      );
      await store.create(
        {
          id: failId,
          name: "bad",
          createdAt: iso,
          updatedAt: iso,
          schemaVersion: 1,
        },
        bootstrapMaterial(),
      );

      const module = createTenantModule({
        hostRoot,
        store,
        openRuntime,
        configFor,
        logger: silentLogger(),
      });
      await module.start();
      expect((await module.resolve(okId)).kind).toBe("open");
      const bad = await module.resolve(failId);
      expect(bad.kind).toBe("quarantined");
      if (bad.kind === "quarantined") {
        expect(bad.quarantine.code).toBe("open-failed");
        expect(bad.quarantine.repair).toMatch(/nylorun tenant status/);
      }
    });

    it("list discovers a Tenant directory restored after start", async () => {
      const { module, store } = await setup(adapter);
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
        bootstrapMaterial(),
      );
      expect((await module.resolve(id)).kind).toBe("not-found");
      const listed = await module.list();
      expect(listed.some((t) => t.id === id && t.state === "open")).toBe(true);
      expect((await module.resolve(id)).kind).toBe("open");
    });
  });
}

conformance("fs");
conformance("memory");

describe("fs-only path containment", () => {
  it("rejects a Tenant directory that escapes via symlink", async () => {
    const hostRoot = await tempRoot();
    const outside = join(hostRoot, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "marker"), "x");
    const tenants = join(hostRoot, "tenants");
    await mkdir(tenants);
    const id = newTenantId();
    await symlink(outside, join(tenants, id));
    expect(() => tenantPaths(hostRoot, id)).toThrow(/escapes/);
  });

  it("moves deleted Tenants under trash/", async () => {
    const { module, hostRoot } = await setup("fs");
    const id = newTenantId();
    await module.create({
      tenantId: id,
      name: "trash-me",
      ...bootstrapMaterial(),
    });
    await module.start();
    await module.delete(id, "refuse");
    const trashDir = join(hostRoot, "trash");
    const entries = readdirSync(trashDir);
    expect(entries.some((name) => name.startsWith(`${id}-`))).toBe(true);
    await expect(
      readFile(join(hostRoot, "tenants", id, "tenant.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
