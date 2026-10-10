/** Optional public reads shared by Studio, CLI and custom clients. */
import {
  SessionPageSchema,
  type SessionListItem,
  type SessionPage,
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
