import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EnvironmentManifestView, EnvironmentView } from "@nylorun/agents";
import { createTenantClient } from "@/proxy-client";
import { messageOf } from "@/resources/reads";

/**
 * The Tenant's Environments and environment manifests, read whole as the session list is, so
 * the sidebar and the Environments table group and count them the same way.
 */
export type EnvironmentCatalog = {
  status: "Loading" | "Ready" | "Failed";
  /** A read is in flight; what was read before stays until it answers. */
  pending: boolean;
  environments: readonly EnvironmentView[];
  manifests: readonly EnvironmentManifestView[];
  /** Why the Environments could not be read. */
  error: string;
  /** Why the manifests could not be read; the Environments still show. */
  manifestsError: string;
  reload: () => void;
};

/** Reads the catalog once, and again on each `reload`; a newer read wins over an older one. */
export function useEnvironmentCatalog(tenantId: string): EnvironmentCatalog {
  const sdk = useMemo(() => createTenantClient(tenantId), [tenantId]);
  const [state, setState] = useState<Omit<EnvironmentCatalog, "reload">>({
    status: "Loading",
    pending: true,
    environments: [],
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
      sdk.environments.list({ signal: current.signal }).then((listed) => {
        // A body without the list (`{}`): say what is missing.
        if (!Array.isArray(listed))
          throw new Error("The Runtime did not return the Tenant's Environments.");
        return listed;
      }),
      sdk.environments.manifests.list({ signal: current.signal }),
    ]).then(([environments, manifests]) => {
      if (current.signal.aborted) return;
      setState((previous) => ({
        status: environments.status === "fulfilled" ? "Ready" : "Failed",
        pending: false,
        environments:
          environments.status === "fulfilled" ? environments.value : previous.environments,
        manifests:
          manifests.status === "fulfilled"
            ? Array.isArray(manifests.value)
              ? manifests.value
              : []
            : previous.manifests,
        error: environments.status === "rejected" ? messageOf(environments.reason) : "",
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
