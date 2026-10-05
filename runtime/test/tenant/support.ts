import type { TenantEnvelope } from "@nylorun/core/contracts";
import { tenantPaths } from "../../src/tenant/paths.js";
import type {
  Logger,
  OpenTenantRuntime,
  TenantConfig,
  TenantHandle,
  TenantSummary,
} from "../../src/tenant/types.js";

export function silentLogger(): Logger {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

export interface FakeHandleOptions {
  envelope: TenantEnvelope;
  summary?: TenantSummary;
  onDrain?: (activeWork: "drain" | "cancel") => void | Promise<void>;
  onClose?: () => void | Promise<void>;
}

export function createFakeHandle(
  options: FakeHandleOptions,
): TenantHandle & { setSummary(next: TenantSummary): void } {
  let summary: TenantSummary = options.summary ?? {
    ready: true,
    runningSessions: 0,
    uncertainEffects: 0,
  };
  return {
    envelope: options.envelope,
    setSummary(next) {
      summary = next;
    },
    async fetch() {
      return new Response(null, { status: 204 });
    },
    async summary() {
      return { ...summary };
    },
    async drain(activeWork) {
      await options.onDrain?.(activeWork);
      summary = {
        ...summary,
        runningSessions: 0,
      };
    },
    async close() {
      await options.onClose?.();
    },
  };
}

/**
 * A fake `OpenTenantRuntime`: a handle with the store's envelope that does nothing. It closes
 * the store it was handed, as the real Tenant Runtime does.
 */
export function createFakeOpenRuntime(
  options: { beforeOpen?: (config: TenantConfig) => void | Promise<void> } = {},
): OpenTenantRuntime {
  return async (config, opened) => {
    await options.beforeOpen?.(config);
    return createFakeHandle({
      envelope: opened.envelope,
      onClose: () => opened.store.close(),
    });
  };
}

export function configForRoot(
  hostRoot: string,
): (id: string) => TenantConfig {
  return (tenantId) => ({
    tenantId,
    mode: "test",
    paths: tenantPaths(hostRoot),
    sandbox: { backend: "virtual" },
    model: { kind: "fixture" },
    logger: silentLogger(),
  });
}
