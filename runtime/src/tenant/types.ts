import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AdminTenant,
  AdminTenantStatus,
  HostAggregate,
  TenantEnvelope,
} from "@nylorun/core/contracts";
import type { FlowLimits } from "../core/limits.js";
import type { SessionStore } from "../store/types.js";
import type { SandboxBackend } from "../sandbox/types.js";
import type { OutboundPolicy } from "./outbound.js";
import type { TenantWorker } from "./worker.js";

export type TenantMode = "shared" | "ephemeral" | "test";

/**
 * The Tenant directory on the Host root. The Tenant's data lives in its store (a Postgres
 * schema); this holds what stays on the Host: the vault key, plugin data, logs, and the
 * private home, tmp and sandbox directories.
 */
export interface TenantPaths {
  // all absolute; derived by tenantPaths()
  root: string;
  kek: string;
  home: string;
  tmp: string;
  sandboxes: string;
  pluginData: string;
  logs: string;
  log: string;
}

export type TenantModelConfig =
  | { kind: "vault" } // shared default: Tenant vault selection, served by the Model Gate
  | { kind: "fixture" }
  | { kind: "scripted"; output?: string }; // ephemeral/test only (D10)

export interface TenantConfig {
  // internal read model, never client-supplied
  tenantId: string;
  mode: TenantMode;
  paths: TenantPaths;
  sandbox: {
    backend: "auto" | "virtual";
    backends?: readonly SandboxBackend[];
  };
  model: TenantModelConfig;
  /**
   * Segment rollover (Model Calls §10): a turn ends its segment at a step boundary after this
   * many steps or milliseconds and continues in a new one, so no advance reaches its
   * deadline. Default 50 steps or 20 minutes.
   */
  rollover?: { steps?: number; ms?: number };
  /** Retries and timeouts for model calls (Model Calls §5, §6). Defaults in `piModel`. */
  modelCall?: import("../gates/model-gate.js").ModelCallSettings;
  childEnv: Readonly<Record<string, string>>; // allowlisted base + Tenant HOME/TMPDIR
  /** Action claim lease. Default 30 s. */
  /** How the Runtime may call Action endpoints (Host settings). Default: http and private addresses allowed. */
  delivery?: OutboundPolicy;
  leaseMs?: number;
  /** Ownership lease of an advance (§10.6); renewed every third while it runs. Default 30 s. */
  ownerLeaseMs?: number;
  /**
   * Delay between Tenant sweep passes when the Tenant runs its own in-process execution.
   * Default `min(leaseMs, 5 s)`. A Host-level execution sets its own.
   */
  sweepIntervalMs?: number;
  /** Operator flow limits (`RuntimeOptions.flow` / `workflows.md` §13). */
  flow?: Partial<FlowLimits>;
  /**
   * Optional env snapshot for `NYLORUN_FLOW_*`. Host passes this; the Runtime
   * never reads ambient process environment for flow limits.
   */
  flowEnv?: Readonly<Record<string, string | undefined>>;
  vaultFetch?: typeof fetch;
  logger: Logger;
}

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface TenantSummary {
  // redacted; counts only
  ready: boolean;
  runningSessions: number;
  /** Deliveries to Action endpoints in flight on this process. */
  inFlightDeliveries: number;
  pendingActions: number;
  uncertainEffects: number;
}

/**
 * The Node request and response behind a `Request`, for what still writes to Node directly
 * (event streams). The shape of `@hono/node-server`'s `HttpBindings`.
 */
export interface NodeBindings {
  readonly incoming: IncomingMessage;
  readonly outgoing: ServerResponse;
}

/** An open Tenant Runtime. Created only by the Tenant module. */
export interface TenantHandle {
  readonly envelope: TenantEnvelope;
  /** The handlers Durable Session Execution calls for this Tenant (`worker.ts`). */
  readonly worker?: TenantWorker;
  /**
   * A Tenant API request whose headers the Host has validated: authenticates, authorizes,
   * dispatches. A response already written to `node.outgoing` is `RESPONSE_ALREADY_SENT`.
   */
  fetch(request: Request, node: NodeBindings): Promise<Response>;
  summary(): Promise<TenantSummary>;
  /** Stop scheduling; wait for or cancel active turns. */
  drain(activeWork: "drain" | "cancel", timeoutMs?: number): Promise<void>;
  close(): Promise<void>; // ends every stream this Tenant holds
}

export type TenantResolution =
  | { kind: "open"; handle: TenantHandle }
  | { kind: "not-found" }
  | { kind: "quarantined"; quarantine: Quarantine };

export interface Quarantine {
  code:
    | "kek-missing"
    | "corrupt"
    | "schema-too-new"
    | "migration-failed"
    | "envelope-invalid"
    | "open-timeout"
    | "open-failed";
  message: string; // redacted, no secrets
  repair: string; // CLI command or instruction
}

export interface BootstrapPrincipal {
  principalId: string;
  credentialHash: string;
  idempotencyKey: string;
  /** When set, also registers application principal `studio` with this hash. */
  studioCredentialHash?: string;
  /** Application principals whose keys the admin key derives (feature `derived-principals`). */
  derivedPrincipals?: readonly DerivedPrincipal[];
}

export interface DerivedPrincipal {
  id: string;
  credentialHash: string;
}

/**
 * The deep module (§8). HTTP, CLI and tests use only this.
 *
 * Tenants open on demand (architecture §8.2): the first `resolve`, `status`, `worker` or
 * `delete` naming a Tenant opens it (bounded by the open timeout) and caches the handle or
 * the quarantine; `start` only marks discovery done, so a Host with many Tenants opens none
 * at startup.
 */
export interface TenantModule {
  /** Marks discovery done (`/ready`). Opens nothing. */
  start(): Promise<void>;
  readonly started: boolean;
  /** Opens the Tenant on first use; a missing Tenant is `not-found`. */
  resolve(id: string): Promise<TenantResolution>;
  /**
   * The Tenant's Worker handlers, opening it on demand, for `TenantWorkers.resolve`.
   * Undefined when the Tenant does not exist, is quarantined or is being deleted, or the
   * module is closed.
   */
  worker(id: string): Promise<TenantWorker | undefined>;
  create(
    input: { tenantId: string; name: string } & BootstrapPrincipal,
  ): Promise<{ envelope: TenantEnvelope; created: boolean }>;
  /**
   * Every Tenant the store holds, without opening any. A Tenant not opened yet is listed
   * `open` when its envelope reads; opening it may still quarantine it.
   */
  list(): Promise<readonly AdminTenant[]>;
  status(id: string): Promise<AdminTenantStatus | undefined>;
  delete(
    id: string,
    activeWork: "refuse" | "drain" | "cancel",
  ): Promise<void>;
  summarize(): Promise<HostAggregate>;
  close(): Promise<void>;
}

/**
 * Storage adapter behind the module (§8): a Postgres schema per Tenant (`store-pg.ts`), and
 * in-memory for tests (`store-memory.ts`).
 */
export interface TenantStore {
  /** Ids of every Tenant the store holds. */
  enumerate(): Promise<readonly string[]>;
  /** Throws a quarantine error when unreadable, `TenantNotFoundError` when gone. */
  readEnvelope(id: string): Promise<TenantEnvelope>;
  /**
   * Creates the Tenant, or returns `exists` when it already exists (whatever its bootstrap
   * material; the module compares it with `bootstrapMatches`). The stored envelope's
   * `schemaVersion` is the store's own; read it back with `readEnvelope`.
   */
  create(
    envelope: TenantEnvelope,
    bootstrap: BootstrapPrincipal,
  ): Promise<"created" | "exists">;
  bootstrapMatches(
    id: string,
    bootstrap: BootstrapPrincipal,
  ): Promise<boolean>;
  /**
   * Opens the Tenant Runtime; runs migration. Throws `TenantNotFoundError` when the Tenant
   * does not exist, `TenantUnavailableError` when something outside the Tenant failed, and
   * any other error (a quarantine error, ideally) when the Tenant itself cannot be opened.
   */
  open(id: string): Promise<TenantHandle>;
  /** Removes the Tenant: its data and its Tenant directory. */
  trash(id: string, now: Date): Promise<void>;
  /** Removes what a failed `create` left, never an existing Tenant. */
  removePartial(id: string): Promise<void>;
}

/**
 * Thrown by a store when a Tenant cannot be reached for a reason outside it (the database
 * or Durable Session Execution is unavailable). The module does not quarantine it: the next
 * use tries again. The Host answers 503.
 */
export class TenantUnavailableError extends Error {
  readonly status = 503;
  constructor(
    readonly tenantId: string,
    options?: { cause?: unknown },
  ) {
    super("Tenant is temporarily unavailable", options);
    this.name = "TenantUnavailableError";
  }
}

/** Thrown by `TenantStore.open` for a Tenant that does not exist. */
export class TenantNotFoundError extends Error {
  constructor(readonly tenantId: string) {
    super(`Tenant ${tenantId} not found`);
    this.name = "TenantNotFoundError";
  }
}

/** What a Tenant store hands the Tenant Runtime it opens. */
export interface OpenedTenant {
  /**
   * The Tenant's opened Session Store. The Tenant Runtime owns it from here on and closes it
   * on close or on a failed open.
   */
  store: SessionStore;
  /** The Tenant envelope as its store reports it. */
  envelope: TenantEnvelope;
}

/** Opens the Tenant Runtime on a store the Tenant store opened (injected, so tests can fake it). */
export type OpenTenantRuntime = (
  config: TenantConfig,
  opened: OpenedTenant,
) => Promise<TenantHandle>;
