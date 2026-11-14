/**
 * The engine's first join (`harness/pod.ts` firstJoin): on Agent Substrate a new actor can reach
 * the edge before its egress policy does, so the first join fails at the network. It is tried
 * again with backoff, a refusal is final at once, and it gives up at its budget.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { firstJoin, isRefused, podHost } from "../../src/harness/pod.js";

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

describe("firstJoin", () => {
  it("tries again while the edge can't be reached, then joins", async () => {
    const c = clock();
    const logged: unknown[] = [];
    let calls = 0;
    await firstJoin(
      {
        token: async () => {
          calls += 1;
          if (calls < 4) throw new TypeError("fetch failed");
          return "host-token";
        },
      },
      (_m, fields) => logged.push(fields),
      c,
    );
    expect(calls).toBe(4);
    expect(logged).toHaveLength(3);
    expect(logged[0]).toMatchObject({ attempt: 1, waitMs: 250, error: "fetch failed" });
    expect(c.now()).toBe(250 + 500 + 1000);
  });

  it("stops at once when the Runtime refuses the join", async () => {
    // A refusal is the pod's own Refused error, which the real join throws on 400 or 401.
    const dir = await mkdtemp(join(tmpdir(), "first-join-"));
    await writeFile(join(dir, "join"), "join-token");
    const host = podHost(
      { sandboxId: "a", podUid: "u", joinFile: join(dir, "join"), httpUrl: "http://edge", blocked: [] },
      { info() {}, warn() {} },
      {
        volumeFile: join(dir, "volume-id"),
        caBundleFile: join(dir, "ca.pem"),
        fetch: (async () => new Response("no", { status: 401 })) as typeof fetch,
      },
    );
    const c = clock();
    let tried = 0;
    await expect(
      firstJoin(
        {
          token: async () => {
            tried += 1;
            return host.token();
          },
        },
        () => undefined,
        c,
      ),
    ).rejects.toSatisfy(isRefused);
    expect(tried).toBe(1);
  });

  it("gives up at its budget", async () => {
    const c = clock();
    let calls = 0;
    await expect(
      firstJoin(
        {
          token: async () => {
            calls += 1;
            throw new TypeError("fetch failed");
          },
        },
        () => undefined,
        { ...c, budgetMs: 10_000 },
      ),
    ).rejects.toThrow("fetch failed");
    expect(calls).toBeGreaterThan(3);
    expect(c.now()).toBeLessThanOrEqual(10_000);
  });
});
