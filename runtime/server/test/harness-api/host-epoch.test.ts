/**
 * A pod Environment's hosts by epoch. A restore or a lost volume gives the pod a new volume and
 * moves its host epoch, but the old host's connection is closed only when `host.revoked` arrives,
 * after the commit. Until then a seed must not count the old host as the Environment's engine, nor
 * write the new volume's files through it.
 */
import { afterEach, expect, it } from "vitest";
import { HARNESS_API_VERSION, memoryChannels, type HarnessChannel } from "@nylorun/core/harness-api";
import { createHarnessApiServer } from "../../src/harness-api/server.js";
import type { TenantContext } from "../../src/tenant/context.js";

const ctx = {
  config: { tenantId: "t1", logger: { info: () => undefined, warn: () => undefined } },
  ownerLeaseMs: 30_000,
  store: { tx: async (work: (t: unknown) => unknown) => work({ environment: async () => ({ applied: {} }) }) },
} as unknown as TenantContext;

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

/** A pod engine of `pod-a` that joined at `epoch` and serves its workspace, answering `answer`. */
async function host(server: ReturnType<typeof createHarnessApiServer>, epoch: number, answer: string): Promise<HarnessChannel> {
  const channels = memoryChannels({ json: true });
  const detach = server.attach(channels.core, { name: "pod", host: { sandboxId: "pod-a", epoch } } as never);
  closers.push(() => {
    channels.harness.close("test over");
    detach();
  });
  channels.harness.handle(async () => ({ answer }));
  await channels.harness.request("hello", {
    api: HARNESS_API_VERSION,
    name: "nylorun",
    version: "0",
    features: { workspace: {} },
  });
  return channels.harness;
}

it("counts a host as the Environment's engine only at its epoch or later", async () => {
  const server = createHarnessApiServer(ctx);
  await host(server, 3, "old");
  expect(server.hosting("pod-a")).toBe(true);
  // The volume moved to epoch 4: the host of epoch 3 is still connected, but it is not the engine.
  expect(server.hosting("pod-a", 4)).toBe(false);
  await host(server, 5, "new");
  expect(server.hosting("pod-a", 4)).toBe(true);
});

it("sends a pod's workspace request with a minimum epoch to a host of that epoch or later", async () => {
  const server = createHarnessApiServer(ctx);
  await host(server, 3, "old");
  // The old host is not asked: no host of epoch 4 or later serves pod-a yet.
  await expect(server.workspace("workspace.report", {}, undefined, { pod: "pod-a", minEpoch: 4 })).rejects.toThrow();
  await host(server, 5, "new");
  await expect(server.workspace("workspace.report", {}, undefined, { pod: "pod-a", minEpoch: 4 })).resolves.toEqual({
    answer: "new",
  });
  // Without a minimum, any host of the pod still serves its other requests.
  await expect(server.workspace("workspace.report", {}, undefined, { pod: "pod-a" })).resolves.toBeDefined();
});
