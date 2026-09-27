/**
 * Sandbox lifecycle driven by the Tenant sweep: idle stop, stale record reset and the
 * once-per-process reconcile (architecture §12.3, "Timers").
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  Agent,
  SANDBOX_INSTRUCTIONS,
  createSandboxTools,
} from "@nylorun/core/define";
import { virtualBackend } from "../../src/adapters/sandbox/virtual.js";
import { SandboxManager, sandboxCapabilityOf } from "../../src/sandbox/manager.js";
import { MemorySessionStore } from "../../src/store/memory.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const manifest = Agent({ id: "bot", name: "Bot" })
  .use({
    id: "sandbox",
    instructions: [SANDBOX_INSTRUCTIONS],
    tools: createSandboxTools(),
    sandbox: { idle: "1m" },
  })
  .build().manifest;

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "nylorun-sandbox-sweep-"));
  roots.push(root);
  const store = new MemorySessionStore({ tenantId: "tn_sandbox" });
  const events: { sessionId: string; type: string; state?: string }[] = [];
  const manager = new SandboxManager({
    scope: "tn_sandbox",
    store,
    backends: [virtualBackend({ root })],
    preference: "virtual",
    ephemeral: false,
    emit: (sessionId, _turnId, type, payload) => {
      events.push({ sessionId, type, state: (payload as { state?: string }).state });
    },
  });
  const capability = sandboxCapabilityOf(manifest, "sandbox", "write")!;
  const run = (sessionId: string, path: string) =>
    manager.run(
      { id: sessionId, activeTurnId: "t1", manifest },
      capability,
      "write",
      { path, content: "x" },
      new AbortController().signal
    );
  return { root, store, events, manager, run };
}

it("stops a sandbox once it has been idle for its timeout, and reattaches on the next call", async () => {
  const { store, events, manager, run } = await setup();
  const sessionExists = () => true;
  expect((await run("s1", "a.txt")).kind).toBe("completed");
  const key = manager.keyOf("s1");
  await manager.sweep({ now: Date.now() + 30_000, sessionExists });
  expect(await store.tx((t) => t.get("sandboxes", key))).toMatchObject({ state: "running" });

  await manager.sweep({ now: Date.now() + 61_000, sessionExists });
  expect(await store.tx((t) => t.get("sandboxes", key))).toMatchObject({ state: "stopped" });
  expect(events.at(-1)).toMatchObject({ sessionId: "s1", type: "sandbox.state", state: "stopped" });

  // The next call reattaches; the files are still there.
  expect((await run("s1", "b.txt")).kind).toBe("completed");
  expect(await store.tx((t) => t.get("sandboxes", key))).toMatchObject({ state: "running" });
  expect(events.filter((e) => e.state === "creating")).toHaveLength(2);
  await manager.close();
});

it("marks records of compute it does not hold as stopped and removes sandboxes of deleted sessions", async () => {
  const { root, store, manager, run } = await setup();
  expect((await run("gone", "a.txt")).kind).toBe("completed");
  const goneKey = manager.keyOf("gone");
  // A later process: same store and backend, no live compute.
  await manager.close();
  const restarted = new SandboxManager({
    scope: "tn_sandbox",
    store,
    backends: [virtualBackend({ root })],
    preference: "virtual",
    ephemeral: false,
    emit: () => undefined,
  });
  await store.tx((t) =>
    t.put("sandboxes", "nylorun-tn_sandbox-stale", {
      key: "nylorun-tn_sandbox-stale",
      sessionId: "kept",
      backend: "virtual",
      image: "",
      state: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  );
  await restarted.sweep({ sessionExists: (id) => id === "kept" });
  expect(await store.tx((t) => t.get("sandboxes", "nylorun-tn_sandbox-stale"))).toMatchObject({
    state: "stopped",
  });
  // The session behind `gone` no longer exists: its sandbox and record are removed.
  expect(await store.tx((t) => t.get("sandboxes", goneKey))).toBeUndefined();
  expect(await readdir(root)).not.toContain(goneKey);
  await restarted.close();
});
