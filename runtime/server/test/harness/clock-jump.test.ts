import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { watchClockJumps } from "../../src/harness/clock-jump.js";
import { connectHarness, type HarnessClient } from "../../src/harness/ws-client.js";

const quiet = { info: () => undefined, warn: () => undefined };

describe("watchClockJumps", () => {
  afterEach(() => vi.useRealTimers());

  it("reports a freeze longer than jumpMs, and not a timer that is merely late", () => {
    vi.useFakeTimers();
    let now = 0;
    const jumps: number[] = [];
    const watch = watchClockJumps((ms) => jumps.push(ms), { intervalMs: 100, jumpMs: 1_500, now: () => now });
    now += 100;
    vi.advanceTimersByTime(100);
    now += 600; // late by 500 ms: a busy loop, not a freeze
    vi.advanceTimersByTime(100);
    expect(jumps).toEqual([]);
    now += 60_100; // frozen for a minute (a suspend), then the timer fires
    vi.advanceTimersByTime(100);
    expect(jumps).toEqual([60_000]);
    watch.stop();
  });
});

describe("connectHarness after a freeze", () => {
  let client: HarnessClient | undefined;
  let server: WebSocketServer | undefined;
  afterEach(async () => {
    await client?.stop(0);
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    client = server = undefined;
  });

  /** A Harness API that accepts connections; the first token request hangs, as one frozen mid-flight. */
  async function setup(redialOnClockJump: boolean) {
    server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    const connected = new Promise<void>((resolve) => server!.once("connection", () => resolve()));
    let calls = 0;
    let firstAborted = false;
    let now = Date.now();
    const token = (signal?: AbortSignal) => {
      calls += 1;
      if (calls > 1) return Promise.resolve("token");
      return new Promise<string>((_resolve, reject) =>
        signal?.addEventListener("abort", () => {
          firstAborted = true;
          reject(new Error("aborted"));
        }),
      );
    };
    client = connectHarness({
      url: `ws://127.0.0.1:${port}/nylorun/harness/v1`,
      token,
      logger: quiet,
      executors: [],
      name: "test",
      backoff: { minMs: 1, maxMs: 5 },
      redialOnClockJump,
      clockJumps: { intervalMs: 10, jumpMs: 1_500, now: () => now },
    } as never);
    return {
      connected,
      freeze: () => (now += 60_000),
      firstAborted: () => firstAborted,
    };
  }

  it("drops the attempt the freeze caught and dials again at once", async () => {
    const run = await setup(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    run.freeze();
    await expect(Promise.race([run.connected.then(() => "connected"), new Promise((r) => setTimeout(() => r("timeout"), 2_000))])).resolves.toBe("connected");
    expect(run.firstAborted()).toBe(true);
  });

  it("leaves the attempt alone without redialOnClockJump", async () => {
    const run = await setup(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    run.freeze();
    await expect(Promise.race([run.connected.then(() => "connected"), new Promise((r) => setTimeout(() => r("waiting"), 300))])).resolves.toBe("waiting");
    expect(run.firstAborted()).toBe(false);
  });
});
