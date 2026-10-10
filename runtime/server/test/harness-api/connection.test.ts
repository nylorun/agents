/**
 * Harness connections (F6.1): a run is bound to the connection that leased it. Another
 * connection gets `run_not_held` for it. When the holder's connection is lost the advance
 * keeps the lease, as a Worker that died would: it lapses, the next advance takes the session
 * over (an effect the lost harness was running becomes `uncertain`), and the segment is offered
 * again, here to a second harness, which finishes it.
 */
import { afterEach, expect, it } from "vitest";
import { memoryChannels, type HarnessChannel } from "@nylorun/core/harness-api";
import { createHarness, type HarnessExecutors } from "@nylorun/harness/api";
import {
  boot,
  openSession,
  sendMessage,
  stored,
  types,
  until,
  view,
  type Started,
} from "../host/execution-support.js";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function attach(runtime: Started): HarnessChannel {
  const channels = memoryChannels({ json: true });
  const detach = runtime.handle.attachHarness!(channels.core, { name: "test" });
  cleanups.push(() => {
    channels.harness.close("test over");
    detach();
  });
  return channels.harness;
}

const hello = { api: 1, name: "test", version: "0", capabilities: {} };

it("binds a run to its connection, and offers it again when that connection is lost", async () => {
  const runtime = await boot({ harness: "remote", ownerLeaseMs: 300 });
  cleanups.push(() => runtime.close());
  const holder = attach(runtime);
  const other = attach(runtime);
  await holder.request("hello", hello);
  await other.request("hello", hello);
  const leased = holder.request("lease", {});
  await openSession(runtime);
  await sendMessage(runtime);
  const { run, input } = await leased;
  expect(run).toMatchObject({ sessionId: "s1", turnId: (input.checkpoint as { turnId: string }).turnId });
  expect(input).toMatchObject({ type: "turn.start", engine: "agent" });

  // Only the holder reaches its run.
  await expect(holder.request("transcript.read", { runId: run.runId })).resolves.toMatchObject({
    entries: expect.any(Array),
  });
  for (const ask of [
    () => other.request("lease.renew", { runId: run.runId }),
    () => other.request("transcript.read", { runId: run.runId }),
    () => other.request("turn.failed", { runId: run.runId, thrown: { message: "not mine" } }),
  ])
    await expect(ask()).rejects.toMatchObject({ code: "run_not_held" });

  // The holder goes away; a second harness gets the segment and finishes the turn.
  const executors: HarnessExecutors = {
    model: async () => ({ output: [{ type: "text", text: "done" }] }),
    tool: async () => {
      throw new Error("no tools here");
    },
    recovers: { model: false, tool: () => false },
  };
  const harness = createHarness({ channel: attach(runtime), executors });
  cleanups.push(() => harness.stop());
  await harness.start();
  holder.close("gone");
  await until(() => view(runtime), (v) => v.status === "completed", "completed");
  await expect(holder.request("lease.renew", { runId: run.runId })).rejects.toMatchObject({
    code: "unavailable",
  });
  await expect(other.request("lease.renew", { runId: run.runId })).rejects.toMatchObject({
    code: "run_not_held",
  });
});

it("takes over from a lost harness: the call it was running is uncertain, never re-sent", async () => {
  const runtime = await boot({ harness: "remote", ownerLeaseMs: 300 });
  cleanups.push(() => runtime.close());
  const holder = attach(runtime);
  await holder.request("hello", hello);
  const leased = holder.request("lease", {});
  await openSession(runtime);
  await sendMessage(runtime);
  const { run, input } = await leased;
  const checkpoint = input.checkpoint as { turnId: string; segment: number; manifestHash: string };
  // The harness starts a model call, then goes away before its outcome.
  await expect(
    holder.request("effect.intent", {
      runId: run.runId,
      requestHash: "0".repeat(64),
      effect: {
        effectId: `${checkpoint.turnId}:${checkpoint.segment}:model:lost`,
        sessionId: run.sessionId,
        turnId: run.turnId,
        agentId: "bot",
        manifestHash: checkpoint.manifestHash,
        kind: "model",
        context: { invocationId: "lost" },
      },
    })
  ).resolves.toEqual({ status: "execute" });
  holder.close("gone");

  await until(() => view(runtime), (v) => v.status === "uncertain", "uncertain");
  const { session, effects } = await stored(runtime);
  expect(effects.map((effect) => effect.status)).toEqual(["uncertain"]);
  expect(session.owner).toBeNull();
  expect((await types(runtime)).filter((type) => type === "effect.uncertain")).toHaveLength(1);
});
