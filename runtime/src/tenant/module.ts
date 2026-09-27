import { existsSync } from "node:fs";
import { isTenantId } from "@nylorun/core/compatibility";
import type {
  AdminTenant,
  AdminTenantStatus,
  HostAggregate,
  TenantEnvelope,
} from "@nylorun/core/contracts";
import { TENANT_SCHEMA_VERSION } from "./schema.js";
import { envelopeNow } from "./envelope.js";
import { tenantPaths } from "./paths.js";
import { mapPool, TimeoutError, withTimeout } from "./pool.js";
import {
  asQuarantine,
  isQuarantineError,
  quarantine,
  TenantBusyError,
  TenantConflictError,
} from "./quarantine.js";
import type {
  BootstrapPrincipal,
  Logger,
  OpenTenantRuntime,
  Quarantine,
  TenantConfig,
  TenantHandle,
  TenantModule,
  TenantResolution,
  TenantStore,
  TenantSummary,
} from "./types.js";

const OPEN_CONCURRENCY = 4;
const OPEN_TIMEOUT_MS = 30_000;

export interface CreateTenantModuleOptions {
  hostRoot: string;
  store: TenantStore;
  openRuntime: OpenTenantRuntime;
  configFor: (tenantId: string) => TenantConfig;
  logger: Logger;
  openConcurrency?: number;
  openTimeoutMs?: number;
}

type Entry =
  | { kind: "open"; handle: TenantHandle }
  | { kind: "quarantined"; quarantine: Quarantine };

function hasLiveWork(summary: TenantSummary): boolean {
  return (
    summary.runningSessions > 0 ||
    summary.connectedExecutors > 0 ||
    summary.pendingActions > 0
  );
}

function toAdmin(id: string, entry: Entry | undefined, envelope: TenantEnvelope | null): AdminTenant {
  if (!entry) {
    return {
      id,
      name: envelope?.name ?? null,
      state: "quarantined",
      envelope,
    };
  }
  if (entry.kind === "open") {
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
    state: "quarantined",
    envelope,
  };
}

/**
 * Deep Tenant module (§8). Discovery, create, resolve, list, delete and
 * summarize. Storage and Tenant Runtime are injected so WS-B tests without WS-A.
 */
export function createTenantModule(
  options: CreateTenantModuleOptions,
): TenantModule {
  const {
    hostRoot,
    store,
    logger,
    openConcurrency = OPEN_CONCURRENCY,
    openTimeoutMs = OPEN_TIMEOUT_MS,
  } = options;
  // openRuntime / configFor are consumed by the store; kept on options for B1.
  void options.openRuntime;
  void options.configFor;

  const entries = new Map<string, Entry>();
  let started = false;
  let closed = false;

  function rememberOpen(handle: TenantHandle): void {
    entries.set(handle.envelope.id, { kind: "open", handle });
  }

  function rememberQuarantine(id: string, q: Quarantine): void {
    entries.set(id, { kind: "quarantined", quarantine: q });
    logger.warn("tenant quarantined", {
      tenantId: id,
      code: q.code,
      repair: q.repair,
    });
  }

  async function openOne(id: string): Promise<void> {
    const existing = entries.get(id);
    if (existing?.kind === "open") return;
    try {
      const handle = await withTimeout(
        store.open(id),
        openTimeoutMs,
        (late) => {
          void late
            .then((h) => h.close())
            .catch(() => undefined);
        },
      );
      rememberOpen(handle);
    } catch (error) {
      if (error instanceof TimeoutError) {
        rememberQuarantine(
          id,
          quarantine("open-timeout", `open timed out after ${openTimeoutMs}ms`, {
            tenantId: id,
          }).toQuarantine(),
        );
        return;
      }
      const q = asQuarantine(error);
      if (q) {
        rememberQuarantine(id, q);
        return;
      }
      rememberQuarantine(
        id,
        quarantine(
          "open-failed",
          error instanceof Error ? error.message : "open failed",
          { tenantId: id },
        ).toQuarantine(),
      );
    }
  }

  async function discoverId(id: string): Promise<Entry | undefined> {
    if (entries.has(id)) return entries.get(id);
    const paths = tenantPaths(hostRoot, id);
    if (!existsSync(paths.root)) return undefined;
    await openOne(id);
    return entries.get(id);
  }

  const module: TenantModule = {
    get started() {
      return started;
    },

    async start() {
      if (closed) throw new Error("Tenant module is closed");
      const ids = await store.enumerate();
      await mapPool(ids, openConcurrency, async (id) => {
        await openOne(id);
      });
      started = true;
      logger.info("tenant module started", {
        tenants: ids.length,
        open: [...entries.values()].filter((e) => e.kind === "open").length,
        quarantined: [...entries.values()].filter(
          (e) => e.kind === "quarantined",
        ).length,
      });
    },

    async resolve(id: string): Promise<TenantResolution> {
      if (!isTenantId(id)) return { kind: "not-found" };
      const entry = entries.get(id);
      if (!entry) {
        // Miss: existence check only (disk I/O allowed on miss). Full open
        // happens on list()/status()/create(); Host sees opaque not-found until then.
        try {
          const paths = tenantPaths(hostRoot, id);
          if (!existsSync(paths.root)) return { kind: "not-found" };
        } catch {
          return { kind: "not-found" };
        }
        return { kind: "not-found" };
      }
      if (entry.kind === "open") {
        return { kind: "open", handle: entry.handle };
      }
      return { kind: "quarantined", quarantine: entry.quarantine };
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
        const entry = entries.get(input.tenantId);
        if (!entry || entry.kind !== "open") {
          await openOne(input.tenantId);
        }
        return { envelope: existing, created: false };
      }

      await openOne(input.tenantId);
      const opened = entries.get(input.tenantId);
      if (opened?.kind === "open") {
        return { envelope: opened.handle.envelope, created: true };
      }
      // Created on disk but failed to open — still report the written envelope.
      return { envelope, created: true };
    },

    async list() {
      const ids = new Set<string>(await store.enumerate());
      for (const id of entries.keys()) ids.add(id);

      const result: AdminTenant[] = [];
      for (const id of ids) {
        if (!isTenantId(id)) continue;
        let entry = entries.get(id);
        if (!entry) {
          await openOne(id);
          entry = entries.get(id);
        }

        let envelope: TenantEnvelope | null = null;
        try {
          envelope = await store.readEnvelope(id);
          if (envelope.id !== id) {
            rememberQuarantine(
              id,
              quarantine(
                "envelope-invalid",
                `tenant.json id ${envelope.id} does not match directory ${id}`,
                { tenantId: id },
              ).toQuarantine(),
            );
            entry = entries.get(id);
            envelope = null;
          }
        } catch (error) {
          const q = asQuarantine(error);
          if (q) {
            rememberQuarantine(id, q);
            entry = entries.get(id);
          } else {
            rememberQuarantine(
              id,
              quarantine(
                "envelope-invalid",
                "tenant.json is unreadable",
                { tenantId: id },
              ).toQuarantine(),
            );
            entry = entries.get(id);
          }
          envelope = null;
        }

        result.push(toAdmin(id, entry, envelope));
      }
      return result;
    },

    async status(id: string): Promise<AdminTenantStatus | undefined> {
      if (!isTenantId(id)) return undefined;
      let entry = entries.get(id);
      if (!entry) {
        entry = await discoverId(id);
        if (!entry) {
          // Not in memory and not on disk.
          const known = (await store.enumerate()).includes(id);
          if (!known) return undefined;
          await openOne(id);
          entry = entries.get(id);
        }
      }
      if (!entry) return undefined;

      let envelope: TenantEnvelope | null = null;
      try {
        envelope =
          entry.kind === "open"
            ? entry.handle.envelope
            : await store.readEnvelope(id);
      } catch {
        envelope = null;
      }

      const base = toAdmin(id, entry, envelope);
      if (entry.kind === "quarantined") {
        return { ...base, quarantine: entry.quarantine };
      }
      return base;
    },

    async delete(id, activeWork) {
      if (!isTenantId(id)) throw new Error(`Invalid tenant id: ${id}`);
      let entry = entries.get(id);
      if (!entry) {
        await discoverId(id);
        entry = entries.get(id);
      }
      if (!entry) {
        // Still on disk without an entry?
        const ids = await store.enumerate();
        if (!ids.includes(id)) {
          throw quarantine("open-failed", `Tenant ${id} not found`, {
            tenantId: id,
          });
        }
        await openOne(id);
        entry = entries.get(id);
      }

      if (entry?.kind === "open") {
        const summary = await entry.handle.summary();
        if (activeWork === "refuse" && hasLiveWork(summary)) {
          throw new TenantBusyError();
        }
        if (activeWork === "drain" || activeWork === "cancel") {
          await entry.handle.drain(activeWork);
        }
        // Sandbox prefix cleanup is owned by TenantHandle.close() (WS-A).
        await entry.handle.close();
      }

      await store.trash(id, new Date());
      entries.delete(id);
      logger.info("tenant deleted", { tenantId: id, activeWork });
    },

    async summarize(): Promise<HostAggregate> {
      let runningSessions = 0;
      let connectedExecutors = 0;
      let pendingActions = 0;
      let uncertainEffects = 0;
      const open = [...entries.values()].filter(
        (e): e is { kind: "open"; handle: TenantHandle } => e.kind === "open",
      );
      for (const s of await Promise.all(open.map((e) => e.handle.summary()))) {
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
      const open = [...entries.values()].filter(
        (e): e is { kind: "open"; handle: TenantHandle } => e.kind === "open",
      );
      await Promise.all(
        open.map((e) => e.handle.close().catch(() => undefined)),
      );
      entries.clear();
    },
  };

  return module;
}

export {
  TenantBusyError,
  TenantConflictError,
  isQuarantineError,
  quarantine,
};
