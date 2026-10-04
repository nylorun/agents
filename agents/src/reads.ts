/** Optional public reads shared by Studio, CLI and custom clients. */
import {
  ModelCallExportPageSchema,
  SessionPageSchema,
  type SessionListItem,
  type SessionPage,
  type ModelCallExportPage,
} from "@nylorun/core/contracts";
import type { Transport } from "./http.js";
export type SessionPageOptions = {
  agentId?: string;
  status?: SessionListItem["status"];
  sandboxId?: string;
  ownerUserId?: string;
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
};
export class SessionsReadClient {
  constructor(private readonly transport: Transport) {}
  async page(options: SessionPageOptions = {}): Promise<SessionPage> {
    await this.transport.requireFeature("session-reads", options.signal);
    const { signal, ...filters } = options;
    const query = new URLSearchParams({ limit: String(options.limit ?? 50) });
    for (const [key, value] of Object.entries(filters))
      if (value !== undefined) query.set(key, String(value));
    return SessionPageSchema.parse(
      await this.transport.json(`/v1/sessions?${query}`, "GET", undefined, signal),
    );
  }
}
export class CallsReadClient {
  constructor(private readonly transport: Transport) {}
  /** Pages preserve their resume position. caughtUp ends this drain; call again to follow. */
  async *exportModel(
    options: { after?: string; limit?: number; signal?: AbortSignal } = {},
  ): AsyncIterable<ModelCallExportPage> {
    await this.transport.requireFeature("calls-export", options.signal);
    let after = options.after;
    while (true) {
      const query = new URLSearchParams({ limit: String(options.limit ?? 200) });
      if (after !== undefined) query.set("after", after);
      const page = ModelCallExportPageSchema.parse(
        await this.transport.json(
          `/v1/tenant/calls/model?${query}`,
          "GET",
          undefined,
          options.signal,
        ),
      );
      yield page;
      if (page.caughtUp) return;
      if (page.next === null || page.next === after)
        throw new Error("Model export did not advance its cursor");
      after = page.next;
    }
  }
}
