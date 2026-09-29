/**
 * The operator listener: with it, the public listener serves the Tenant API only (admin
 * routes are the opaque 404) and the operator listener serves the Admin API and the Tenant
 * API, never to browsers. Without it, one listener serves everything, as before.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startEphemeralRuntime,
  type EphemeralRuntime,
} from "../../src/tenant/ephemeral.js";

let root: string;
let split: EphemeralRuntime;
let combinedRoot: string;
let combined: EphemeralRuntime;

const admin = (url: string, key: string, path = "/v1/admin/status", init: RequestInit = {}) =>
  fetch(`${url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${key}`, "nylorun-protocol": "2", ...init.headers },
  });

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "nylorun-operator-"));
  combinedRoot = await mkdtemp(join(tmpdir(), "nylorun-combined-"));
  split = await startEphemeralRuntime({
    hostRoot: root,
    operatorListener: true,
    browserAccess: true,
    model: { kind: "fixture" },
  });
  combined = await startEphemeralRuntime({ hostRoot: combinedRoot, model: { kind: "fixture" } });
});
afterAll(async () => {
  await split?.close();
  await combined?.close();
  await rm(root, { recursive: true, force: true });
  await rm(combinedRoot, { recursive: true, force: true });
});

describe("split listeners", () => {
  it("serves the Admin API only on the operator listener", async () => {
    expect(split.adminUrl).not.toBe(split.url);
    expect((await admin(split.adminUrl, split.adminKey)).status).toBe(200);
    const onPublic = await admin(split.url, split.adminKey);
    expect(onPublic.status).toBe(404);
    // The same body as a wrong admin key on the operator listener.
    const wrongKey = await admin(split.adminUrl, "0".repeat(64));
    expect(await onPublic.text()).toBe(await wrongKey.text());
    const shutdown = await admin(split.url, split.adminKey, "/v1/admin/host/shutdown", {
      method: "POST",
    });
    expect(shutdown.status).toBe(404);
  });

  it("serves the Tenant API on both, and browsers only on the public one", async () => {
    const tenant = {
      authorization: `Bearer ${split.applicationKey}`,
      "nylorun-tenant": split.tenantId,
      "nylorun-protocol": "2",
    };
    for (const url of [split.url, split.adminUrl])
      expect((await fetch(`${url}/v1/agents`, { headers: tenant })).status).toBe(200);
    const preflight = (url: string) =>
      fetch(`${url}/v1/sessions`, {
        method: "OPTIONS",
        headers: { origin: "http://localhost:5173", "access-control-request-method": "GET" },
      });
    expect((await preflight(split.url)).status).toBe(204);
    expect((await preflight(split.adminUrl)).status).toBe(403);
  });

  it("answers health and readiness on both", async () => {
    for (const url of [split.url, split.adminUrl]) {
      expect((await fetch(`${url}/health`)).status).toBe(200);
      expect((await fetch(`${url}/ready`)).status).toBe(200);
    }
  });

  it("checks the Host header against its own port", async () => {
    const { request } = await import("node:http");
    const status = (url: string, host: string) =>
      new Promise<number>((resolve, reject) => {
        const target = new URL(`${url}/health`);
        request(
          { hostname: target.hostname, port: target.port, path: target.pathname, headers: { host } },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          }
        )
          .on("error", reject)
          .end();
      });
    const port = new URL(split.adminUrl).port;
    const publicPort = new URL(split.url).port;
    expect(await status(split.adminUrl, `localhost:${publicPort}`)).toBe(421);
    expect(await status(split.adminUrl, `localhost:${port}`)).toBe(200);
    expect(await status(split.url, `localhost:${port}`)).toBe(421);
  });
});

describe("one listener", () => {
  it("serves the Admin API and the Tenant API on the same port, as before", async () => {
    expect(combined.adminUrl).toBe(combined.url);
    expect((await admin(combined.url, combined.adminKey)).status).toBe(200);
  });
});

describe("a taken operator port", () => {
  it("fails to listen and leaves the public port closed", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = (blocker.address() as { port: number }).port;
    const { createHost } = await import("../../src/host/create-host.js");
    // A module that is never started: listening fails before it would be.
    const host = createHost({
      hostRoot: root,
      module: {
        started: false,
        start: async () => {},
        close: async () => {},
        list: async () => [],
        summarize: async () => ({}),
      } as never,
      config: { hostId: "host_test", host: "127.0.0.1", port: 0 },
      credentials: { adminKey: "a".repeat(64) },
      logger: { info() {}, warn() {}, error() {} } as never,
      coreVersion: "test",
      operator: { host: "127.0.0.1", port },
    });
    await expect(host.listen()).rejects.toMatchObject({ exitCode: 98 });
    await new Promise((resolve) => blocker.close(resolve));
  });
});
