/**
 * The pod sandbox lifecycle as a pure decision (F7.2, D34): create, ready, failed, idle, TTL
 * (retain and delete), lost, delete and reset's retiring Sandbox.
 */
import { describe, expect, it } from "vitest";
import type { PodStatus } from "../../src/sandbox/pods/client.js";
import { decide, opIdOf, READY_DEADLINE_MS, type PodFacts, type PodRow } from "../../src/sandbox/pods/lifecycle.js";
import { podName } from "../../src/sandbox/pods/name.js";
import { podSpecOf } from "../../src/sandbox/pods/spec.js";

const T0 = Date.parse("2026-10-03T10:00:00Z");
const NAME = "sbx-aaaaaaaaaaaaaaaa-g0";

function row(pod: Partial<PodRow["pod"]> = {}): PodRow {
  return {
    id: "s1",
    kind: "pod",
    spec: {},
    labels: {},
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    pod: {
      k8sName: NAME,
      volumeGen: 0,
      desired: "running",
      observed: "creating",
      hostEpoch: 0,
      rev: 1,
      startedAt: new Date(T0).toISOString(),
      ...pod,
    },
  };
}

function status(over: Partial<PodStatus> = {}): PodStatus {
  return {
    name: NAME,
    exists: true,
    deleting: false,
    ready: true,
    suspended: false,
    expired: false,
    volume: "present",
    podUID: "uid-1",
    podPhase: "Running",
    opId: `${NAME}.r1`,
    ...over,
  };
}

const gone: PodStatus = { name: NAME, exists: false, deleting: false, ready: false, suspended: false, expired: false, volume: "missing" };

function facts(over: Partial<PodFacts>): PodFacts {
  return {
    row: row(),
    config: { onExpiry: "retain", idleMs: 60_000 },
    status: status(),
    busy: false,
    now: T0 + 1_000,
    trigger: "reconcile",
    ...over,
  };
}

describe("pod lifecycle", () => {
  it("names a Sandbox as the sandboxes service does", () => {
    expect(podName("shop", "sbx_01", 0)).toBe("sbx-ub6g5m7mvjlct6r7-g0");
    expect(podName("shop", "sbx_01", 3)).toBe("sbx-ub6g5m7mvjlct6r7-g3");
  });

  it("creates at once with a new join token, then runs once ready", () => {
    const created = decide(facts({ status: gone }));
    expect(created.apply).toEqual({ mode: "Running", rotateJoin: true });
    expect(created.retryAfterMs).toBeGreaterThan(0);
    const ready = decide(facts({}));
    expect(ready.apply).toBeUndefined();
    expect(ready.patch).toMatchObject({ observed: "running" });
  });

  it("applies again when the Sandbox carries another revision, without a new token", () => {
    const decision = decide(facts({ row: row({ rev: 2, observed: "running" }) }));
    expect(decision.apply).toEqual({ mode: "Running", rotateJoin: false });
    expect(decision.patch).toMatchObject({ observed: "creating" });
  });

  it("fails a pod not ready within the deadline, with its reason", () => {
    const decision = decide(
      facts({ status: status({ ready: false, reason: "ImagePullBackOff", message: "no such image" }), now: T0 + READY_DEADLINE_MS + 1 }),
    );
    expect(decision.patch).toMatchObject({ observed: "failed", reason: "ImagePullBackOff: no such image" });
    expect(decision.events).toEqual([{ type: "sandbox.failed", payload: { reason: "ImagePullBackOff: no such image" } }]);
  });

  it("suspends an idle pod, and re-arms the timer of one used since", () => {
    const base = row({ observed: "running", podUid: "uid-1", lastActiveAt: new Date(T0).toISOString(), hostEpoch: 3 });
    const idle = decide(facts({ row: base, trigger: "idle", now: T0 + 61_000 }));
    expect(idle.patch).toMatchObject({ desired: "suspended", rev: 2, hostEpoch: 4 });
    expect(idle.apply).toEqual({ mode: "Suspended", rotateJoin: false });
    expect(idle.events).toEqual([{ type: "sandbox.suspended", payload: { reason: "idle" } }]);
    const early = decide(facts({ row: base, trigger: "idle", now: T0 + 30_000 }));
    expect(early.patch.desired).toBeUndefined();
    expect(early.arm).toContainEqual({ timer: "idle", at: T0 + 60_000 });
    expect(decide(facts({ row: base, trigger: "idle", now: T0 + 61_000, busy: true })).patch.desired).toBeUndefined();
  });

  it("is suspended once the pod is gone", () => {
    const suspended = decide(
      facts({
        row: row({ desired: "suspended", rev: 2, observed: "running", podUid: "uid-1" }),
        status: status({ opId: `${NAME}.r2`, mode: "Suspended", suspended: true, ready: false, podUID: undefined, podPhase: undefined }),
      }),
    );
    expect(suspended.patch).toMatchObject({ observed: "suspended" });
  });

  it("expires at its TTL: the epoch moves; retain keeps it, delete deletes it", () => {
    const expiring = row({ observed: "running", podUid: "uid-1", hostEpoch: 2, expiresAt: new Date(T0 + 60_000).toISOString() });
    expect(decide(facts({ row: expiring })).arm).toContainEqual({ timer: "ttl", at: T0 + 60_000 });
    const retained = decide(facts({ row: expiring, now: T0 + 60_000, trigger: "ttl" }));
    expect(retained.patch).toMatchObject({ observed: "expired", hostEpoch: 3 });
    expect(retained.events).toEqual([{ type: "sandbox.expired", payload: { onExpiry: "retain" } }]);
    expect(retained.delete).toEqual([]);
    const deleted = decide(facts({ row: expiring, now: T0 + 60_000, config: { onExpiry: "delete", idleMs: 60_000 } }));
    expect(deleted.patch).toMatchObject({ observed: "expired", desired: "deleted" });
    expect(deleted.delete).toEqual([NAME]);
  });

  it("is lost when a joined incarnation's volume or Sandbox is gone, and stays lost", () => {
    const joined = row({ observed: "running", podUid: "uid-1", hostEpoch: 5 });
    const pvc = decide(facts({ row: joined, status: status({ volume: "missing", ready: false }) }));
    expect(pvc.patch).toMatchObject({ observed: "lost", hostEpoch: 6 });
    expect(pvc.events[0]?.type).toBe("sandbox.lost");
    expect(pvc.delete).toEqual([NAME]);
    const vanished = decide(facts({ row: joined, status: gone }));
    expect(vanished.patch.observed).toBe("lost");
    // A Sandbox that never ran is created, not lost.
    expect(decide(facts({ status: gone })).patch.observed).toBeUndefined();
    const lost = decide(facts({ row: row({ observed: "lost", podUid: "uid-1" }), status: gone }));
    expect(lost.apply).toBeUndefined();
    expect(lost.patch).toEqual({});
  });

  it("deletes, then removes the row once everything is gone", () => {
    const deleting = decide(facts({ row: row({ desired: "deleted", observed: "running" }) }));
    expect(deleting.delete).toEqual([NAME]);
    expect(deleting.patch).toMatchObject({ observed: "deleting" });
    expect(decide(facts({ row: row({ desired: "deleted", observed: "deleting" }), status: gone })).removeRow).toBe(true);
  });

  it("deletes a reset's previous Sandbox until it is gone", () => {
    const reset = row({ k8sName: "sbx-aaaaaaaaaaaaaaaa-g1", retiring: NAME, rev: 4 });
    const first = decide(facts({ row: reset, status: { ...gone, name: "sbx-aaaaaaaaaaaaaaaa-g1" }, retiring: status() }));
    expect(first.delete).toEqual([NAME]);
    expect(first.apply).toEqual({ mode: "Running", rotateJoin: true });
    const later = decide(facts({ row: reset, status: status({ name: "sbx-aaaaaaaaaaaaaaaa-g1", opId: "sbx-aaaaaaaaaaaaaaaa-g1.r4" }), retiring: gone }));
    expect(later.patch).toMatchObject({ retiring: null, observed: "running" });
  });

  it("waits when the sandboxes service does not answer", () => {
    const decision = decide(facts({ status: undefined }));
    expect(decision.apply).toBeUndefined();
    expect(decision.retryAfterMs).toBeGreaterThan(0);
  });

  it("renders the service's PUT body with the Tenant's lifecycle settings", () => {
    const body = podSpecOf({
      sandboxId: "team/a",
      spec: { image: "node:24", resources: { cpus: 2, memory: "2GiB" }, storage: "10GiB" } as never,
      pod: row({ rev: 7, expiresAt: "2026-10-04T10:00:00.000Z" }).pod,
      config: { lifecycle: { onExpiry: "delete", stopGrace: "20s" } },
      mode: "Running",
      harnessImage: "ghcr.io/nylorun/runtime:0.15",
      joinToken: "secret",
    });
    expect(body).toEqual({
      opId: opIdOf({ k8sName: NAME, rev: 7 }),
      mode: "Running",
      image: "node:24",
      harnessImage: "ghcr.io/nylorun/runtime:0.15",
      cpus: 2,
      memoryMiB: 2048,
      storageGiB: 10,
      stopGraceSeconds: 20,
      shutdownTime: "2026-10-04T10:00:00Z",
      shutdownPolicy: "Delete",
      env: { NYLORUN_SANDBOX_ID: "team/a", NYLORUN_HARNESS_ROOT: "/harness" },
      joinToken: "secret",
    });
  });
});
