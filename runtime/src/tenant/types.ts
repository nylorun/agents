import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  HostAggregate,
  HostTenant,
  TenantEnvelope,
} from "@nylorun/core/contracts";
import type { FlowLimits } from "../core/limits.js";
import type { SessionStore } from "../store/types.js";
import type { SandboxBackend } from "../sandbox/types.js";
import type { TenantCause } from "./cause.js";
import type { OutboundPolicy } from "./outbound.js";
import type { TenantWorker } from "./worker.js";

export type TenantMode = "shared" | "ephemeral" | "test";

/**
 * The Tenant directory on the Host root (`<Host root>/tenant/`). The Tenant's data lives in
 * its database; this holds what stays on the Host: the vault key, plugin data, logs, and the
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
  /** The `fs` BlobStore's directory, used when the Host has no Object store. */
  blobs: string;
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

/**
 * The Host's Tenant for a request: open, or unavailable. `cause` says why when opening it
 * failed; without one the Host is starting or closing. Either way the request gets the opaque
 * 404.
 */
export type TenantResolution =
  | { kind: "open"; handle: TenantHandle }
  | { kind: "unavailable"; cause?: TenantCause };

/**
 * The deep module (§8): the one Tenant a Host serves (tenancy.md §5). HTTP, the Worker and
 * tests use only this.
 *
 * `start` opens the Tenant; the Host has it open from readiness to shutdown. There is no
 * Tenant list, no opening on demand of other Tenants and no quarantine cache: when opening
 * fails for a reason in the Tenant (a `TenantCause`), the Host fails readiness and reports
 * the cause until it is restarted. A failure outside the Tenant (`TenantUnavailableError`:
 * Postgres unreachable) is retried in the background and by the next request.
 */
export interface TenantModule {
  /** Opens the Tenant. Never rejects: a failure is recorded and reported by `tenant()`. */
  start(): Promise<void>;
  /** The Tenant is open (`/ready`). */
  readonly ready: boolean;
  /**
   * The open Tenant, waiting for an open in progress. Rejects with `TenantUnavailableError`
   * when it cannot be reached for a reason outside it.
   */
  resolve(): Promise<TenantResolution>;
  /**
   * The Tenant's Worker handlers when `id` is the open Tenant's, for `TenantWorkers.resolve`.
   * Undefined otherwise, or once the module is closed.
   */
  worker(id: string): Promise<TenantWorker | undefined>;
  /** The Tenant as `/v1/admin/status` reports it. */
  tenant(): HostTenant;
  summarize(): Promise<HostAggregate>;
  close(): Promise<void>;
}

/**
 * Opens the Host's Tenant (`store-pg.ts`): migrates its database, creates the Tenant when it
 * has none, and opens the Tenant Runtime. Rejects with a `TenantOpenError` (`cause.ts`) when
 * the Tenant itself cannot be opened, and with `TenantUnavailableError` when something
 * outside it failed.
 */
export type TenantOpener = () => Promise<TenantHandle>;

/**
 * Thrown when the Tenant cannot be reached for a reason outside it (the database or Durable
 * Session Execution is unavailable). Not a cause: the next use tries again. The Host answers
 * 503.
 */
export class TenantUnavailableError extends Error {
  readonly status = 503;
  constructor(options?: { cause?: unknown }) {
    super("Tenant is temporarily unavailable", options);
    this.name = "TenantUnavailableError";
  }
}

/** What the Tenant opener hands the Tenant Runtime it opens. */
export interface OpenedTenant {
  /**
   * The Tenant's opened Session Store. The Tenant Runtime owns it from here on and closes it
   * on close or on a failed open.
   */
  store: SessionStore;
  /** The Tenant envelope as its store reports it. */
  envelope: TenantEnvelope;
}

/** Opens the Tenant Runtime on an opened store (injected, so tests can fake it). */
export type OpenTenantRuntime = (
  config: TenantConfig,
  opened: OpenedTenant,
) => Promise<TenantHandle>;
