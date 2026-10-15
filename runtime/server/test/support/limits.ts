import type { RuntimeLimits } from "@nylorun/core/contracts";
import type { ModelCallSettings } from "../../src/gates/model-gate.js";
import type { SessionStore } from "../../src/store/types.js";
import { readLimitsConfig, writeLimitsConfig } from "../../src/tenant/runtime-limits.js";

/**
 * A store for a stubbed Tenant vault (`TenantVault.store`) whose Tenant sets no Runtime limits:
 * the gates read `limits.config` from it and get the defaults.
 */
export const noLimitsStore = {
  tx: <T>(work: (t: { getSetting(key: string): Promise<string | undefined> }) => Promise<T>) =>
    work({ getSetting: async () => undefined }),
};

/** The Runtime limits `model*` that model call settings stand for (B15). */
export function modelCallLimits(settings: ModelCallSettings): Partial<RuntimeLimits> {
  return {
    ...(settings.attempts === undefined ? {} : { modelAttempts: settings.attempts }),
    ...(settings.retryBaseDelayMs === undefined ? {} : { modelRetryDelayMs: settings.retryBaseDelayMs }),
    ...(settings.idleTimeoutMs === undefined ? {} : { modelIdleMs: settings.idleTimeoutMs }),
    ...(settings.requestTimeoutMs === undefined ? {} : { modelRequestMs: settings.requestTimeoutMs }),
    ...(settings.providerRetries === undefined ? {} : { modelProviderRetries: settings.providerRetries }),
    ...(settings.maxRetryDelayMs === undefined ? {} : { modelRetryDelayMaxMs: settings.maxRetryDelayMs }),
  };
}

/** Sets the Tenant's Runtime limits `set` beside the ones it has (`PUT /v1/tenant/limits` replaces). */
export async function setLimits(store: Pick<SessionStore, "tx">, set: Partial<RuntimeLimits>): Promise<void> {
  await store.tx(async (t) => {
    const current = await readLimitsConfig(t);
    await writeLimitsConfig(t, { limits: { ...current.limits, ...set } });
  });
}
