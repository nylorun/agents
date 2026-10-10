import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { RestateExecution } from "../../src/adapters/execution/restate.js";
import { MemoryExecution } from "../../src/execution/memory.js";
import type { StackEndpoints } from "../../src/host/stack-config.js";
import { createDatabase, probeDatabase } from "../../src/infra/database.js";
import {
  createExecution,
  executionKind,
  probeExecution,
  validateExecutionConfig,
  workerDeployment,
} from "../../src/infra/execution.js";
import { RUNTIME_VERSION } from "../../src/version.js";
import { createInfra } from "../../src/infra/index.js";
import { createStreams, probeStreams, streamsKind } from "../../src/infra/streams.js";
import { MemoryStreams } from "../../src/streams/memory.js";
import { freePort } from "../host/support.js";

const restate: StackEndpoints = {
  restateIngressUrl: "http://127.0.0.1:1",
  restateAdminUrl: "http://127.0.0.1:2",
  workerUrl: "http://runtime:9080",
};

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A local HTTP server answering `status(path)` for every request. */
async function serve(status: (path: string) => number): Promise<string> {
  const server = createServer((request, response) => {
    response.writeHead(status(request.url ?? "/")).end("ok");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
}

describe("createStreams", () => {
  it("falls back to memory streams without an S2 endpoint", async () => {
    const streams = createStreams({ endpoints: {} });
    expect(streams).toBeInstanceOf(MemoryStreams);
    expect(streamsKind({ endpoints: {} })).toBe("memory");
    await probeStreams(streams, AbortSignal.timeout(1000));
  });

  it("uses S2 with an endpoint, and refuses a token without one", async () => {
    const config = { endpoints: { s2Endpoint: "http://s2:80", s2Token: "ignored" } };
    expect(streamsKind(config)).toBe("s2");
    const streams = createStreams(config);
    expect(streams).not.toBeInstanceOf(MemoryStreams);
    expect(streams.probe).toBeTypeOf("function");
    await streams.close();
    expect(() => createStreams({ endpoints: { s2Token: "t" } })).toThrow(
      /NYLORUN_S2_TOKEN is set without NYLORUN_S2_ENDPOINT/,
    );
  });

  it("probes an unreachable S2 as failed", async () => {
    const port = await freePort();
    const streams = createStreams({ endpoints: { s2Endpoint: `http://127.0.0.1:${port}` } });
    await expect(probeStreams(streams, AbortSignal.timeout(1000))).rejects.toThrow();
    await streams.close();
  });
});

describe("createExecution", () => {
  it("falls back to the memory execution without Restate endpoints", async () => {
    const execution = createExecution({ endpoints: {} });
    expect(execution).toBeInstanceOf(MemoryExecution);
    expect(executionKind({ endpoints: {} })).toBe("memory");
    await probeExecution(execution, AbortSignal.timeout(1000));
  });

  it("uses Restate with both endpoints", () => {
    const execution = createExecution(
      { services: new Set(["core", "loop"] as const), endpoints: { ...restate, restateIdentityKeys: ["publickeyv1_x"] } },
      { servicePrefix: "t_" },
    );
    expect(execution).toBeInstanceOf(RestateExecution);
    expect((execution as RestateExecution).serviceNames.session).toBe("t_NylorunSession");
  });

  it("registers a versioned Worker deployment, forced only outside a container", () => {
    const listen = { host: "0.0.0.0", port: 4000, allowedHosts: [] };
    expect(workerDeployment({ endpoints: {} })).toBeUndefined();
    // In a container (the local stack's Compose environment): the Runtime's version, no force.
    expect(workerDeployment({ listen, endpoints: { workerUrl: "http://runtime:9080" } })).toEqual({
      url: `http://runtime:9080/nylorun/${RUNTIME_VERSION}`,
      force: false,
    });
    // A build of its own, and a development Host, whose code changes under one version.
    expect(
      workerDeployment({ endpoints: { workerUrl: "http://w:9080/", workerVersion: "0.22.0-abc123" } }),
    ).toEqual({ url: "http://w:9080/nylorun/0.22.0-abc123", force: true });
  });

  it("names the missing variable when endpoints are incomplete", () => {
    expect(() =>
      validateExecutionConfig({ endpoints: { restateAdminUrl: "http://r:9070" } }),
    ).toThrow(/NYLORUN_RESTATE_INGRESS_URL is required/);
    expect(() =>
      validateExecutionConfig({ endpoints: { restateIngressUrl: "http://r:8080" } }),
    ).toThrow(/NYLORUN_RESTATE_ADMIN_URL is required/);
    const noWorker = { restateIngressUrl: "http://r:8080", restateAdminUrl: "http://r:9070" };
    expect(() => validateExecutionConfig({ services: new Set(["loop"] as const), endpoints: noWorker })).toThrow(
      /NYLORUN_WORKER_URL is required for --service loop/,
    );
    expect(() => validateExecutionConfig({ endpoints: noWorker })).toThrow(
      /NYLORUN_WORKER_URL is required for --service core,loop/,
    );
    // Without loop a process never serves the Worker endpoint.
    expect(() => validateExecutionConfig({ services: new Set(["core"] as const), endpoints: noWorker })).not.toThrow();
    expect(() => createExecution({ endpoints: { workerUrl: "http://w:9080" } })).toThrow(
      /NYLORUN_WORKER_URL is set without the Restate endpoints/,
    );
    expect(() =>
      createExecution({ endpoints: { restateIdentityKeys: ["publickeyv1_x"] } }),
    ).toThrow(/NYLORUN_RESTATE_IDENTITY_KEY is set without the Restate endpoints/);
  });

  it("probes Restate's admin /health and ingress /restate/health", async () => {
    const seen: string[] = [];
    const admin = await serve((path) => (seen.push(`admin ${path}`), 200));
    const ingress = await serve((path) => (seen.push(`ingress ${path}`), 200));
    const execution = createExecution({
      services: new Set(["core"] as const),
      endpoints: { restateAdminUrl: admin, restateIngressUrl: ingress },
    });
    await probeExecution(execution, AbortSignal.timeout(2000));
    expect(seen.sort()).toEqual(["admin /health", "ingress /restate/health"]);

    const failing = createExecution({
      services: new Set(["core"] as const),
      endpoints: { restateAdminUrl: await serve(() => 503), restateIngressUrl: ingress },
    });
    await expect(probeExecution(failing, AbortSignal.timeout(2000))).rejects.toThrow(
      /Restate health 503/,
    );
  });
});

describe("createDatabase", () => {
  it("requires NYLORUN_DATABASE_URL", () => {
    expect(() => createDatabase({ endpoints: {} })).toThrow(/NYLORUN_DATABASE_URL is required/);
  });

  it("builds a pool without connecting, and probes an unreachable server as failed", async () => {
    const port = await freePort();
    const database = createDatabase({
      endpoints: { databaseUrl: `postgres://nylorun:pw@127.0.0.1:${port}/nylorun` },
    });
    await expect(probeDatabase(database, AbortSignal.timeout(2000))).rejects.toThrow();
    await database.end({ timeout: 1 });
  });

  it("rejects at once on an aborted signal", async () => {
    const database = createDatabase({ endpoints: { databaseUrl: "postgres://x@127.0.0.1:1/y" } });
    await expect(probeDatabase(database, AbortSignal.abort(new Error("gone")))).rejects.toThrow(
      "gone",
    );
    await database.end({ timeout: 1 });
  });
});

describe("createInfra", () => {
  it("builds nothing and no readiness without endpoints", async () => {
    const infra = createInfra({ services: new Set(["core", "loop"] as const), endpoints: {} });
    expect(infra.database ?? infra.execution ?? infra.streams ?? infra.readiness).toBeUndefined();
    await infra.close();
  });

  it("builds each configured client and checks each but S2 (D48)", async () => {
    const infra = createInfra({
      services: new Set(["core"] as const),
      endpoints: {
        restateIngressUrl: "http://127.0.0.1:1",
        restateAdminUrl: "http://127.0.0.1:1",
        s2Endpoint: "http://127.0.0.1:1",
      },
    });
    expect(infra.database).toBeUndefined();
    expect(infra.execution).toBeInstanceOf(RestateExecution);
    expect(infra.streams).toBeDefined();
    const report = await infra.readiness!();
    expect(report.ok).toBe(false);
    expect(report.checks).toEqual({ restate: false });
    await infra.close();
  });

  it("builds S2 streams with no readiness: S2 never decides /ready", async () => {
    const infra = createInfra({
      services: new Set(["core"] as const),
      endpoints: { s2Endpoint: "http://127.0.0.1:1" },
    });
    expect(infra.streams).toBeDefined();
    expect(infra.readiness).toBeUndefined();
    await infra.close();
  });

  it("logs a failing check once and its recovery", async () => {
    let status = 503;
    const url = await serve(() => status);
    const lines: [string, string, Record<string, unknown> | undefined][] = [];
    const logger = {
      info: (message: string, fields?: Record<string, unknown>) => lines.push(["info", message, fields]),
      warn: (message: string, fields?: Record<string, unknown>) => lines.push(["warn", message, fields]),
      error: (message: string, fields?: Record<string, unknown>) => lines.push(["error", message, fields]),
    };
    const infra = createInfra(
      { services: new Set(["core"] as const), endpoints: { restateIngressUrl: url, restateAdminUrl: url } },
      { logger },
    );
    await infra.readiness!();
    await infra.readiness!();
    status = 200;
    expect((await infra.readiness!()).ok).toBe(true);
    expect(lines.map(([level, message, fields]) => [level, message, fields?.check])).toEqual([
      ["warn", "ready_check_failed", "restate"],
      ["info", "ready_check_recovered", "restate"],
    ]);
    await infra.close();
  });
});
