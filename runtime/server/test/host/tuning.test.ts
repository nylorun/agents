/**
 * Host tuning (`tuning.ts`, B15): one schema of the processes' timings, retries and internal
 * sizes, each with a default equal to the value the Runtime used before; `NYLORUN_TUNING` sets
 * any of them, read once at start. A value set reaches the code that uses it.
 */
import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_HOST_TUNING,
  MAX_TIMER_MS,
  hostTuning,
  hostTuningOf,
  hostTuningPaths,
  parseHostTuning,
  podTuningEnv,
  useHostTuning,
  type HostTuningInput,
} from "../../src/tuning.js";
import { parseStackConfig, StackConfigError } from "../../src/host/stack-config.js";
import { createReadiness, type Probe } from "../../src/infra/readiness.js";
import { createTenantModule } from "../../src/tenant/module.js";
import { harnessRunTokens } from "../../src/harness/run-tokens.js";
import { engineOptionsOf } from "../../src/harness/service.js";
import { createCertificateAuthority, issueLeafCertificate, leafKeyPair } from "../../src/keys/x509.js";
import { createInflightCalls } from "../../src/gates/inflight.js";
import { podSpecOf } from "../../src/sandbox/pods/spec.js";
import { decide } from "../../src/sandbox/pods/lifecycle.js";
import { silentLogger } from "../tenant/support.js";

/** Sets the process's tuning for one test; `afterEach` puts the defaults back. */
function tune(input: HostTuningInput): void {
  useHostTuning(hostTuningOf(input), input as Record<string, unknown>);
}

afterEach(() => useHostTuning(DEFAULT_HOST_TUNING));

describe("the Host tuning schema", () => {
  it("defaults to the values the Runtime used before they were configuration", () => {
    const t = DEFAULT_HOST_TUNING;
    expect(t.keys).toEqual({
      bodyBytes: 1024 * 1024,
      timeoutMs: 30_000,
      leafBackdateMs: 300_000,
      leafLifetimeMs: 3_600_000,
      caBackdateMs: 3_600_000,
      caLifetimeDays: 3650,
    });
    expect(t.harnessApi).toMatchObject({
      joinBodyBytes: 8 * 1024,
      reportBodyBytes: 64 * 1024,
      offerWaitMs: 10_000,
      podOfferWaitMs: 60_000,
      loopbackConnectTimeoutMs: 10_000,
      loopbackBackoff: { minMs: 50, maxMs: 500 },
      rolloverSteps: 50,
      rolloverMs: 20 * 60_000,
    });
    expect(t.tenant).toMatchObject({
      openTimeoutMs: 30_000,
      openRetry: { minMs: 1_000, maxMs: 30_000 },
      ownerLeaseMs: 30_000,
      busyRetryMinMs: 25,
      unavailableRetryMs: 1_000,
      drainTimeoutMs: 30_000,
      statusTimeoutMs: 5_000,
      signingKeyRotationGraceMs: 60_000,
      retryAfterSeconds: 5,
    });
    expect(t.sweep).toEqual({
      intervalMs: 5_000,
      batchSize: 100,
      signalRetentionMs: 3_600_000,
      outboxGraceMs: 30_000,
      orphanScanMs: 60_000,
      drainBudgetMs: 2_000,
      outboxAttempts: 10,
      outboxRetry: { minMs: 5_000, maxMs: 600_000 },
      stalePodMs: 60_000,
    });
    expect(t.execution).toEqual({
      stopGraceMs: 30_000,
      dedupeRetentionMs: 24 * 3_600_000,
      memoryRetryMs: 50,
      memoryAttempts: 5,
    });
    expect(t.gates).toMatchObject({
      clientTimeoutMs: 630_000,
      shortTimeoutMs: 2_000,
      keepAliveMs: 30_000,
      requestTimeoutMs: 660_000,
      mcpIdleMs: 15 * 60_000,
      mcpSweepMinMs: 1_000,
      mcpSweepMaxMs: 60_000,
      toolCrossingTtlMs: 24 * 3_600_000,
      toolCrossingPruneMs: 3_600_000,
      drainMs: 10_000,
      inflightTtlMs: 30 * 60_000,
      inflightMax: 10_000,
    });
    expect(t.egress).toEqual({
      maxTunnelsPerSandbox: 64,
      idleMs: 5 * 60_000,
      cacheMs: 5_000,
      cacheEntries: 4_096,
      connectTimeoutMs: 10_000,
      headersTimeoutMs: 10_000,
      requestTimeoutMs: 15_000,
      credentialsHeadersTimeoutMs: 60_000,
    });
    expect(t.pods).toMatchObject({
      readyDeadlineMs: 5 * 60_000,
      pollMs: 2_000,
      unreachableRetryMs: 5_000,
      reconcileRetryMs: 5_000,
      requestTimeoutMs: 20_000,
      readyProbeTimeoutMs: 3_000,
      waitMs: 30_000,
      waitSlackMs: 10_000,
    });
    expect(t.harness).toMatchObject({
      pingMs: 30_000,
      silenceMs: 90_000,
      reconnect: { minMs: 500, maxMs: 10_000 },
      handshakeTimeoutMs: 10_000,
      stopMs: 10_000,
      podStopMs: 7_000,
      runTokensMax: 10_000,
      mcpSweepMs: 60_000,
      mcpIdleMs: 15 * 60_000,
      podRenewMs: 5 * 60_000,
      networkPolicyTimeoutMs: 120_000,
      networkConfirmations: 3,
      setupReportTailChars: 4 * 1024,
    });
    expect(t.streams).toMatchObject({
      retry: { minMs: 100, maxMs: 2_000 },
      relayRetry: { minMs: 50, maxMs: 2_000 },
      relayBatchRecords: 500,
      relayBatchBytes: 768 * 1024,
      s2ConflictAttempts: 6,
      s2ConflictRetryMs: 25,
      s2BasinRetryMs: 500,
      s2BasinDeletionWaitMs: 120_000,
    });
    expect(t.restate).toMatchObject({
      sendRetryMs: 10_000,
      inactivityMs: 3_600_000,
      handlerRetry: { minMs: 100, maxMs: 30_000 },
      handlerAttempts: 70,
      registrationDeadlineMs: 60_000,
    });
    expect(t.postgres).toMatchObject({
      poolSize: 10,
      statementTimeoutMs: 60_000,
      idleInTransactionTimeoutMs: 60_000,
      controlPollMs: 5_000,
      controlWindowSeconds: 120,
    });
    expect(t.objectStore).toMatchObject({ partSizeBytes: 8 * 1024 * 1024, attempts: 3 });
    expect(t.traces).toMatchObject({ timeoutMs: 10_000, retries: 3, backoffMs: 500 });
    // The engine's own defaults stay in `@nylorun/harness`: nothing is set here.
    expect(t.engine).toEqual({});
  });

  it("takes part of a group and keeps the defaults of the rest", () => {
    const t = hostTuningOf({ tenant: { openRetry: { minMs: 5 } }, keys: { timeoutMs: 1_000 } });
    expect(t.tenant.openRetry).toEqual({ minMs: 5, maxMs: 30_000 });
    expect(t.tenant.openTimeoutMs).toBe(30_000);
    expect(t.keys).toEqual({ ...DEFAULT_HOST_TUNING.keys, timeoutMs: 1_000 });
  });

  it("refuses an unknown key, a value past its ceiling, and settings that contradict, naming each", () => {
    expect(() => hostTuningOf({ keys: { timeout: 1 } })).toThrow(/keys: Unrecognized key/);
    expect(() => hostTuningOf({ bogus: {} })).toThrow(/Unrecognized key/);
    expect(() => hostTuningOf({ keys: { timeoutMs: -1 } })).toThrow(/keys\.timeoutMs/);
    expect(() => hostTuningOf({ keys: { timeoutMs: 1.5 } })).toThrow(/keys\.timeoutMs/);
    expect(() => hostTuningOf({ keys: { timeoutMs: MAX_TIMER_MS + 1 } })).toThrow(/keys\.timeoutMs/);
    expect(hostTuningOf({ keys: { timeoutMs: MAX_TIMER_MS } }).keys.timeoutMs).toBe(MAX_TIMER_MS);
    // S3 takes parts of 5 MiB to 5 GiB.
    expect(() => hostTuningOf({ objectStore: { partSizeBytes: 1024 } })).toThrow(/objectStore\.partSizeBytes/);
    // S2 takes 1000 records and 1 MiB a batch.
    expect(() => hostTuningOf({ streams: { relayBatchRecords: 1001 } })).toThrow(/streams\.relayBatchRecords/);
    expect(() => hostTuningOf({ streams: { relayBatchBytes: 2 * 1024 * 1024 } })).toThrow(/relayBatchBytes/);
    // The sandboxes service waits 30 s at most.
    expect(() => hostTuningOf({ pods: { waitMs: 60_000 } })).toThrow(/pods\.waitMs/);
    // A dedupe key is kept a day at least (§12.3).
    expect(() => hostTuningOf({ execution: { dedupeRetentionMs: 60_000 } })).toThrow(/dedupeRetentionMs/);
    expect(() => hostTuningOf({ tenant: { openRetry: { minMs: 10, maxMs: 5 } } })).toThrow(
      /tenant\.openRetry: minMs must be at most maxMs/,
    );
    expect(() => hostTuningOf({ gates: { requestTimeoutMs: 600_000 } })).toThrow(
      /gates\.requestTimeoutMs: must be above gates\.clientTimeoutMs/,
    );
    expect(() => hostTuningOf({ postgres: { controlWindowSeconds: 1 } })).toThrow(/controlWindowSeconds/);
    expect(() => hostTuningOf({ engine: { compaction: { keepShare: 2 } } })).toThrow(/engine\.compaction\.keepShare/);
    expect(() => hostTuningOf({ engine: { outputs: { dir: "outputs" } } })).toThrow(/engine\.outputs\.dir/);
  });

  it("reads NYLORUN_TUNING as a JSON object, and keeps the overrides as written", () => {
    expect(parseHostTuning(undefined)).toEqual({ tuning: DEFAULT_HOST_TUNING });
    const parsed = parseHostTuning('{"sweep":{"intervalMs":1000}}');
    expect(parsed.tuning.sweep.intervalMs).toBe(1_000);
    expect(parsed.overrides).toEqual({ sweep: { intervalMs: 1_000 } });
    expect(() => parseHostTuning("{")).toThrow(/NYLORUN_TUNING must be a JSON object/);
    expect(() => parseHostTuning("[]")).toThrow(/NYLORUN_TUNING must be a JSON object/);
  });

  it("is part of the stack configuration of every service, and a bad one stops the process", () => {
    const env = { NYLORUN_TUNING: '{"harness":{"pingMs":1000}}' };
    expect(parseStackConfig(env, []).tuning?.values.harness.pingMs).toBe(1_000);
    const gates = { ...env, NYLORUN_GATES_TOKEN: "a".repeat(64), NYLORUN_GATES_LISTEN_HOST: "127.0.0.1" };
    expect(parseStackConfig(gates, ["--service", "gates"]).tuning?.values.harness.pingMs).toBe(1_000);
    const harness = parseStackConfig(
      {
        ...env,
        NYLORUN_HARNESS_URL: "ws://runtime:4200/nylorun/harness/v1",
        NYLORUN_HARNESS_TOKEN: "b".repeat(64),
        NYLORUN_GATES_URL: "http://gateway:4100",
      },
      ["--service", "harness"],
    );
    expect(harness.tuning?.values.harness.pingMs).toBe(1_000);
    expect(parseStackConfig({}, []).tuning).toBeUndefined();
    expect(() => parseStackConfig({ NYLORUN_TUNING: '{"harness":{"pingMs":0}}' }, [])).toThrow(StackConfigError);
    expect(() => parseStackConfig({ NYLORUN_TUNING: '{"harness":{"pingMs":0}}' }, [])).toThrow(/harness\.pingMs/);
  });

  it("hands a pod's engine the harness and engine groups the operator set, within the pod's env limit", () => {
    expect(podTuningEnv()).toEqual({});
    tune({ tenant: { openTimeoutMs: 1_000 } });
    expect(podTuningEnv()).toEqual({});
    tune({ tenant: { openTimeoutMs: 1_000 }, harness: { pingMs: 1_000 }, engine: { leaseRetryMs: 5 } });
    expect(JSON.parse(podTuningEnv().NYLORUN_TUNING!)).toEqual({
      harness: { pingMs: 1_000 },
      engine: { leaseRetryMs: 5 },
    });
    const big = JSON.stringify({ engine: { outputs: { dir: `/${"a".repeat(5000)}` } } });
    expect(() => parseHostTuning(big)).toThrow(/at most 4096 bytes/);
  });

  it("is listed whole in the deployment guide", () => {
    const guide = readFileSync(new URL("../../../../guides/DEPLOYMENT.md", import.meta.url), "utf8");
    const missing = hostTuningPaths().filter((path) => !guide.includes(`\`${path}\``));
    expect(missing).toEqual([]);
  });
});

describe("a value from the Host tuning reaches the code that uses it", () => {
  it("bounds a readiness pass (infra)", async () => {
    tune({ host: { readinessTimeoutMs: 30 } });
    const hangs: Probe = (signal) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    const report = await createReadiness({ postgres: hangs })();
    expect(report.errors).toEqual({ postgres: "timed out after 30 ms" });
  });

  it("bounds opening the Tenant (tenant)", async () => {
    tune({ tenant: { openTimeoutMs: 5 } });
    const slow = createTenantModule({
      open: () => new Promise(() => undefined),
      logger: silentLogger(),
    });
    await slow.start();
    expect(slow.tenant().cause?.code).toBe("open-timeout");
    await slow.close();
  });

  it("dates the egress leaf certificate (keys)", () => {
    tune({ keys: { leafLifetimeMs: 10 * 60_000, leafBackdateMs: 0 } });
    const now = new Date("2026-10-16T12:00:00Z");
    const authority = createCertificateAuthority({ commonName: "test", now });
    const leaf = new X509Certificate(
      issueLeafCertificate({ authority, host: "example.com", publicKey: leafKeyPair().publicKey, now }),
    );
    expect(Date.parse(leaf.validTo) - Date.parse(leaf.validFrom)).toBe(10 * 60_000);
  });

  it("keeps settled model calls for the gate (gates)", async () => {
    tune({ gates: { inflightMax: 1 } });
    let clock = 0;
    const calls = createInflightCalls<string>({ now: () => clock });
    await calls.run("a", "h", async () => "first");
    clock += 1;
    await calls.run("b", "h", async () => "second");
    // Past its one entry the oldest settled one goes: "a" runs again.
    let ran = false;
    await calls.run("a", "h", async () => {
      ran = true;
      return "again";
    });
    expect(ran).toBe(true);
  });

  it("times a pod's checks, and goes into the pod's spec for its engine (sandbox pods)", () => {
    const input = {
      environmentId: "env-a",
      spec: { image: "python:3.13-slim" } as never,
      pod: { k8sName: "sbx-a-g0", volumeGen: 0, desired: "running", observed: "creating", hostEpoch: 1, rev: 1 } as never,
      config: {},
      mode: "Running" as const,
      harnessImage: "ghcr.io/nylorun/runtime:1",
    };
    expect(podSpecOf(input).env).not.toHaveProperty("NYLORUN_TUNING");
    tune({ harness: { podRenewMs: 60_000 }, pods: { pollMs: 1_234 } });
    expect(JSON.parse(podSpecOf(input).env!.NYLORUN_TUNING!)).toEqual({ harness: { podRenewMs: 60_000 } });
    const decision = decide({
      row: { id: "s1", kind: "pod", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), pod: { k8sName: "sbx-a-g0", rev: 1, desired: "running", observed: "creating", hostEpoch: 1, startedAt: new Date(0).toISOString() } } as never,
      config: { idleMs: 60_000 },
      status: { name: "sbx-a-g0", exists: true, deleting: false, ready: false, suspended: false, expired: false, volume: "present", podPhase: "Pending", opId: "sbx-a-g0.r1" } as never,
      busy: false,
      now: 1_000,
      trigger: "reconcile",
    });
    expect(decision.retryAfterMs).toBe(1_234);
  });

  it("caps a harness's run tokens (harness host)", () => {
    tune({ harness: { runTokensMax: 1 } });
    const tokens = harnessRunTokens();
    tokens.grant({ sessionId: "s1", token: "t1" } as never);
    tokens.grant({ sessionId: "s2", token: "t2" } as never);
    expect(tokens.token("s1")).toBeUndefined();
    expect(tokens.token("s2")).toBe("t2");
  });

  it("passes the engine group to createHarness, only what is set (engine)", () => {
    expect(engineOptionsOf(hostTuning().engine)).toEqual({});
    tune({ engine: { compaction: { keepTokens: 1_000 }, partialOutputChars: 10, resendDelaysMs: [5] } });
    expect(engineOptionsOf(hostTuning().engine)).toEqual({
      compaction: { keepTokens: 1_000 },
      partialOutputChars: 10,
      resendDelaysMs: [5],
    });
  });
});
