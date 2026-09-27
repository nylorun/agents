/**
 * Builds the Host's Durable Streams from the stack configuration
 * (architecture §12.4, §14.5). Only endpoints are configurable, never the kind:
 * with `NYLORUN_S2_ENDPOINT` the Host uses S2 (s2-lite on a developer machine,
 * or the S2 service); without it, the in-memory implementation, which only
 * unit tests and the pre-stack launcher use.
 */
import { createS2Streams } from "../adapters/streams/s2.js";
import type { StackConfig } from "../host/stack-config.js";
import { MemoryStreams } from "../streams/memory.js";
import type { DurableStreams } from "../streams/types.js";

export interface CreateStreamsOptions {
  /**
   * Prepended to every basin name, so several Hosts or test runs can share one
   * S2 account. See `streams/basin.ts`. Default "".
   */
  basinPrefix?: string;
}

/** Which implementation `createStreams` chooses for a configuration. */
export function streamsKind(config: Pick<StackConfig, "endpoints">): "s2" | "memory" {
  return config.endpoints.s2Endpoint ? "s2" : "memory";
}

export function createStreams(
  config: Pick<StackConfig, "endpoints">,
  options: CreateStreamsOptions = {},
): DurableStreams {
  const { s2Endpoint, s2Token } = config.endpoints;
  if (!s2Endpoint) {
    if (s2Token)
      throw new Error(
        "NYLORUN_S2_TOKEN is set without NYLORUN_S2_ENDPOINT; set the endpoint too",
      );
    return new MemoryStreams();
  }
  return createS2Streams({
    endpoint: s2Endpoint,
    ...(s2Token ? { token: s2Token } : {}),
    ...(options.basinPrefix ? { basinPrefix: options.basinPrefix } : {}),
  });
}

/**
 * Readiness probe: resolves when the streams' service answers within
 * `signal`'s lifetime. In-memory streams are always ready.
 */
export async function probeStreams(
  streams: DurableStreams,
  signal: AbortSignal,
): Promise<void> {
  await streams.probe?.(signal);
}
