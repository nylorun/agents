/**
 * The abort matrix through the Harness API (F6.1): a cancel, a deadline, a shutdown and a lost
 * lease each reach the harness's call with core's reason, and leave the session, its effects
 * and its events exactly as the engine run in the advance leaves them (`harnessApi: false`).
 */
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { runAbortKind } from "@nylorun/harness/api";
import type { ModelProvider } from "../../src/core/provider.js";
import { MemoryExecution } from "../../src/execution/memory.js";
import { TenantWorkers } from "../../src/tenant/worker.js";
import { dropTestTenant, openTestSessionStore, withTestSessionStore } from "../support/store.js";
import {
  boot,
  cancel,
  openSession,
  sendMessage,
  types,
  until,
  view,
  type Started,
} from "../host/execution-support.js";

type Reason = "cancel" | "deadline" | "shutdown" | "ownership.lost";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

/** A model call that waits for its abort and records how it saw it. */
function abortableModel() {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const seen: { kind?: string; message?: string }[] = [];
  const provider: ModelProvider = (_effect, signal) =>
    new Promise((_, reject) => {
      entered();
      signal.addEventListener(
        "abort",
        () => {
          seen.push({ kind: runAbortKind(signal), message: (signal.reason as Error)?.message });
          reject(signal.reason);
        },
        { once: true }
      );
    });
  return { provider, started, seen };
}

const relevant = (type: string) => type.startsWith("turn.") || type.startsWith("effect.");

async function summary(runtime: Pick<Started, "root" | "tenantId">) {
  return withTestSessionStore(runtime, (store) =>
    store.tx(async (t) => {
      const session = (await t.get("sessions", "s1")) as { status: string; activeTurnId: string | null };
      const effects = await t.effectsForSession<any>("s1");
      const events = (await store.record().readRange(runtime.tenantId, "s1", 0, Number.MAX_SAFE_INTEGER))
        .map((row) => (row.body as { type: string }).type)
        .filter(relevant);
      return {
        status: session.status,
        effects: effects.map((effect) => ({ status: effect.status, error: effect.error })),
        events,
      };
    })
  );
}

async function scenario(reason: Reason, harnessApi: boolean) {
  const model = abortableModel();
  let execution: MemoryExecution | undefined;
  const options = {
    modelProvider: model.provider,
    harnessApi,
    sweepIntervalMs: 60_000,
    ...(reason === "deadline"
      ? {
          execution: {
            execution: (execution = new MemoryExecution({ sweepIntervalMs: 60_000 })),
            workers: new TenantWorkers({ advanceDeadlineMs: 2_000 }),
          },
        }
      : {}),
    ...(reason === "ownership.lost" ? { ownerLeaseMs: 300 } : {}),
    ...(reason === "shutdown" ? { retainRoot: true } : {}),
  };
  const runtime = await boot(options);
  if (execution) {
    await execution.start(options.execution!.workers.handlers);
    cleanups.push(() => execution!.stop());
  }
  let closed = false;
  cleanups.push(async () => {
    if (!closed) await runtime.close();
    if (reason === "shutdown") {
      await dropTestTenant(runtime.tenantId);
      await rm(runtime.root, { recursive: true, force: true });
    }
  });
  await openSession(runtime);
  await sendMessage(runtime);
  await model.started;

  if (reason === "cancel") {
    await cancel(runtime);
    await until(() => view(runtime), (v) => v.status === "cancelled", "cancelled");
  } else if (reason === "deadline") {
    await until(() => view(runtime), (v) => v.status === "uncertain", "uncertain");
  } else if (reason === "shutdown") {
    await runtime.close();
    closed = true;
  } else {
    // Another Worker takes the session over; this advance's next renewal fails.
    const store = await openTestSessionStore(runtime);
    try {
      await store.tx((t) =>
        t.takeOwnership("s1", { owner: "worker-thief", now: new Date(Date.now() + 120_000), leaseMs: -240_000 })
      );
    } finally {
      await store.close();
    }
  }
  await until(async () => model.seen.length, (n) => n > 0, "the call's abort");
  // Let the advance wind down.
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (reason !== "shutdown") await until(() => types(runtime), () => true, "history");
  return { seen: model.seen, ...(await summary(runtime)) };
}

/** How each abort leaves the session (§10.7, `worker.ts` "Abort reasons"). */
const SETTLED: Record<Reason, { status: string; effects: { status: string }[]; events: string[] }> = {
  cancel: { status: "cancelled", effects: [{ status: "uncertain" }], events: ["turn.cancelled"] },
  deadline: { status: "uncertain", effects: [{ status: "uncertain" }], events: ["effect.uncertain"] },
  shutdown: { status: "running", effects: [{ status: "uncertain" }], events: ["effect.uncertain"] },
  "ownership.lost": { status: "running", effects: [{ status: "invoking" }], events: [] },
};

describe("an abort through the Harness API", () => {
  it.each(["cancel", "deadline", "shutdown", "ownership.lost"] as const)(
    "settles a %s as the advance does without it",
    async (reason) => {
      const remote = await scenario(reason, true);
      const local = await scenario(reason, false);
      expect(remote.seen).toEqual([{ kind: reason, message: expect.any(String) }]);
      expect(remote).toEqual(local);
      expect(remote).toMatchObject(SETTLED[reason]);
    },
    60_000
  );
});
