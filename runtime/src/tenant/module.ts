import { isTenantId } from "@nylorun/core/compatibility";
import type {
  AdminTenant,
  AdminTenantStatus,
  HostAggregate,
  TenantEnvelope,
} from "@nylorun/core/contracts";
import { TENANT_SCHEMA_VERSION } from "./schema.js";
import { envelopeNow } from "./envelope.js";
import { TimeoutError, withTimeout } from "./pool.js";
import {
  asQuarantine,
  isQuarantineError,
  quarantine,
  TenantBusyError,
  TenantConflictError,
} from "./quarantine.js";
import {
  TenantNotFoundError,
  type BootstrapPrincipal,
  type Logger,
  type OpenTenantRuntime,
  type Quarantine,
  type TenantConfig,
  type TenantHandle,
  type TenantModule,
  type TenantResolution,
  type TenantStore,
  type TenantSummary,
} from "./types.js";

const OPEN_TIMEOUT_MS = 30_000;

export interface CreateTenantModuleOptions {
  store: TenantStore;
  /** Unused: the store derives paths. Accepted so callers can pass the store's options. */
  hostRoot?: string;
  /** Unused: the store opens Tenants. Accepted so callers can pass the store's options. */
  openRuntime?: OpenTenantRuntime;
  /** Unused; see `openRuntime`. */
  configFor?: (tenantId: string) => TenantConfig;
  logger: Logger;
  /** Bound on one Tenant open; a slower open quarantines it with `open-timeout`. */
  openTimeoutMs?: number;
  /**
   * Runs after a Tenant is removed from the store: removes what lives outside it (its
   * Durable Streams basin, its armed sweep). A failure is logged; the Tenant stays deleted.
   */
  onDeleted?: (tenantId: string) => Promise<void>;
}

type OpenEntry = { kind: "open"; handle: TenantHandle };
type Entry = OpenEntry | { kind: "quarantined"; quarantine: Quarantine };

function hasLiveWork(summary: TenantSummary): boolean {
  return (
    summary.runningSessions > 0 ||
    summary.connectedExecutors > 0 ||
    summary.pendingActions > 0
  );
}

function toAdmin(
  id: string,
  entry: Entry | undefined,
  envelope: TenantEnvelope | null,
): AdminTenant {
  if (entry?.kind === "open") {
    return {
      id,
      name: entry.handle.envelope.name,
      state: "open",
      envelope: entry.handle.envelope,
    };
  }
  return {
    id,
    name: envelope?.name ?? null,
    state: entry ? "quarantined" : "open",
    envelope,
  };
}

/** The quarantine an open failure carries, from either quarantine error type. */
function quarantineOf(error: unknown): Quarantine | undefined {
  const carried = (error as { quarantine?: unknown } | null)?.quarantine;
  if (carried && typeof carried === "object" && "code" in carried)
    return carried as Quarantine;
  return asQuarantine(error);
}

/**
 * Deep Tenant module (§8): discovery, create, resolve, list, delete and summarize over an
 * injected `TenantStore`.
 *
 * Handles open on demand and are cached (architecture §8.2). The first call that needs a
 * Tenant (`resolve`, `status`, `worker`, `delete`) opens it once, even when several ask at
 * the same time; a failed open is cached as a quarantine, and a missing Tenant is not
 * cached. A Tenant being deleted resolves as not found, so a late request or Worker call
 * cannot reopen it while its storage is removed.
 */
export function createTenantModule(
  options: CreateTenantModuleOptions,
): TenantModule {
  const { store, logger, openTimeoutMs = OPEN_TIMEOUT_MS } = options;

  const entries = new Map<string, Entry>();
  const opening = new Map<string, Promise<Entry | undefined>>();
  const deleting = new Set<string>();
  let started = false;
  let closed = false;

  function rememberQuarantine(id: string, q: Quarantine): Entry {
    const entry: Entry = { kind: "quarantined", quarantine: q };
    entries.set(id, entry);
    logger.warn("tenant quarantined", {
      tenantId: id,
      code: q.code,
      repair: q.repair,
    });
    return entry;
  }

  async function openEntry(id: string): Promise<Entry | undefined> {
    let handle: TenantHandle;
    try {
      handle = await withTimeout(store.open(id), openTimeoutMs, (late) => {
        void late.then((h) => h.close()).catch(() => undefined);
      });
    } catch (error) {
      if (error instanceof TenantNotFoundError) return undefined;
      if (closed || deleting.has(id)) return undefined;
      if (error instanceof TimeoutError)
        return rememberQuarantine(
          id,
          quarantine("open-timeout", `open timed out after ${openTimeoutMs}ms`, {
            tenantId: id,
          }).toQuarantine(),
        );
      return rememberQuarantine(
        id,
        quarantineOf(error) ??
          quarantine(
            "open-failed",
            error instanceof Error ? error.message : "open failed",
            { tenantId: id },
          ).toQuarantine(),
      );
    }
    if (closed || deleting.has(id)) {
      await handle.close().catch(() => undefined);
      return undefined;
    }
    const entry: Entry = { kind: "open", handle };
    entries.set(id, entry);
    return entry;
  }

  /** The cached entry, or the result of opening the Tenant once. */
  async function load(id: string): Promise<Entry | undefined> {
    if (deleting.has(id)) return undefined;
    const cached = entries.get(id);
    if (cached) return cached;
    if (closed) return undefined;
    let pending = opening.get(id);
    if (!pending) {
      pending = openEntry(id).finally(() => opening.delete(id));
      opening.set(id, pending);
    }
    return pending;
  }

  const openEntries = (): OpenEntry[] =>
    [...entries.values()].filter((e): e is OpenEntry => e.kind === "open");

  const module: TenantModule = {
    get started() {
      return started;
    },

    async start() {
      if (closed) throw new Error("Tenant module is closed");
      const ids = await store.enumerate();
      started = true;
      logger.info("tenant module started", { tenants: ids.length });
    },

    async resolve(id: string): Promise<TenantResolution> {
      if (!isTenantId(id)) return { kind: "not-found" };
      const entry = await load(id);
      if (!entry) return { kind: "not-found" };
      if (entry.kind === "open") return { kind: "open", handle: entry.handle };
      return { kind: "quarantined", quarantine: entry.quarantine };
    },

    async worker(id: string) {
      if (!isTenantId(id)) return undefined;
      const entry = await load(id);
      return entry?.kind === "open" ? entry.handle.worker : undefined;
    },

    async create(input) {
      if (!isTenantId(input.tenantId)) {
        throw new Error(`Invalid tenant id: ${input.tenantId}`);
      }
      const bootstrap: BootstrapPrincipal = {
        principalId: input.principalId,
        credentialHash: input.credentialHash,
        idempotencyKey: input.idempotencyKey,
        ...(input.studioCredentialHash
          ? { studioCredentialHash: input.studioCredentialHash }
          : {}),
      };
      // The store records its own schema version.
      const envelope = envelopeNow({
        id: input.tenantId,
        name: input.name,
        schemaVersion: TENANT_SCHEMA_VERSION,
      });

      let outcome: "created" | "exists";
      try {
        outcome = await store.create(envelope, bootstrap);
      } catch (error) {
        await store.removePartial(input.tenantId).catch(() => undefined);
        throw error;
      }

      if (outcome === "exists") {
        const matches = await store.bootstrapMatches(
          input.tenantId,
          bootstrap,
        );
        if (!matches) throw new TenantConflictError();
        const existing = await store.readEnvelope(input.tenantId);
        await load(input.tenantId);
        return { envelope: existing, created: false };
      }

      const opened = await load(input.tenantId);
      if (opened?.kind === "open") {
        return { envelope: opened.handle.envelope, created: true };
      }
      // Created but failed to open: report the stored envelope.
      return {
        envelope: await store
          .readEnvelope(input.tenantId)
          .catch(() => envelope),
        created: true,
      };
    },

    async list() {
      const ids = new Set<string>(await store.enumerate());
      for (const id of entries.keys()) ids.add(id);

      const result: AdminTenant[] = [];
      for (const id of [...ids].sort()) {
        if (!isTenantId(id) || deleting.has(id)) continue;
        let entry = entries.get(id);
        if (entry?.kind === "open") {
          result.push(toAdmin(id, entry, null));
          continue;
        }
        let envelope: TenantEnvelope | null = null;
        try {
          envelope = await store.readEnvelope(id);
          if (envelope.id !== id) {
            entry = rememberQuarantine(
              id,
              quarantine(
                "envelope-invalid",
                `Tenant envelope id ${envelope.id} does not match ${id}`,
                { tenantId: id },
              ).toQuarantine(),
            );
            envelope = null;
          }
        } catch (error) {
          entry ??= rememberQuarantine(
            id,
            quarantineOf(error) ??
              quarantine("envelope-invalid", "Tenant envelope is unreadable", {
                tenantId: id,
              }).toQuarantine(),
          );
        }
        result.push(toAdmin(id, entry, envelope));
      }
      return result;
    },

    async status(id: string): Promise<AdminTenantStatus | undefined> {
      if (!isTenantId(id)) return undefined;
      const entry = await load(id);
      if (!entry) return undefined;
      if (entry.kind === "open") return toAdmin(id, entry, null);
      const envelope = await store.readEnvelope(id).catch(() => null);
      return { ...toAdmin(id, entry, envelope), quarantine: entry.quarantine };
    },

    async delete(id, activeWork) {
      if (!isTenantId(id)) throw new Error(`Invalid tenant id: ${id}`);
      if (deleting.has(id)) throw new TenantBusyError("Tenant is being deleted");
      const entry = await load(id);
      if (!entry) throw new TenantNotFoundError(id);

      if (entry.kind === "open") {
        const summary = await entry.handle.summary();
        if (activeWork === "refuse" && hasLiveWork(summary)) {
          throw new TenantBusyError();
        }
        if (activeWork === "drain" || activeWork === "cancel") {
          await entry.handle.drain(activeWork);
        }
      }

      deleting.add(id);
      try {
        entries.delete(id);
        // Sandbox prefix cleanup is owned by TenantHandle.close().
        if (entry.kind === "open") await entry.handle.close();
        await store.trash(id, new Date());
      } finally {
        deleting.delete(id);
      }
      logger.info("tenant deleted", { tenantId: id, activeWork });
      await options.onDeleted?.(id).catch((error: unknown) =>
        logger.warn("tenant delete cleanup failed", {
          tenantId: id,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    },

    async summarize(): Promise<HostAggregate> {
      let runningSessions = 0;
      let connectedExecutors = 0;
      let pendingActions = 0;
      let uncertainEffects = 0;
      for (const s of await Promise.all(
        openEntries().map((e) => e.handle.summary()),
      )) {
        runningSessions += s.runningSessions;
        connectedExecutors += s.connectedExecutors;
        pendingActions += s.pendingActions;
        uncertainEffects += s.uncertainEffects;
      }
      return {
        runningSessions,
        connectedExecutors,
        pendingActions,
        uncertainEffects,
      };
    },

    async close() {
      closed = true;
      started = false;
      await Promise.allSettled([...opening.values()]);
      const open = openEntries();
      entries.clear();
      await Promise.all(
        open.map((e) => e.handle.close().catch(() => undefined)),
      );
    },
  };

  return module;
}

export {
  TenantBusyError,
  TenantConflictError,
  TenantNotFoundError,
  isQuarantineError,
  quarantine,
};
