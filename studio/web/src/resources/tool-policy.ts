import { useCallback, useMemo } from "react";
import { createTenantManagementClient } from "@/proxy-client";
import { useRead } from "@/resources/reads";
import type { ToolRule } from "@/tenant-spec";

const NONE: readonly ToolRule[] = [];

/**
 * The Tenant's tool policy rules, for the notes beside an Agent's tools; none while they are
 * read, or when they cannot be. They are edited on the Tenant's page.
 */
export function useToolRules(tenantId: string): readonly ToolRule[] {
  const management = useMemo(() => createTenantManagementClient(tenantId), [tenantId]);
  const load = useCallback(
    async () => (await management.toolPolicy.get().catch(() => undefined))?.rules ?? NONE,
    [management],
  );
  return useRead(load).data ?? NONE;
}
