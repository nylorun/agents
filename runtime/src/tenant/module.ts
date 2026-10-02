import type {
  HostAggregate,
  HostTenant,
  StreamRelayStatus,
  TenantEnvelope,
} from "@nylorun/core/contracts";
import { openError, TenantOpenError, type TenantCause } from "./cause.js";
import { TimeoutError, withTimeout } from "./pool.js";
import {
  TenantUnavailableError,
  type Logger,
  type TenantHandle,
  type TenantModule,
  type TenantOpener,
  type TenantResolution,
} from "./types.js";

const OPEN_TIMEOUT_MS = 30_000;
/** Retries of an open that failed outside the Tenant: from 1 s, doubling, at most 30 s apart. */
const RETRY_FIRST_MS = 1_000;
const RETRY_MAX_MS = 30_000;

export interface CreateTenantModuleOptions {
  /** Opens the Host's Tenant (`store-pg.ts`). */
  open: TenantOpener;
  logger: Logger;
  /** Bound on opening the Tenant; a slower open fails with `open-timeout`. */
  openTimeoutMs?: number;
  /**
   * Runs once the Tenant is open, at start or on a later retry: the Host starts what needs the
   * Tenant's id (its stream relay). A failure is logged; the Tenant stays open.
   */
  onOpen?: (handle: TenantHandle) => void | Promise<void>;
  /** This process's stream relay, for the Host aggregate (a Host with S2 runs one). */
  relayStatus?: () => Promise<StreamRelayStatus>;
}

type State =
  | { kind: "idle" }
  | { kind: "open"; handle: TenantHandle }
  /** Opening failed for a reason in the Tenant: reported until the Host restarts. */
  | { kind: "failed"; cause: TenantCause; envelope: TenantEnvelope | null }
  /** Opening failed outside the Tenant: retried. */
  | { kind: "unavailable"; error: TenantUnavailableError }
  | { kind: "closed" };

/**
 * Deep Tenant module (§8): the Host's one Tenant over an injected opener (tenancy.md §5).
 *
 * `start` opens it once, even when requests or Worker calls ask at the same time. An open that
 * fails for a reason in the Tenant (a `TenantOpenError`, or a timeout) is kept as the Tenant's
 * cause: the Host is not ready, `/v1/admin/status` names it, requests get the opaque 404.
 * One that fails outside the Tenant (`TenantUnavailableError`) is retried in the background
 * with backoff, and by the next request, which gets 503 meanwhile.
 */
export function createTenantModule(options: CreateTenantModuleOptions): TenantModule {
  const { logger, openTimeoutMs = OPEN_TIMEOUT_MS } = options;
  let state: State = { kind: "idle" };
  let opening: Promise<void> | undefined;
  let retry: NodeJS.Timeout | undefined;
  let nextDelayMs = RETRY_FIRST_MS;
  const current = (): State => state;

  async function openOnce(): Promise<void> {
    let handle: TenantHandle;
    try {
      handle = await withTimeout(options.open(), openTimeoutMs, (late) => {
        void late.then((h) => h.close()).catch(() => undefined);
      });
    } catch (error) {
      if (current().kind === "closed") return;
      if (error instanceof TenantUnavailableError) {
        state = { kind: "unavailable", error };
        logger.warn("tenant unavailable", {
          message: error.cause instanceof Error ? error.cause.message : String(error.cause),
          retryMs: nextDelayMs,
        });
        scheduleRetry();
        return;
      }
      const failure =
        error instanceof TenantOpenError
          ? error
          : error instanceof TimeoutError
            ? openError("open-timeout", `Opening the Tenant timed out after ${openTimeoutMs}ms`)
            : openError(
                "open-failed",
                error instanceof Error ? error.message : "Opening the Tenant failed",
              );
      const failed = {
        kind: "failed" as const,
        cause: failure.toCause(),
        envelope: failure.envelope ?? null,
      };
      state = failed;
      logger.error("tenant not opened", {
        ...(failed.envelope ? { tenantId: failed.envelope.id } : {}),
        code: failed.cause.code,
        message: failed.cause.message,
        repair: failed.cause.repair,
      });
      return;
    }
    if (current().kind === "closed") {
      await handle.close().catch(() => undefined);
      return;
    }
    state = { kind: "open", handle };
    nextDelayMs = RETRY_FIRST_MS;
    logger.info("tenant opened", { tenantId: handle.envelope.id });
    try {
      await options.onOpen?.(handle);
    } catch (error) {
      logger.warn("tenant open step failed", {
        tenantId: handle.envelope.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Opens the Tenant unless it is open, failed or closed; one open at a time. */
  function load(): Promise<void> {
    const { kind } = current();
    if (kind !== "idle" && kind !== "unavailable") return Promise.resolve();
    clearTimeout(retry);
    retry = undefined;
    opening ??= openOnce().finally(() => {
      opening = undefined;
    });
    return opening;
  }

  function scheduleRetry(): void {
    if (retry) return;
    const delayMs = nextDelayMs;
    nextDelayMs = Math.min(delayMs * 2, RETRY_MAX_MS);
    retry = setTimeout(() => {
      retry = undefined;
      void load();
    }, delayMs);
    retry.unref();
  }

  const module: TenantModule = {
    get ready() {
      return current().kind === "open";
    },

    async start() {
      if (current().kind === "closed") throw new Error("Tenant module is closed");
      await load();
    },

    async resolve(): Promise<TenantResolution> {
      await load();
      const now = current();
      switch (now.kind) {
        case "open":
          return { kind: "open", handle: now.handle };
        case "failed":
          return { kind: "unavailable", cause: now.cause };
        case "unavailable":
          throw now.error;
        default:
          return { kind: "unavailable" };
      }
    },

    async worker(id) {
      await load();
      const now = current();
      return now.kind === "open" && now.handle.envelope.id === id
        ? now.handle.worker
        : undefined;
    },

    tenant(): HostTenant {
      const now = current();
      switch (now.kind) {
        case "open": {
          const { envelope } = now.handle;
          return { id: envelope.id, name: envelope.name, state: "open", envelope };
        }
        case "failed":
          return {
            id: now.envelope?.id ?? null,
            name: now.envelope?.name ?? null,
            state: "unavailable",
            envelope: now.envelope,
            cause: now.cause,
          };
        default:
          return { id: null, name: null, state: "unavailable", envelope: null };
      }
    },

    async summarize(): Promise<HostAggregate> {
      const now = current();
      const summary = now.kind === "open" ? await now.handle.summary() : undefined;
      const relay = await options.relayStatus?.().catch(() => undefined);
      return {
        runningSessions: summary?.runningSessions ?? 0,
        inFlightDeliveries: summary?.inFlightDeliveries ?? 0,
        pendingActions: summary?.pendingActions ?? 0,
        uncertainEffects: summary?.uncertainEffects ?? 0,
        ...(relay ? { relay } : {}),
      };
    },

    async close() {
      const previous = current();
      state = { kind: "closed" };
      clearTimeout(retry);
      retry = undefined;
      // An open in progress sees `closed` and closes what it opened.
      await opening?.catch(() => undefined);
      if (previous.kind === "open") await previous.handle.close().catch(() => undefined);
    },
  };

  return module;
}

export { TenantUnavailableError };
