import type { IncomingMessage, ServerResponse } from "node:http";
import { newTenantId } from "@nylorun/core/compatibility";
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
    connectedExecutors: 0,
    pendingActions: 0,
    uncertainEffects: 0,
  };
  return {
    envelope: options.envelope,
    setSummary(next) {
      summary = next;
    },
    async handle(
      _request: IncomingMessage,
      _response: ServerResponse,
      _url: URL,
    ) {},
    async summary() {
      return { ...summary };
    },
    async drain(activeWork) {
      await options.onDrain?.(activeWork);
      summary = {
        ...summary,
        runningSessions: 0,
        pendingActions: 0,
      };
    },
    async close() {
      await options.onClose?.();
    },
  };
}

export interface FakeRuntimeOptions {
  hostRoot: string;
  beforeOpen?: (config: TenantConfig) => void | Promise<void>;
  openDelayMs?: number;
  failFor?: ReadonlySet<string> | ((id: string) => Error | undefined);
}

/**
 * A fake `OpenTenantRuntime`: a handle with the store's envelope that does nothing. It closes
 * the store it was handed, as the real Tenant Runtime does.
 */
export function createFakeOpenRuntime(
  options: FakeRuntimeOptions,
): OpenTenantRuntime {
  return async (config, opened) => {
    await options.beforeOpen?.(config);
    if (options.openDelayMs && options.openDelayMs > 0) {
      await new Promise((r) => setTimeout(r, options.openDelayMs));
    }
    const fail =
      typeof options.failFor === "function"
        ? options.failFor(config.tenantId)
        : options.failFor?.has(config.tenantId)
          ? new Error(`forced open failure for ${config.tenantId}`)
          : undefined;
    if (fail) throw fail;

    return createFakeHandle({
      envelope: opened.envelope,
      onClose: () => opened.store.close(),
    });
  };
}

export function bootstrapMaterial(
  overrides: Partial<{
    principalId: string;
    credentialHash: string;
    idempotencyKey: string;
  }> = {},
) {
  return {
    principalId:
      overrides.principalId ?? `principal_${newTenantId().slice(3)}`,
    credentialHash: overrides.credentialHash ?? "ab".repeat(32),
    idempotencyKey:
      overrides.idempotencyKey ?? `idem_${newTenantId().slice(3)}`,
  };
}

export function configForRoot(
  hostRoot: string,
): (id: string) => TenantConfig {
  return (tenantId) => ({
    tenantId,
    mode: "test",
    paths: tenantPaths(hostRoot, tenantId),
    sandbox: { backend: "virtual" },
    model: { kind: "fixture" },
    childEnv: Object.freeze({
      HOME: tenantPaths(hostRoot, tenantId).home,
      TMPDIR: tenantPaths(hostRoot, tenantId).tmp,
    }),
    logger: silentLogger(),
  });
}
