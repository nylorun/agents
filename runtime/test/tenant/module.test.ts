/**
 * The Tenant module (`tenant/module.ts`): the Host's one Tenant over an injected opener. It
 * opens once, keeps a failure in the Tenant as the readiness cause, and retries one outside
 * it.
 */
import { expect, it, vi } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import type { TenantEnvelope } from "@nylorun/core/contracts";
import { createTenantModule } from "../../src/tenant/module.js";
import { openError } from "../../src/tenant/cause.js";
import { TimeoutError, withTimeout } from "../../src/tenant/pool.js";
import {
  TenantUnavailableError,
  type TenantHandle,
} from "../../src/tenant/types.js";
import type { TenantWorker } from "../../src/tenant/worker.js";
import { createFakeHandle, silentLogger } from "./support.js";

function envelope(id = newTenantId()): TenantEnvelope {
  return {
    id,
    name: "demo",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    schemaVersion: 9,
  };
}

function handle(env = envelope(), worker?: TenantWorker) {
  const close = vi.fn(async () => {});
  const fake = createFakeHandle({ envelope: env, onClose: close });
  return Object.assign(fake, worker ? { worker } : {}, { closeSpy: close });
}

it("withTimeout rejects and hands the late promise to onLate", async () => {
  let lateValue: number | undefined;
  const slow = new Promise<number>((resolve) => {
    setTimeout(() => resolve(42), 50);
  });
  await expect(
    withTimeout(slow, 5, (late) => {
      void late.then((v) => {
        lateValue = v;
      });
    }),
  ).rejects.toBeInstanceOf(TimeoutError);
  await new Promise((r) => setTimeout(r, 80));
  expect(lateValue).toBe(42);
});

it("opens the Tenant once, however many ask while it opens, and reports it open", async () => {
  const h = handle();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const open = vi.fn(async (): Promise<TenantHandle> => {
    await gate;
    return h;
  });
  const onOpen = vi.fn();
  const module = createTenantModule({ open, logger: silentLogger(), onOpen });
  expect(module.ready).toBe(false);
  expect(module.tenant()).toEqual({ id: null, name: null, state: "unavailable", envelope: null });
  const started = module.start();
  const resolved = module.resolve();
  const worker = module.worker(h.envelope.id);
  release();
  await started;
  await expect(resolved).resolves.toEqual({ kind: "open", handle: h });
  await worker;
  expect(open).toHaveBeenCalledTimes(1);
  expect(onOpen).toHaveBeenCalledWith(h);
  expect(module.ready).toBe(true);
  expect(module.tenant()).toEqual({
    id: h.envelope.id,
    name: "demo",
    state: "open",
    envelope: h.envelope,
  });
  await module.close();
  expect(h.closeSpy).toHaveBeenCalledTimes(1);
  expect(module.ready).toBe(false);
  await expect(module.resolve()).resolves.toEqual({ kind: "unavailable" });
});

it("hands the Worker only to calls for its own Tenant", async () => {
  const worker: TenantWorker = {
    advance: async () => ({ status: "done" }),
    sweep: async () => {},
  } as unknown as TenantWorker;
  const h = handle(envelope(), worker);
  const module = createTenantModule({ open: async () => h, logger: silentLogger() });
  await module.start();
  expect(await module.worker(h.envelope.id)).toBe(worker);
  expect(await module.worker(newTenantId())).toBeUndefined();
  await module.close();
  expect(await module.worker(h.envelope.id)).toBeUndefined();
});

it("keeps a failure in the Tenant as its cause: not ready, not retried, reported with the Tenant", async () => {
  const env = envelope();
  const failure = openError("kek-missing", "Vault key-encryption key is missing");
  failure.envelope = env;
  const open = vi.fn(async (): Promise<TenantHandle> => {
    throw failure;
  });
  const module = createTenantModule({ open, logger: silentLogger() });
  await module.start();
  expect(module.ready).toBe(false);
  const resolution = await module.resolve();
  expect(resolution).toMatchObject({ kind: "unavailable", cause: { code: "kek-missing" } });
  expect(module.tenant()).toMatchObject({
    id: env.id,
    name: "demo",
    state: "unavailable",
    cause: { code: "kek-missing", repair: expect.stringContaining("vault-kek") },
  });
  expect(open).toHaveBeenCalledTimes(1);
  await module.close();
});

it("names any other failure to open, and a timeout, as causes", async () => {
  const failing = createTenantModule({
    open: async () => {
      throw new Error("boom");
    },
    logger: silentLogger(),
  });
  await failing.start();
  expect(failing.tenant()).toMatchObject({
    id: null,
    state: "unavailable",
    cause: { code: "open-failed", message: "boom" },
  });

  const late = handle();
  const slow = createTenantModule({
    open: () => new Promise((resolve) => setTimeout(() => resolve(late), 50)),
    openTimeoutMs: 5,
    logger: silentLogger(),
  });
  await slow.start();
  expect(slow.tenant().cause?.code).toBe("open-timeout");
  await new Promise((r) => setTimeout(r, 80));
  // The handle that opened too late is closed, not served.
  expect(late.closeSpy).toHaveBeenCalledTimes(1);
  expect((await slow.resolve()).kind).toBe("unavailable");
});

it("retries an open that failed outside the Tenant, and 503s meanwhile", async () => {
  const h = handle();
  let down = true;
  const open = vi.fn(async (): Promise<TenantHandle> => {
    if (down) throw new TenantUnavailableError({ cause: new Error("ECONNREFUSED") });
    return h;
  });
  const module = createTenantModule({ open, logger: silentLogger() });
  await module.start();
  expect(module.ready).toBe(false);
  expect(module.tenant()).toEqual({ id: null, name: null, state: "unavailable", envelope: null });
  await expect(module.resolve()).rejects.toMatchObject({ status: 503 });
  down = false;
  await expect(module.resolve()).resolves.toEqual({ kind: "open", handle: h });
  expect(module.ready).toBe(true);
  expect(open).toHaveBeenCalledTimes(3);
  await module.close();
});

it("summarizes the open Tenant's counts and the relay", async () => {
  const h = handle();
  h.setSummary({
    ready: true,
    runningSessions: 2,
    inFlightDeliveries: 1,
    pendingActions: 3,
    uncertainEffects: 4,
  });
  const relay = {
    active: true,
    pendingTxs: 0,
    pendingRows: 0,
    confirmed: null,
    reconciliations: 0,
    lastError: null,
  };
  const module = createTenantModule({
    open: async () => h,
    logger: silentLogger(),
    relayStatus: async () => relay,
  });
  expect(await module.summarize()).toEqual({
    runningSessions: 0,
    inFlightDeliveries: 0,
    pendingActions: 0,
    uncertainEffects: 0,
    relay,
  });
  await module.start();
  expect(await module.summarize()).toEqual({
    runningSessions: 2,
    inFlightDeliveries: 1,
    pendingActions: 3,
    uncertainEffects: 4,
    relay,
  });
  await module.close();
});
