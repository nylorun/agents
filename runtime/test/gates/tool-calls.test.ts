/**
 * F4.1 G3: keyed MCP calls in the gates service run once. A re-send joins a running call or gets
 * its answer; after a gateway restart the answer comes from `tool_crossings`, and a call that
 * was lost with the old gateway answers `uncertain` instead of running again.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { InflightConflict } from "../../src/gates/inflight.js";
import type { McpHandler } from "../../src/gates/mcp-handler.js";
import { createToolCalls, TOOL_CROSSING_TTL_MS } from "../../src/gates/tool-calls.js";
import type { TenantVaults } from "../../src/gates/tenant-vaults.js";
import type { SessionStore } from "../../src/store/types.js";
import { createTestSessionStore } from "../support/store.js";

const tenantId = newTenantId();
const quiet = { info() {}, warn() {}, error() {} } as never;
let store: SessionStore;
beforeAll(async () => {
  store = await createTestSessionStore(tenantId);
});
const vaults: TenantVaults = { open: async () => ({ tenantId, store }) as never };

const request = (name = "echo") => ({
  server: { sessionId: "s1", capabilityId: "mcp", serverName: "remote" },
  effectId: "e",
  name,
  arguments: {},
});

/** An MCP handler whose calls wait for `release()`, counting them. */
function heldMcp() {
  let calls = 0;
  let release!: () => void;
  let released = new Promise<void>((resolve) => (release = resolve));
  const mcp = {
    async call(_tenant: unknown, _request: unknown, signal: AbortSignal) {
      calls += 1;
      await Promise.race([
        released,
        new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })),
      ]);
      return { ok: true as const, result: { content: [{ type: "text", text: `call ${calls}` }] } };
    },
  } as unknown as McpHandler;
  return {
    mcp,
    calls: () => calls,
    release: () => release(),
    rearm: () => {
      released = new Promise<void>((resolve) => (release = resolve));
    },
  };
}

let next = 0;
const key = () => `turn-${++next}:0:tool:1`;

describe("keyed MCP calls at the gate", () => {
  it("joins a running call: two sends, one call to the server", async () => {
    const held = heldMcp();
    const calls = createToolCalls({ vaults, mcp: held.mcp, logger: quiet });
    const k = key();
    const first = calls.run(undefined, k, "h", request());
    const second = calls.run(undefined, k, "h", request());
    held.release();
    expect(await first).toEqual(await second);
    expect(held.calls()).toBe(1);
  });

  it("answers from tool_crossings after a gateway restart", async () => {
    const held = heldMcp();
    const k = key();
    const before = createToolCalls({ vaults, mcp: held.mcp, logger: quiet });
    held.release();
    const answer = await before.run(undefined, k, "h", request());
    const after = createToolCalls({ vaults, mcp: held.mcp, logger: quiet });
    expect(await after.run(undefined, k, "h", request())).toEqual(answer);
    expect(held.calls()).toBe(1);
  });

  it("answers uncertain for a call lost with the old gateway, and never runs it again", async () => {
    const held = heldMcp();
    const k = key();
    const before = createToolCalls({ vaults, mcp: held.mcp, logger: quiet });
    const running = before.run(undefined, k, "h", request());
    await expect.poll(() => held.calls()).toBe(1);
    before.close(); // the gateway stops mid-call
    await expect(running).rejects.toThrow();
    const after = createToolCalls({ vaults, mcp: held.mcp, logger: quiet });
    expect(await after.run(undefined, k, "h", request())).toMatchObject({
      ok: false,
      error: { uncertain: true },
    });
    expect(held.calls()).toBe(1);
  });

  it("refuses a different request under the same key, running or settled", async () => {
    const held = heldMcp();
    const k = key();
    const calls = createToolCalls({ vaults, mcp: held.mcp, logger: quiet });
    const running = calls.run(undefined, k, "h", request());
    await expect.poll(() => held.calls()).toBe(1);
    await expect(calls.run(undefined, k, "other", request("other"))).rejects.toBeInstanceOf(
      InflightConflict,
    );
    held.release();
    await running;
    const after = createToolCalls({ vaults, mcp: held.mcp, logger: quiet });
    await expect(after.run(undefined, k, "other", request("other"))).rejects.toBeInstanceOf(
      InflightConflict,
    );
  });

  it("cancels a call: it is never run again under its key", async () => {
    const held = heldMcp();
    const k = key();
    const calls = createToolCalls({ vaults, mcp: held.mcp, logger: quiet });
    const running = calls.run(undefined, k, "h", request());
    await expect.poll(() => held.calls()).toBe(1);
    calls.cancel(k);
    await expect(running).rejects.toThrow();
    expect(await calls.run(undefined, k, "h", request())).toMatchObject({
      ok: false,
      error: { uncertain: true },
    });
    expect(held.calls()).toBe(1);
  });

  it("prunes crossings a day after they settle", async () => {
    const held = heldMcp();
    held.release();
    let clock = Date.now();
    const k = key();
    const calls = createToolCalls({ vaults, mcp: held.mcp, logger: quiet, now: () => clock });
    await calls.run(undefined, k, "h", request());
    await calls.prune();
    expect(await store.tx((t) => t.toolCrossing(k))).toBeDefined();
    clock += TOOL_CROSSING_TTL_MS + 1_000;
    await calls.prune();
    expect(await store.tx((t) => t.toolCrossing(k))).toBeUndefined();
  });
});
