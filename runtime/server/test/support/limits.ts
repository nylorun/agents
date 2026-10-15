/**
 * A store for a stubbed Tenant vault (`TenantVault.store`) whose Tenant sets no Runtime limits:
 * the gates read `limits.config` from it and get the defaults.
 */
export const noLimitsStore = {
  tx: <T>(work: (t: { getSetting(key: string): Promise<string | undefined> }) => Promise<T>) =>
    work({ getSetting: async () => undefined }),
};
