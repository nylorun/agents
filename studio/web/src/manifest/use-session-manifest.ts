import { useEffect, useState } from "react";
import { createTenantClient } from "@/proxy-client";
import type { PinnedManifestState } from "./model";

/** Host feature that adds `GET /v1/sessions/{id}/manifest` and the other session reads. */
const SESSION_READS = "session-reads";

type SessionManifestResponse = {
  manifestHash: string;
  manifest: Record<string, unknown>;
};

/**
 * The manifest a session is pinned to, read from the Runtime (`GET /v1/sessions/{id}/manifest`)
 * when the Host offers session reads, and whether the session has a sandbox (`GET
 * /v1/sessions/{id}`). Without session reads Studio can only show the registered manifest and
 * says so.
 */
export function useSessionManifest(
  tenantId: string | undefined,
  sessionId: string,
  registeredHash: string | undefined,
): Readonly<{ pinned: PinnedManifestState; hasSandbox: boolean }> {
  const [pinned, setPinned] = useState<PinnedManifestState>({ kind: "loading" });
  const [hasSandbox, setHasSandbox] = useState(false);
  useEffect(() => {
    if (!tenantId) return;
    const abort = new AbortController();
    const client = createTenantClient(tenantId);
    setPinned({ kind: "loading" });
    void (async () => {
      try {
        const [features, view] = await Promise.all([
          client.hostFeatures({ signal: abort.signal }),
          client.session(sessionId).inspect(abort.signal),
        ]);
        if (abort.signal.aborted) return;
        setHasSandbox((view as { sandbox?: unknown }).sandbox != null);
        if (!features.includes(SESSION_READS)) {
          setPinned({ kind: "registered-only", registeredHash });
          return;
        }
        const read = await client.transport.json<SessionManifestResponse>(
          `/v1/sessions/${encodeURIComponent(sessionId)}/manifest`,
          "GET",
          undefined,
          abort.signal,
        );
        if (abort.signal.aborted) return;
        setPinned({
          kind: "pinned",
          manifest: read.manifest,
          manifestHash: read.manifestHash,
          registeredHash,
        });
      } catch (error) {
        if (!abort.signal.aborted)
          setPinned({
            kind: "failed",
            message: error instanceof Error ? error.message : String(error),
          });
      }
    })();
    return () => abort.abort();
  }, [tenantId, sessionId, registeredHash]);
  return { pinned, hasSandbox };
}
