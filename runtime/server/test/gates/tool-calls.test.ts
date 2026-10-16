/**
 * F4.1 G3, R5.3: keyed tool calls (MCP and HTTP tools) in the gates service. A re-send joins a
 * running call or gets its answer; after a gateway restart the answer comes from
 * `tool_crossings`, and a call that was lost with the old gateway runs again under the same key
 * (at least once). A cancelled call never runs again under its key.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { InflightConflict } from "../../src/gates/inflight.js";
import type { McpHandler } from "../../src/gates/mcp-handler.js";
import { createToolCalls } from "../../src/gates/tool-calls.js";
import { hostTuning } from "../../src/tuning.js";
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

/** A held MCP handler's call of the tool `name`. */
const request = (held: { mcp: McpHandler }, name = "echo") => (signal: AbortSignal) =>
  held.mcp.call(
    undefined,
    { server: { sessionId: "s1", serverName: "remote" }, effectId: "e", name, arguments: {} },
    signal,
  );

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

describe("keyed tool calls at the gate", () => {
  it("joins a running call: two sends, one call to the server", async () => {
    const held = heldMcp();
    const calls = createToolCalls({ vaults, logger: quiet });
    const k = key();
    const first = calls.run(undefined, k, "h", request(held));
    const second = calls.run(undefined, k, "h", request(held));
    held.release();
    expect(await first).toEqual(await second);
    expect(held.calls()).toBe(1);
  });

  it("answers from tool_crossings after a gateway restart", async () => {
    const held = heldMcp();
    const k = key();
    const before = createToolCalls({ vaults, logger: quiet });
    held.release();
    const answer = await before.run(undefined, k, "h", request(held));
    const after = createToolCalls({ vaults, logger: quiet });
    expect(await after.run(undefined, k, "h", request(held))).toEqual(answer);
    expect(held.calls()).toBe(1);
  });

  it("runs a call lost with the old gateway again, under the same key (R5.3)", async () => {
    const held = heldMcp();
    const k = key();
    const before = createToolCalls({ vaults, logger: quiet });
    const running = before.run(undefined, k, "h", request(held));
    await expect.poll(() => held.calls()).toBe(1);
    before.close(); // the gateway stops mid-call
    await expect(running).rejects.toThrow();
    const after = createToolCalls({ vaults, logger: quiet });
    held.release();
    expect(await after.run(undefined, k, "h", request(held))).toMatchObject({ ok: true });
    expect(held.calls()).toBe(2);
    // Settled now: a third send collects the answer.
    expect(await createToolCalls({ vaults, logger: quiet }).run(undefined, k, "h", request(held))).toMatchObject({
      ok: true,
    });
    expect(held.calls()).toBe(2);
  });

  it("refuses a different request under the same key, running or settled", async () => {
    const held = heldMcp();
    const k = key();
    const calls = createToolCalls({ vaults, logger: quiet });
    const running = calls.run(undefined, k, "h", request(held));
    await expect.poll(() => held.calls()).toBe(1);
    await expect(calls.run(undefined, k, "other", request(held, "other"))).rejects.toBeInstanceOf(
      InflightConflict,
    );
    held.release();
    await running;
    const after = createToolCalls({ vaults, logger: quiet });
    await expect(after.run(undefined, k, "other", request(held, "other"))).rejects.toBeInstanceOf(
      InflightConflict,
    );
  });

  it("cancels a call: it is never run again under its key", async () => {
    const held = heldMcp();
    const k = key();
    const calls = createToolCalls({ vaults, logger: quiet });
    const running = calls.run(undefined, k, "h", request(held));
    await expect.poll(() => held.calls()).toBe(1);
    calls.cancel(k);
    await expect(running).rejects.toThrow();
    const cancelled = { ok: false, error: { message: expect.stringContaining("cancelled") } };
    await expect.poll(() => store.tx((t) => t.toolCrossing(k)).then((row) => row?.answer)).toMatchObject(cancelled);
    expect(await calls.run(undefined, k, "h", request(held))).toMatchObject(cancelled);
    expect(await createToolCalls({ vaults, logger: quiet }).run(undefined, k, "h", request(held))).toMatchObject(
      cancelled,
    );
    expect(held.calls()).toBe(1);
  });

  it("prunes crossings a day after they settle", async () => {
    const held = heldMcp();
    held.release();
    let clock = Date.now();
    const k = key();
    const calls = createToolCalls({ vaults, logger: quiet, now: () => clock });
    await calls.run(undefined, k, "h", request(held));
    await calls.prune();
    expect(await store.tx((t) => t.toolCrossing(k))).toBeDefined();
    clock += hostTuning().gates.toolCrossingTtlMs + 1_000;
    await calls.prune();
    expect(await store.tx((t) => t.toolCrossing(k))).toBeUndefined();
  });
});
