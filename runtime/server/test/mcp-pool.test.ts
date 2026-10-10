/**
 * The MCP pool's connection lifetime: idle connections are closed by the sweep and opened
 * again on the next call, and concurrent calls for a missing connection share one.
 */
import { describe, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import type { LiveConnection, McpClient } from "../src/mcp/connect.js";
import { McpPool } from "../src/mcp/pool.js";

const agent = Agent({ id: "bot", name: "Bot" })
  .mcp({ local: { type: "streamable-http", url: "https://mcp.example.invalid/mcp" } })
  .build();

function harness() {
  let now = 0;
  const opened: { closed: boolean }[] = [];
  let release: (() => void) | undefined;
  let finish: (() => void) | undefined;
  const gate = { hold: false, holdCalls: false };
  const pool = new McpPool({
    authorize: async () => ({ status: "none" }) as never,
    idleMs: 1_000,
    now: () => now,
    open: async () => {
      const state = { closed: false };
      opened.push(state);
      if (gate.hold) await new Promise<void>((resolve) => (release = resolve));
      const client = {
        listTools: async () => ({ tools: [{ name: "echo", inputSchema: { type: "object" } }] }),
        callTool: async () => {
          if (gate.holdCalls) await new Promise<void>((resolve) => (finish = resolve));
          return { result: { content: [{ type: "text", text: "ok" }] } };
        },
      } as unknown as McpClient;
      const connection: LiveConnection = {
        client,
        close: async () => {
          state.closed = true;
        },
      };
      return connection;
    },
  });
  const call = () =>
    pool.call({
      sessionId: "s1",
      capabilityId: "mcp",
      serverName: "local",
      serverToolName: "echo",
      args: {},
      manifest: agent.manifest,
    });
  return {
    pool,
    opened,
    call,
    gate,
    release: () => release?.(),
    finish: () => finish?.(),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("McpPool", () => {
  it("closes a connection idle past the timeout and reopens it on the next call", async () => {
    const h = harness();
    expect(await h.call()).toEqual({ kind: "completed", output: "ok" });
    expect(h.opened).toHaveLength(1);

    h.advance(999);
    await h.pool.sweep();
    expect(h.opened[0]!.closed).toBe(false);

    h.advance(1);
    await h.pool.sweep();
    expect(h.opened[0]!.closed).toBe(true);

    expect(await h.call()).toEqual({ kind: "completed", output: "ok" });
    expect(h.opened).toHaveLength(2);
    expect(h.opened[1]!.closed).toBe(false);
  });

  it("keeps a connection with a call in progress", async () => {
    const h = harness();
    await h.call();
    h.gate.holdCalls = true;
    const pending = h.call();
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.advance(5_000);
    await h.pool.sweep();
    expect(h.opened[0]!.closed).toBe(false);

    h.finish();
    await pending;
    // The call just used it.
    await h.pool.sweep();
    expect(h.opened[0]!.closed).toBe(false);
    h.advance(1_000);
    await h.pool.sweep();
    expect(h.opened[0]!.closed).toBe(true);
  });

  it("opens one connection for concurrent calls on a missing server", async () => {
    const h = harness();
    h.gate.hold = true;
    const calls = [h.call(), h.call(), h.call()];
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.release();
    expect(await Promise.all(calls)).toEqual([
      { kind: "completed", output: "ok" },
      { kind: "completed", output: "ok" },
      { kind: "completed", output: "ok" },
    ]);
    expect(h.opened).toHaveLength(1);
    expect(h.opened[0]!.closed).toBe(false);
    await h.pool.close();
    expect(h.opened[0]!.closed).toBe(true);
  });
});
