import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentManifestView, AgentView } from "@nylorun/agents";
import { createTenantClient } from "@/proxy-client";
import { messageOf } from "@/resources/reads";

/**
 * The Tenant's Agents and agent manifests (protocol 16), read whole as the session list is, so
 * the sidebar, the Agents table and the manifests group and count them the same way.
 */
export type AgentCatalog = {
  status: "Loading" | "Ready" | "Failed";
  /** A read is in flight; what was read before stays until it answers. */
  pending: boolean;
  agents: readonly AgentView[];
  /** Each manifest's latest version. */
  manifests: readonly AgentManifestView[];
  /** Why the Agents could not be read. */
  error: string;
  /** Why the manifests could not be read; the Agents still show. */
  manifestsError: string;
  reload: () => void;
};

/** Reads the catalog once, and again on each `reload`; a newer read wins over an older one. */
export function useAgentCatalog(tenantId: string): AgentCatalog {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const [state, setState] = useState<Omit<AgentCatalog, "reload">>({
    status: "Loading",
    pending: true,
    agents: [],
    manifests: [],
    error: "",
    manifestsError: "",
  });
  const latest = useRef<AbortController | null>(null);
  const reload = useCallback(() => {
    latest.current?.abort();
    const current = new AbortController();
    latest.current = current;
    setState((previous) => ({ ...previous, pending: true }));
    void Promise.allSettled([
      sdk.agents.list({ signal: current.signal }).then((listed) => {
        // A body without the list (`{}`): say what is missing.
        if (!Array.isArray(listed)) throw new Error("The Runtime did not return the Tenant's Agents.");
        return listed;
      }),
      sdk.agentManifests.list({ signal: current.signal }),
    ]).then(([agents, manifests]) => {
      if (current.signal.aborted) return;
      setState((previous) => ({
        status: agents.status === "fulfilled" ? "Ready" : "Failed",
        pending: false,
        agents: agents.status === "fulfilled" ? agents.value : previous.agents,
        manifests:
          manifests.status === "fulfilled"
            ? Array.isArray(manifests.value)
              ? manifests.value
              : []
            : previous.manifests,
        error: agents.status === "rejected" ? messageOf(agents.reason) : "",
        manifestsError: manifests.status === "rejected" ? messageOf(manifests.reason) : "",
      }));
    });
  }, [sdk]);
  useEffect(() => {
    reload();
    return () => latest.current?.abort();
  }, [reload]);
  return useMemo(() => ({ ...state, reload }), [state, reload]);
}
