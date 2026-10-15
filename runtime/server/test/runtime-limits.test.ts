/**
 * The Tenant's Runtime limits (harness boundary S0): `GET`/`PUT /v1/tenant/limits` on the
 * Management API, their defaults and ceilings, and the record entry limit holding every write
 * into the record, core's own included.
 */
import { afterEach, expect, it } from "vitest";
import { RUNTIME_LIMIT_CEILINGS, RUNTIME_LIMIT_DEFAULTS, S2_RECORD_MAX_BYTES } from "@nylorun/core/contracts";
import { boot, openSession, server, type Started } from "./host/execution-support.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function start(): Promise<Started> {
  const runtime = await boot({});
  cleanups.push(() => runtime.close());
  return runtime;
}

async function limits(runtime: Started, method: "GET" | "PUT", body?: unknown, headers = runtime.managementHeaders()) {
  const response = await fetch(`${runtime.url}/v1/tenant/limits`, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json().catch(() => undefined)) as any };
}

it("answers the defaults until the Tenant sets a limit, and only to a management key", async () => {
  const runtime = await start();
  expect(await limits(runtime, "GET")).toEqual({ status: 200, body: { limits: RUNTIME_LIMIT_DEFAULTS } });
  // An application key is not the operator's.
  expect((await limits(runtime, "GET", undefined, server)).status).toBe(403);
  expect((await limits(runtime, "PUT", { limits: { chunkBytes: 1024 } }, server)).status).toBe(403);

  const set = await limits(runtime, "PUT", { limits: { modelCallBytes: 4096, chunkBytes: 1024 } });
  expect(set).toEqual({
    status: 200,
    body: { limits: { ...RUNTIME_LIMIT_DEFAULTS, modelCallBytes: 4096, chunkBytes: 1024 } },
  });
  expect((await limits(runtime, "GET")).body).toEqual(set.body);
  // A put replaces the whole document: what it leaves out goes back to its default.
  expect((await limits(runtime, "PUT", { limits: { chunkBytes: 2048 } })).body).toEqual({
    limits: { ...RUNTIME_LIMIT_DEFAULTS, chunkBytes: 2048 },
  });
  expect((await limits(runtime, "PUT", {})).body).toEqual({ limits: RUNTIME_LIMIT_DEFAULTS });
});

it("refuses a limit above its ceiling, naming the ceiling, and keeps what was set", async () => {
  const runtime = await start();
  expect((await limits(runtime, "PUT", { limits: { harnessStateBytes: 1024 } })).status).toBe(200);
  const refused = await limits(runtime, "PUT", {
    limits: { recordEntryBytes: S2_RECORD_MAX_BYTES, harnessStateBytes: 2048 },
  });
  expect(refused.status).toBe(400);
  expect(refused.body.message).toContain(
    `limits.recordEntryBytes asks for ${S2_RECORD_MAX_BYTES} bytes; its ceiling is ${RUNTIME_LIMIT_CEILINGS.recordEntryBytes.bytes}`,
  );
  expect(refused.body.message).toContain("S2");
  expect((await limits(runtime, "GET")).body.limits.harnessStateBytes).toBe(1024);
  // Unknown and non-positive limits are malformed.
  expect((await limits(runtime, "PUT", { limits: { frameBytes: 1 } })).status).toBe(400);
  expect((await limits(runtime, "PUT", { limits: { chunkBytes: 0 } })).status).toBe(400);
});

it("refuses an event past the record entry limit, core's own write included", async () => {
  const runtime = await start();
  await openSession(runtime, "s1");
  expect((await limits(runtime, "PUT", { limits: { recordEntryBytes: 2048 } })).status).toBe(200);
  const message = (n: number, content: string) =>
    fetch(`${runtime.url}/v1/sessions/s1/commands`, {
      method: "POST",
      headers: server,
      body: JSON.stringify({ type: "message", requestId: `m${n}`, idempotencyKey: `m${n}`, content }),
    });
  const refused = await message(1, "x".repeat(4096));
  expect(refused.status).toBe(413);
  expect(await refused.json()).toMatchObject({
    code: "limit_exceeded",
    message: expect.stringContaining("recordEntryBytes (2048 bytes"),
    details: { limit: "recordEntryBytes", maxBytes: 2048 },
  });
  // Nothing of it was recorded; a message that fits is.
  const items = async () =>
    ((await (await fetch(`${runtime.url}/v1/sessions/s1/items`, { headers: server })).json()) as {
      items: { type: string }[];
    }).items.filter((item) => item.type === "command.message");
  expect(await items()).toEqual([]);
  expect((await message(2, "hello")).status).toBeLessThan(300);
  expect(await items()).toHaveLength(1);
});
