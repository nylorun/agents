/**
 * The Tenant's runs (D83, Host feature `agent-triggers`): `client.runs.stream()` follows every
 * run of every Agent's triggers, from a cursor, as `GET /v1/runs/stream` serves them. For an
 * application key that reads Agents (`agents:read`).
 */
import type { TenantRun } from "@nylorun/core/contracts";
import type { Transport } from "./http.js";
import { observeSSE } from "./sse.js";

/** One run on the stream, and the cursor to resume after it. */
export interface TenantRunEvent {
  readonly cursor: string;
  readonly run: TenantRun;
}

export class RunsClient {
  constructor(private readonly transport: Transport) {}

  /**
   * The Tenant's runs from `cursor` (the last one a reader kept; none reads from the oldest the
   * stream keeps, 7 days), following the stream until `signal` aborts. It reconnects from the
   * last run on its own. A run may arrive twice: drop a `runId` already seen. A cursor from before
   * the Tenant's reset throws a `RuntimeError` with status 410 and code `cursor_expired`: read
   * again without one.
   */
  async *stream(options: { cursor?: string; signal?: AbortSignal } = {}): AsyncIterable<TenantRunEvent> {
    await this.transport.requireFeature("agent-triggers", options.signal);
    for await (const event of observeSSE(this.transport, "/v1/runs/stream", {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    })) {
      if (event.event !== "run") continue;
      const data = JSON.parse(event.data) as TenantRunEvent;
      yield { cursor: data.cursor, run: data.run };
    }
  }
}
