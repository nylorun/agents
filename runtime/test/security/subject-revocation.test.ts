/**
 * Revocation across processes: two Tenant Runtimes on one store and one set of streams, as
 * two nodes would be. Revoking on one node ends the subject's stream on the other through the
 * `subject.revoked` signal; with no signal, the periodic feed check ends it from the epoch.
 */
import { rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import { MemoryStreams } from "../../src/streams/memory.js";
import { checkFeeds } from "../../src/tenant/live.js";
import { startTestTenant } from "../support/tenant.js";
import { contextOf } from "../tenant/streams.suite.js";

const APP = "revocation-app-token-aaaaaaaaaaaa";
const KEK = Buffer.alloc(32, 5).toString("base64");
const headers = (key: string) => ({
  authorization: `Bearer ${key}`,
  "content-type": "application/json",
});

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function twoNodes() {
  const streams = new MemoryStreams();
  cleanup.push(() => streams.close());
  const a = await startTestTenant({ applicationKey: APP, vaultKek: KEK, retainRoot: true, streams });
  cleanup.push(() => rm(a.root, { recursive: true, force: true }));
  cleanup.push(() => a.close());
  const b = await startTestTenant({
    applicationKey: APP,
    vaultKek: KEK,
    hostRoot: a.root,
    tenantId: a.tenantId,
    retainRoot: true,
    streams,
  });
  cleanup.push(() => b.close());
  const call = (url: string, method: string, path: string, body?: unknown, key = APP) =>
    fetch(`${url}${path}`, {
      method,
      headers: headers(key),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  await call(a.url, "PUT", "/v1/agents/bot", {
    requestId: "bot",
    manifest: Agent({ id: "bot", name: "Bot" }).build().manifest,
    implementationVersion: "dev",
  });
  await call(a.url, "PUT", "/v1/access/policy", {
    requestId: "p",
    policy: {
      version: 1,
      roles: { user: { scopes: ["sessions:own"], agents: "*" } },
      anon: { scopes: [], agents: [] },
      tokens: { maxTtlSeconds: 600 },
    },
  });
  const minted = await (
    await call(a.url, "POST", "/v1/tokens", { requestId: "m", subject: "app:zoe", role: "user" })
  ).json();
  const token = (minted as { token: string }).token;
  const put = await call(
    a.url,
    "PUT",
    "/v1/sessions/zoe-s",
    { requestId: "s", agentId: "bot", ownerUserId: "app:zoe" },
    token
  );
  expect(put.status).toBe(200);
  return { a, b, token, call };
}

it("ends the subject's stream on another node through the control signal", async () => {
  const { a, b, token, call } = await twoNodes();
  const stream = await fetch(`${b.url}/v1/sessions/zoe-s/events`, { headers: headers(token) });
  expect(stream.status).toBe(200);
  await call(a.url, "POST", "/v1/access/revocations", { requestId: "r", subject: "app:zoe" });
  const text = await stream.text();
  expect(text).toContain('"reason":"revoked"');
});

it("ends it from the epoch when the signal is lost", async () => {
  const { b, token } = await twoNodes();
  const stream = await fetch(`${b.url}/v1/sessions/zoe-s/events`, { headers: headers(token) });
  expect(stream.status).toBe(200);
  // Revoke through the store only: no signal reaches node B.
  const ctx = contextOf(b.handle);
  await ctx.store.tx((t) => t.bumpSubjectEpoch("app:zoe", new Date().toISOString()));
  await checkFeeds(ctx);
  const text = await stream.text();
  expect(text).toContain('"reason":"revoked"');
});
