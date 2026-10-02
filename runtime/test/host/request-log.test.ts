/**
 * Characterization of the Host's request log: which requests are logged, with which status,
 * path and Tenant, for every kind of rejection and for streams. Pinned to a committed fixture
 * so the Hono migration keeps the log a client's operator reads unchanged.
 */
import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import { createHostLogger } from "../../src/host/logger.js";
import {
  startEphemeralRuntime,
  type EphemeralRuntime,
} from "../../src/tenant/ephemeral.js";
import { testPool } from "../support/store.js";

const TENANT = `tn_${"0".repeat(22)}rqst`;
const APPLICATION_KEY = "request-log-application-key-00000";
const ADMIN_KEY = "request-log-admin-key-000000000000";

let root: string;
let rt: EphemeralRuntime;
const lines: string[] = [];

const app = {
  "nylorun-protocol": "4",
  "nylorun-tenant": TENANT,
  authorization: `Bearer ${APPLICATION_KEY}`,
};

/** A request with a Host header fetch would not send. */
function raw(url: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: { host } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "nylorun-request-log-"));
  rt = await startEphemeralRuntime({
    database: testPool(),
    hostRoot: root,
    tenantId: TENANT,
    applicationKey: APPLICATION_KEY,
    adminKey: ADMIN_KEY,
    operatorListener: true,
    model: { kind: "fixture" },
    logger: createHostLogger((line) => lines.push(line)),
  });
  const put = (path: string, body: unknown) =>
    fetch(`${rt.url}${path}`, {
      method: "PUT",
      headers: { ...app, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  expect(
    (
      await put("/v1/agents/bot", {
        requestId: "bot",
        manifest: Agent({ id: "bot", name: "Bot" }).build().manifest,
        implementationVersion: "dev",
      })
    ).status,
  ).toBe(200);
  expect(
    (await put("/v1/sessions/s1", { requestId: "s1", agentId: "bot", ownerUserId: "app:ann" }))
      .status,
  ).toBe(200);
});

afterAll(async () => {
  await rt?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

it("logs each request's outcome as recorded", async () => {
  lines.length = 0;
  const port = new URL(rt.url).port;
  await raw(`${rt.url}/v1/agents`, "evil.example.com");
  await raw(`${rt.url}/health`, "evil.example.com");
  await fetch(`${rt.url}/health`);
  await fetch(`${rt.url}/ready`);
  await fetch(`${rt.url}/v1/agents`, { headers: { ...app, origin: "https://x.example" } });
  await fetch(`${rt.url}/v1/agents`, {
    method: "POST",
    headers: { ...app, "content-type": "text/plain" },
    body: "x",
  });
  await fetch(`${rt.url}/v1/agents`, { headers: { ...app, "nylorun-protocol": "1" } });
  await fetch(`${rt.url}/v1/agents`, { headers: { "nylorun-protocol": "4" } });
  await fetch(`${rt.url}/v1/agents`, {
    headers: { ...app, "nylorun-tenant": `tn_${"0".repeat(22)}dead` },
  });
  await fetch(`${rt.url}/v1/agents`, { headers: app });
  await fetch(`${rt.url}/v1/sessions/s1?cursor=secret-query`, { headers: app });
  await fetch(`${rt.url}/v1/sessions/s1/items`, { headers: app });
  await fetch(`${rt.url}/v1/ag-ui/agents/bot/threads/t1/messages`, {
    headers: { ...app, "nylorun-subject": "app:ann", "nylorun-scopes": "sessions:own" },
  });
  await fetch(`${rt.url}/v1/admin/status`, {
    headers: { "nylorun-protocol": "4", authorization: `Bearer ${ADMIN_KEY}` },
  });
  await fetch(`${rt.adminUrl}/v1/admin/status`, {
    headers: { "nylorun-protocol": "4", authorization: `Bearer ${ADMIN_KEY}` },
  });
  const stream = new AbortController();
  const events = await fetch(`${rt.url}/v1/sessions/s1/events`, {
    headers: app,
    signal: stream.signal,
  });
  expect(events.headers.get("content-type")).toBe("text/event-stream");
  stream.abort();
  // The stream's line is written when it opens; let the abort settle before reading.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const logged = lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row.message === "request")
    .map(({ method, path, status, tenantId, durationMs }) => ({
      method,
      path,
      status,
      ...(tenantId === undefined ? {} : { tenantId: tenantId === TENANT ? "<tenant>" : tenantId }),
      durationMs: typeof durationMs,
    }));
  expect(lines.join("\n")).not.toContain(APPLICATION_KEY);
  expect(lines.join("\n")).not.toContain("secret-query");
  expect(port).not.toBe("");
  await expect(`${JSON.stringify(logged, null, 2)}\n`).toMatchFileSnapshot(
    "./__fixtures__/request-log.json",
  );
});
