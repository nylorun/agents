import { readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { createTenantModule } from "../../src/tenant/module.js";
import { createFsTenantStore } from "../../src/tenant/store-fs.js";
import { TenantBusyError } from "../../src/tenant/quarantine.js";
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

async function setup() {
  const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-delete-"));
  roots.push(hostRoot);
  const openRuntime = createFakeOpenRuntime({ hostRoot });
  const configFor = configForRoot(hostRoot);
  const store = createFsTenantStore({ hostRoot, openRuntime, configFor });
  const module = createTenantModule({
    hostRoot,
    store,
    openRuntime,
    configFor,
    logger: silentLogger(),
  });
  return { hostRoot, module };
}

it("delete with refuse throws when sessions are running", async () => {
  const { module } = await setup();
  const id = newTenantId();
  await module.create({
    tenantId: id,
    name: "live",
    ...bootstrapMaterial(),
  });
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
    runningSessions: 2,
    connectedExecutors: 1,
    pendingActions: 0,
    uncertainEffects: 0,
  });
  await expect(module.delete(id, "refuse")).rejects.toBeInstanceOf(
    TenantBusyError,
  );
  expect((await module.resolve(id)).kind).toBe("open");
});

it("delete with cancel drains then moves the directory to trash", async () => {
  const { module, hostRoot } = await setup();
  const id = newTenantId();
  let drained: string | undefined;
  const openRuntime = createFakeOpenRuntime({
    hostRoot,
  });
  // Re-bind drain observation via handle after create.
  const configFor = configForRoot(hostRoot);
  const store = createFsTenantStore({ hostRoot, openRuntime, configFor });
  const module2 = createTenantModule({
    hostRoot,
    store,
    openRuntime,
    configFor,
    logger: silentLogger(),
  });
  await module2.create({
    tenantId: id,
    name: "gone",
    ...bootstrapMaterial(),
  });
  const resolution = await module2.resolve(id);
  if (resolution.kind === "open") {
    const original = resolution.handle.drain.bind(resolution.handle);
    resolution.handle.drain = async (activeWork) => {
      drained = activeWork;
      await original(activeWork);
    };
  }
  await module2.delete(id, "cancel");
  expect(drained).toBe("cancel");
  expect((await module2.resolve(id)).kind).toBe("not-found");
  const trash = readdirSync(join(hostRoot, "trash"));
  expect(trash.some((name) => name.startsWith(`${id}-`))).toBe(true);
  void module;
});
