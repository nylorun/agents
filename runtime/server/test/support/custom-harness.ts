/**
 * A custom harness in a test (protocol 16): a custom harness runs from its pod's image, so its
 * Agent is a pod Agent whose manifest's harness section names it (`harness.id`), and it takes the
 * runs of that Agent's sessions as the pod's host. `pods()` gives a Tenant the in-memory
 * sandboxes service such an Agent needs; `attachHost` connects a memory channel as the pod's
 * engine would, after its join.
 */
import { memoryChannels, type HarnessChannel } from "@nylorun/core/harness-api";
import type { AgentView, RuntimeSection } from "@nylorun/core/contracts";
import type { HarnessPeer } from "../../src/harness-api/server.js";
import { deploy, type AgentSource } from "./agents.js";
import { fakeSandboxes, type FakeSandboxes } from "./fake-sandboxes.js";

/** The image a custom harness runs from. */
export const HARNESS_IMAGE = "ghcr.io/acme/mini:1";

/** `startTestTenant`'s `pods`: sandbox pods on an in-memory sandboxes service. */
export function pods(client: FakeSandboxes = fakeSandboxes()) {
  return { client, harnessImage: "nylorun-runtime:test" };
}

/** Saves `agent` for harness `harness` on a pod with its image, and makes Agent `id` from it. */
export function deployCustom(
  url: string,
  headers: Record<string, string>,
  agent: AgentSource,
  options: { id: string; harness: string; name?: string; runtime?: Partial<RuntimeSection> },
): Promise<AgentView> {
  return deploy(url, headers, agent, {
    id: options.id,
    ...(options.name === undefined ? {} : { name: options.name }),
    harness: options.harness,
    runtime: { kind: "pod", image: HARNESS_IMAGE, ...options.runtime } as RuntimeSection,
  });
}

/**
 * Connects a channel to the Runtime as the host of pod Agent `sandboxId` (what a pod's join
 * makes it), at an epoch no revocation reaches. `cleanups` gets its close.
 */
export function attachHost(
  runtime: { handle: { attachHarness?(channel: never, peer: HarnessPeer): () => void } },
  sandboxId: string,
  cleanups: (() => unknown)[],
): HarnessChannel {
  const channels = memoryChannels({ json: true });
  const detach = runtime.handle.attachHarness!(channels.core as never, {
    name: `pod ${sandboxId}`,
    host: { sandboxId, epoch: Number.MAX_SAFE_INTEGER },
  });
  cleanups.push(() => {
    channels.harness.close("test over");
    detach();
  });
  return channels.harness;
}
