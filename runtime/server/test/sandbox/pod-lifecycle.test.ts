/**
 * A pod Environment's lifecycle as a pure decision (F7.2, D34, protocol 11): create, ready,
 * failed, idle, lost, delete and reset's retiring Sandbox. No TTL: an unused Environment is
 * deleted by the Tenant sweep (`lifecycle.deleteAfter`), not here.
 */
import { describe, expect, it } from "vitest";
import type { PodStatus } from "../../src/sandbox/pods/client.js";
import { decide, imageDigestOf, opIdOf, type PodFacts, type PodRow } from "../../src/sandbox/pods/lifecycle.js";
import { hostTuning } from "../../src/tuning.js";
import { podName } from "../../src/sandbox/pods/name.js";
import { podLifecycleConfig, podSpecOf } from "../../src/sandbox/pods/spec.js";
import { DEV_PRESET_HOSTS } from "../../src/sandbox/policy.js";

const T0 = Date.parse("2026-10-03T10:00:00Z");
const NAME = "sbx-aaaaaaaaaaaaaaaa-g0";

function row(pod: Partial<PodRow["pod"]> = {}): PodRow {
  return {
    id: "s1",
    kind: "pod",
    labels: {},
    recipe: { harness: "nylorun", lifecycle: {} },
    applied: { harness: "nylorun", lifecycle: {} },
    version: 1,
    appliedVersion: 1,
    lastUsedAt: new Date(T0).toISOString(),
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
    image: "python:3.13-slim",
    config: { idleMs: 60_000 },
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
      facts({ status: status({ ready: false, reason: "ImagePullBackOff", message: "no such image" }), now: T0 + hostTuning().pods.readyDeadlineMs + 1 }),
    );
    expect(decision.patch).toMatchObject({ observed: "failed", reason: "ImagePullBackOff: no such image" });
    expect(decision.events).toEqual([{ type: "agent.failed", payload: { reason: "ImagePullBackOff: no such image" } }]);
  });

  it("suspends an idle pod, and re-arms the timer of one used since", () => {
    const base = row({ observed: "running", podUid: "uid-1", lastActiveAt: new Date(T0).toISOString(), hostEpoch: 3 });
    const idle = decide(facts({ row: base, trigger: "idle", now: T0 + 61_000 }));
    expect(idle.patch).toMatchObject({ desired: "suspended", rev: 2, hostEpoch: 4 });
    expect(idle.apply).toEqual({ mode: "Suspended", rotateJoin: false });
    expect(idle.events).toEqual([{ type: "agent.suspended", payload: { reason: "idle" } }]);
    const early = decide(facts({ row: base, trigger: "idle", now: T0 + 30_000 }));
    expect(early.patch.desired).toBeUndefined();
    expect(early.arm).toContainEqual({ timer: "idle", at: T0 + 60_000 });
    expect(decide(facts({ row: base, trigger: "idle", now: T0 + 61_000, busy: true })).patch.desired).toBeUndefined();
  });

  it("arms the idle timer of every running, ready pod it reconciles, whatever woke it", () => {
    // A wake with no turn end (a disk copy, commands through the sandbox route) arms nothing
    // elsewhere: the reconcile that sees the pod ready arms it.
    // Becoming ready counts as activity: the timer runs from the reconcile that sees it ready.
    const woken = row({ observed: "creating", lastActiveAt: new Date(T0).toISOString() });
    expect(decide(facts({ row: woken })).arm).toEqual([{ timer: "idle", at: T0 + 1_000 + 60_000 }]);
    // A pod running long past its idle limit with no timer: due at once, so the timer suspends it.
    const stuck = row({ observed: "running", podUid: "uid-1", lastActiveAt: new Date(T0).toISOString() });
    const later = decide(facts({ row: stuck, now: T0 + 3 * 86_400_000 }));
    expect(later.arm).toEqual([{ timer: "idle", at: T0 + 60_000 }]);
    expect(decide(facts({ row: stuck, trigger: "idle", now: T0 + 3 * 86_400_000 })).patch.desired).toBe("suspended");
    // Not while it starts or is suspended.
    expect(decide(facts({ row: woken, status: status({ ready: false }) })).arm).toEqual([]);
  });

  it("runs the idle period from when a slow start became ready, not from the ask", () => {
    // P1.8 rerun: a 56 s start on a cold node was suspended as idle 3.6 s after it ran.
    const asked = row({ observed: "creating", lastActiveAt: new Date(T0).toISOString() });
    const ready = decide(facts({ row: asked, now: T0 + 56_000 }));
    expect(ready.patch).toMatchObject({ observed: "running", lastActiveAt: new Date(T0 + 56_000).toISOString() });
    expect(ready.arm).toEqual([{ timer: "idle", at: T0 + 56_000 + 60_000 }]);
    const running = row({ observed: "running", podUid: "uid-1", lastActiveAt: new Date(T0 + 56_000).toISOString() });
    expect(decide(facts({ row: running, trigger: "idle", now: T0 + 60_000 })).patch.desired).toBeUndefined();
    // A pod already running keeps its last activity: a reconcile is no activity.
    expect(decide(facts({ row: running, now: T0 + 90_000 })).patch.lastActiveAt).toBeUndefined();
  });

  it("looks again one idle period later when the timer fires during a turn", () => {
    const base = row({ observed: "running", podUid: "uid-1", lastActiveAt: new Date(T0).toISOString() });
    const busy = decide(facts({ row: base, trigger: "idle", now: T0 + 61_000, busy: true }));
    expect(busy.patch.desired).toBeUndefined();
    expect(busy.arm).toEqual([{ timer: "idle", at: T0 + 61_000 + 60_000 }]);
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

  it("fails a running pod at once when its sandbox crashed, saying what it lost", () => {
    const running = row({ observed: "running", podUid: "uid-1", lastActiveAt: new Date(T0).toISOString() });
    const crashed = status({ ready: false, podPhase: undefined, reason: "Crashed", message: "worker pod went away while hosting the actor" });
    const decision = decide(facts({ row: running, status: crashed, now: T0 + 2_000 }));
    expect(decision.patch).toMatchObject({ observed: "failed" });
    expect(decision.patch.reason).toMatch(/^Crashed: worker pod went away while hosting the actor\. .*last suspend/);
    expect(decision.events).toEqual([{ type: "agent.failed", payload: { reason: decision.patch.reason } }]);
    expect(decision.apply).toBeUndefined();
  });

  it("records a drain once, and waits for a moving pod instead of failing it (suspend before drain)", () => {
    const drainedAt = "2026-10-03T12:00:00.5Z";
    // Long past the ready deadline: a pod that has run for days.
    const later = T0 + 3 * 24 * 3600_000;
    const running = row({ observed: "running", podUid: "uid-1", lastActiveAt: new Date(later).toISOString() });
    const moving = status({ ready: false, podPhase: undefined, reason: "Moving", message: "suspended because its worker stopped", drainedAt });
    const first = decide(facts({ row: running, status: moving, now: later }));
    expect(first.patch).toEqual({ drainedAt });
    expect(first.events).toEqual([{ type: "agent.suspended", payload: { reason: "drain" } }]);
    expect(first.retryAfterMs).toBeDefined();
    expect(first.apply).toBeUndefined();
    // Recorded: no second event while it moves, and none once it runs again.
    const recorded = row({ observed: "running", podUid: "uid-1", lastActiveAt: new Date(later).toISOString(), drainedAt });
    const again = decide(facts({ row: recorded, status: moving, now: later + 1_000 }));
    expect(again.events).toEqual([]);
    expect(again.patch.observed).toBeUndefined();
    const back = decide(facts({ row: recorded, status: status({ drainedAt }), now: later + 2_000 }));
    expect(back.events).toEqual([]);
    expect(back.patch.observed).toBeUndefined();
  });

  it("leaves a crash during a wake to the wake, which reverts the sandbox", () => {
    const waking = row({ observed: "creating", rev: 2, podUid: undefined, startedAt: new Date(T0).toISOString() });
    const crashed = status({ opId: `${NAME}.r2`, ready: false, podPhase: undefined, reason: "Crashed", message: "x" });
    const decision = decide(facts({ row: waking, status: crashed, now: T0 + 2_000 }));
    expect(decision.events).toEqual([]);
    expect(decision.patch.observed).toBeUndefined();
    expect(decision.retryAfterMs).toBeDefined();
  });

  it("records a crash an idle suspend finds, once", () => {
    const suspending = row({ desired: "suspended", rev: 2, observed: "running", podUid: "uid-1" });
    const crashed = status({ opId: `${NAME}.r2`, mode: "Suspended", ready: false, podPhase: undefined, reason: "Crashed", message: "worker pod went away while hosting the actor" });
    const first = decide(facts({ row: suspending, status: crashed }));
    expect(first.patch).toMatchObject({ observed: "suspended" });
    expect(first.events.map((e) => e.type)).toEqual(["agent.failed"]);
    const recorded = row({ desired: "suspended", rev: 2, observed: "suspended", podUid: "uid-1", reason: first.patch.reason ?? undefined });
    expect(decide(facts({ row: recorded, status: crashed })).events).toEqual([]);
  });

  it("never expires: a running pod past any age arms only its idle timer", () => {
    const old = row({ observed: "running", podUid: "uid-1", hostEpoch: 2, lastActiveAt: new Date(T0).toISOString() });
    const decision = decide(facts({ row: old, trigger: "idle", now: T0 + 30_000 }));
    expect(decision.arm).toEqual([{ timer: "idle", at: T0 + 60_000 }]);
    expect(decision.patch).toEqual({});
    expect(decision.events).toEqual([]);
    expect(decision.delete).toEqual([]);
  });

  it("idles after the Environment's lifecycle.idle, at most the Tenant's", () => {
    const tenant = { limits: { idle: "15m" } };
    expect(podLifecycleConfig(tenant).idleMs).toBe(15 * 60_000);
    expect(podLifecycleConfig(tenant, { lifecycle: { idle: "5m" } }).idleMs).toBe(5 * 60_000);
    expect(podLifecycleConfig(tenant, { lifecycle: { idle: "1h" } }).idleMs).toBe(15 * 60_000);
    expect(podLifecycleConfig({}, { lifecycle: {} }).idleMs).toBe(15 * 60_000);
  });

  it("is lost when a joined incarnation's volume or Sandbox is gone, and stays lost", () => {
    const joined = row({ observed: "running", podUid: "uid-1", hostEpoch: 5 });
    const pvc = decide(facts({ row: joined, status: status({ volume: "missing", ready: false }) }));
    expect(pvc.patch).toMatchObject({ observed: "lost", hostEpoch: 6 });
    expect(pvc.events[0]?.type).toBe("agent.lost");
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

  it("pins only a digest of the repository the Environment asked for", () => {
    const digest = "b".repeat(64);
    // kind names an image it loads onto a node `import-<date>`: no registry serves that name.
    const imported = `docker.io/library/import-2026-10-16@sha256:${digest}`;
    expect(imageDigestOf(imported, "python:3.13-slim")).toBeUndefined();
    expect(decide(facts({ status: status({ imageID: imported }) })).patch.imageDigest).toBeUndefined();
    expect(imageDigestOf(`docker.io/library/node@sha256:${digest}`, "python:3.13-slim")).toBeUndefined();
    // A registry with a host, a namespaced Docker Hub name and a digest-pinned request all match.
    expect(imageDigestOf(`ghcr.io/acme/box@sha256:${digest}`, "ghcr.io/acme/box:1.2")).toBe(`ghcr.io/acme/box@sha256:${digest}`);
    expect(imageDigestOf(`docker.io/acme/box@sha256:${digest}`, "acme/box")).toBe(`docker.io/acme/box@sha256:${digest}`);
    expect(imageDigestOf(`localhost:5000/box@sha256:${digest}`, `localhost:5000/box@sha256:${digest}`)).toBe(`localhost:5000/box@sha256:${digest}`);
    expect(decide(facts({ image: "ghcr.io/acme/box:1.2", status: status({ imageID: `ghcr.io/acme/box@sha256:${digest}` }) })).patch.imageDigest).toBe(`ghcr.io/acme/box@sha256:${digest}`);
  });

  it("waits when the sandboxes service does not answer", () => {
    const decision = decide(facts({ status: undefined }));
    expect(decision.apply).toBeUndefined();
    expect(decision.retryAfterMs).toBeGreaterThan(0);
  });

  it("pins the image the first ready pod runs by digest, and runs that digest from then on (Q14)", () => {
    const pulled = `docker.io/library/python@sha256:${"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`;
    expect(imageDigestOf(pulled, "python:3.13-slim")).toBe(pulled);
    expect(imageDigestOf(`docker-pullable://${pulled}`, "python:3.13-slim")).toBe(pulled);
    // A locally loaded image has no repository to pull it from: nothing is pinned.
    expect(imageDigestOf(`sha256:${"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`, "python:3.13-slim")).toBeUndefined();
    expect(imageDigestOf(undefined, "python:3.13-slim")).toBeUndefined();
    expect(decide(facts({ status: status({ imageID: pulled }) })).patch).toMatchObject({ observed: "running", imageDigest: pulled });
    // Pinned once: a later pod's image id changes nothing.
    const pinned = row({ observed: "running", imageDigest: pulled });
    expect(decide(facts({ row: pinned, status: status({ imageID: "docker.io/library/python@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }) })).patch).not.toHaveProperty("imageDigest");
    const spec = podSpecOf({
      environmentId: "team/a",
      spec: { image: "python:3.13-slim" } as never,
      pod: pinned.pod,
      config: {},
      mode: "Running",
      harnessImage: "ghcr.io/nylorun/runtime:0.15",
    });
    expect(spec.image).toBe(pulled);
    // The resolved network rides along for the Substrate backend (ADR-138).
    expect(spec.network).toMatchObject({ preset: "dev", suffixes: [] });
    expect(spec.network?.hosts).toContain("pypi.org");
    const open = podSpecOf({
      environmentId: "team/a",
      spec: { image: "python:3.13-slim", network: { preset: "open", allow: ["*.example.com", "api.acme.dev"] } } as never,
      pod: pinned.pod,
      config: {},
      mode: "Running",
      harnessImage: "ghcr.io/nylorun/runtime:0.15",
    });
    expect(open.network).toEqual({ preset: "open", hosts: ["api.acme.dev"], suffixes: [".example.com"] });
  });

  it("runs the engine an image the Tenant lists carries, and copies it in otherwise (ADR-99)", () => {
    const repo = "ghcr.io/nylorun/bot-worker";
    const digest = `${repo}@sha256:${"c".repeat(64)}`;
    const input = {
      environmentId: "team/a",
      spec: { image: `${repo}:0.38.0-beta` } as never,
      config: { engine: { images: [repo] } },
      mode: "Running" as const,
      harnessImage: "ghcr.io/nylorun/runtime:0.38.0-beta",
    };
    const first = podSpecOf({ ...input, pod: row().pod });
    expect(first.entrypoint).toBe("builtin");
    expect(first).not.toHaveProperty("harnessImage");
    // An engine of another Runtime version, seen on this digest: copied in instead.
    const older = podSpecOf({ ...input, pod: row({ imageDigest: digest, engineImage: { version: "0.0.1-old", digest } }).pod });
    expect(older).toMatchObject({ image: digest, harnessImage: "ghcr.io/nylorun/runtime:0.38.0-beta" });
    expect(older).not.toHaveProperty("entrypoint");
    // Not listed: copied, as for any image. A custom harness keeps its own entrypoint.
    expect(podSpecOf({ ...input, config: {}, pod: row().pod })).not.toHaveProperty("entrypoint");
    expect(podSpecOf({ ...input, harness: "acme", pod: row().pod }).entrypoint).toBe("image");
  });

  it("renders the service's PUT body with the Tenant's lifecycle settings", () => {
    const body = podSpecOf({
      environmentId: "team/a",
      spec: { image: "node:24", resources: { cpus: 2, memory: "2GiB" }, storage: "10GiB" } as never,
      pod: row({ rev: 7 }).pod,
      config: { lifecycle: { stopGrace: "20s" } },
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
      shutdownPolicy: "Retain",
      env: { NYLORUN_SANDBOX_ID: "team/a", NYLORUN_HARNESS_ROOT: "/harness" },
      joinToken: "secret",
      network: { preset: "dev", hosts: [...DEV_PRESET_HOSTS].sort(), suffixes: [] },
    });
  });
});
