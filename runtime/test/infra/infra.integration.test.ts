/**
 * The infra factories against the Docker test stack: each client is built from
 * the stack's endpoints the way `host/main.ts` builds them, and each probe
 * answers. Nothing here starts a Worker.
 */
import { describe, expect, it } from "vitest";
import { RestateExecution } from "../../src/adapters/execution/restate.js";
import { parseStackConfig } from "../../src/host/stack-config.js";
import { createDatabase, probeDatabase } from "../../src/infra/database.js";
import { createExecution, probeExecution } from "../../src/infra/execution.js";
import { createInfra } from "../../src/infra/index.js";
import { createStreams, probeStreams } from "../../src/infra/streams.js";
import { MemoryStreams } from "../../src/streams/memory.js";
import { freePort } from "../host/support.js";
import { STACK_ENABLED, stackEndpoints } from "../stack/endpoints.js";

function stackConfig(overrides: Record<string, string> = {}) {
  const endpoints = stackEndpoints();
  return parseStackConfig(
    {
      NYLORUN_DATABASE_URL: endpoints.postgres.url,
      NYLORUN_RESTATE_INGRESS_URL: endpoints.restate.ingressUrl,
      NYLORUN_RESTATE_ADMIN_URL: endpoints.restate.adminUrl,
      NYLORUN_WORKER_URL: "http://host.docker.internal:9080",
      NYLORUN_S2_ENDPOINT: endpoints.s2.endpoint,
      NYLORUN_S2_TOKEN: "ignored",
      ...overrides,
    },
    ["--service", "core,loop"],
  );
}

describe.skipIf(!STACK_ENABLED)("infra factories on the test stack", () => {
  it("builds Postgres, Restate and S2 clients and probes each", async () => {
    const config = stackConfig();
    const database = createDatabase(config, { max: 1 });
    const execution = createExecution(config);
    const streams = createStreams(config);
    try {
      expect(execution).toBeInstanceOf(RestateExecution);
      expect(streams).not.toBeInstanceOf(MemoryStreams);
      await probeDatabase(database, AbortSignal.timeout(5000));
      await probeExecution(execution, AbortSignal.timeout(5000));
      await probeStreams(streams, AbortSignal.timeout(5000));
    } finally {
      await database.end({ timeout: 5 });
      await streams.close();
    }
  });

  it("reports every check ready through createInfra", async () => {
    const infra = createInfra(stackConfig());
    try {
      expect(await infra.readiness!()).toEqual({
        ok: true,
        checks: { postgres: true, restate: true, s2: true },
        errors: {},
      });
    } finally {
      await infra.close();
    }
  });

  it("reports the one dependency that is unreachable", async () => {
    const port = await freePort();
    const infra = createInfra(
      stackConfig({ NYLORUN_S2_ENDPOINT: `http://127.0.0.1:${port}` }),
    );
    try {
      const report = await infra.readiness!();
      expect(report.ok).toBe(false);
      expect(report.checks).toEqual({ postgres: true, restate: true, s2: false });
      expect(report.errors.s2).toBeTruthy();
    } finally {
      await infra.close();
    }
  });
});
