import { existsSync, readFileSync } from "node:fs";
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
import {
  claimTenantLock,
  releaseTenantLock,
} from "../../src/tenant/store-fs.js";

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
  lockPath?: string;
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
      if (options.lockPath) releaseTenantLock(options.lockPath);
    },
  };
}

export interface FakeRuntimeOptions {
  hostRoot: string;
  /** Claim .runtime-lock when opening (FS adapter tests). */
  claimLock?: boolean;
  beforeOpen?: (config: TenantConfig) => void | Promise<void>;
  openDelayMs?: number;
  failFor?: ReadonlySet<string> | ((id: string) => Error | undefined);
}

function readEnvelopeIfPresent(
  paths: { envelope: string },
  fallbackId: string,
): TenantEnvelope {
  if (existsSync(paths.envelope)) {
    try {
      return JSON.parse(readFileSync(paths.envelope, "utf8")) as TenantEnvelope;
    } catch {
      /* fall through */
    }
  }
  const iso = new Date().toISOString();
  return {
    id: fallbackId,
    name: fallbackId,
    createdAt: iso,
    updatedAt: iso,
    schemaVersion: 1,
  };
}

export function createFakeOpenRuntime(
  options: FakeRuntimeOptions,
): OpenTenantRuntime {
  return async (config) => {
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

    const paths = config.paths;
    if (options.claimLock) {
      claimTenantLock(paths.lock);
    }
    const envelope = readEnvelopeIfPresent(paths, config.tenantId);
    return createFakeHandle({
      envelope,
      lockPath: options.claimLock ? paths.lock : undefined,
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
