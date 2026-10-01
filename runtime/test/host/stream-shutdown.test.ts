/**
 * The Host ends what it cannot wait for: open event streams at shutdown, and a response a
 * Tenant started and then failed.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import { startEphemeralRuntime } from "../../src/tenant/ephemeral.js";
import type { NodeBindings } from "../../src/tenant/types.js";
import {
  createFakeModule,
  getJson,
  newTenantId,
  startTestHost,
  tenantHeaders,
} from "./support.js";

it("close() ends open event streams instead of waiting for their clients", async () => {
  const root = await mkdtemp(join(tmpdir(), "nylorun-stream-shutdown-"));
  const rt = await startEphemeralRuntime({ hostRoot: root, model: { kind: "fixture" } });
  try {
    const headers = {
      "nylorun-protocol": "4",
      "nylorun-tenant": rt.tenantId,
      authorization: `Bearer ${rt.applicationKey}`,
      "content-type": "application/json",
    };
    const put = async (path: string, body: unknown) =>
      expect(
        (await fetch(`${rt.url}${path}`, { method: "PUT", headers, body: JSON.stringify(body) }))
          .status,
      ).toBe(200);
    await put("/v1/agents/bot", {
      requestId: "bot",
      manifest: Agent({ id: "bot", name: "Bot" }).build().manifest,
      implementationVersion: "dev",
    });
    await put("/v1/sessions/s1", { requestId: "s1", agentId: "bot", ownerUserId: "app:ann" });
    const stream = await fetch(`${rt.url}/v1/sessions/s1/events`, { headers });
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    const reader = stream.body!.getReader();

    const started = Date.now();
    await rt.close();
    expect(Date.now() - started).toBeLessThan(5_000);
    // The client sees its stream end, and reconnects elsewhere.
    for (;;) if ((await reader.read()).done) break;
  } finally {
    await rt.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("a Tenant that fails after starting its response gets that response ended, not a second one", async () => {
  const tenantId = newTenantId();
  const module = createFakeModule({
    tenants: [
      {
        id: tenantId,
        name: "a",
        state: "open",
        handle: {
          envelope: {
            id: tenantId,
            name: "a",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            schemaVersion: 1,
          },
          async fetch(_request: Request, { outgoing }: NodeBindings) {
            outgoing.writeHead(200, { "content-type": "application/json" });
            outgoing.write('{"partial":');
            throw Object.assign(new Error("store went away"), { status: 503 });
          },
          async summary() {
            return {
              ready: true,
              runningSessions: 0,
              inFlightDeliveries: 0,
              pendingActions: 0,
              uncertainEffects: 0,
            };
          },
          async drain() {},
          async close() {},
        },
      },
    ],
  });
  const logLines: string[] = [];
  const { url } = await startTestHost({ module, logLines });

  const failed = await fetch(`${url}/v1/agents`, { headers: tenantHeaders(tenantId, "k") });
  expect(failed.status).toBe(200);
  expect(await failed.text()).toBe('{"partial":');
  // The Host is still serving.
  expect((await getJson(`${url}/health`)).status).toBe(200);
  const requests = logLines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row.message === "request");
  expect(requests.at(-1)?.status).toBe(503);
});
