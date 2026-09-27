import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AdminTenant,
  AdminTenantStatus,
  HostAggregate,
  TenantEnvelope,
} from "@nylorun/core/contracts";
import type { FlowLimits } from "../core/limits.js";
import type { SandboxBackend } from "../sandbox/types.js";

export type TenantMode = "shared" | "ephemeral" | "test";

export interface TenantPaths {
  // all absolute; derived by tenantPaths()
  root: string;
  envelope: string;
  database: string;
  lock: string;
  kek: string;
  home: string;
  tmp: string;
  migration: string;
  sandboxes: string;
  pluginData: string;
  logs: string;
  log: string;
}

export type TenantModelConfig =
  | { kind: "vault" } // shared default: Tenant vault selection
  | { kind: "gateway"; url: string; model: string } // token in vault (D11)
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
  childEnv: Readonly<Record<string, string>>; // allowlisted base + Tenant HOME/TMPDIR
  leaseMs?: number;
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
  connectedExecutors: number;
  pendingActions: number;
  uncertainEffects: number;
}

/** An open Tenant Runtime. Created only by the Tenant module. */
export interface TenantHandle {
  readonly envelope: TenantEnvelope;
  /** Headers already validated by the Host. Authenticates, authorizes, dispatches. */
  handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void>;
  summary(): TenantSummary;
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
    | "locked"
    | "kek-missing"
    | "corrupt"
    | "schema-too-new"
    | "migration-failed"
    | "envelope-invalid"
    | "open-timeout"
    | "open-failed";
  message: string; // redacted, no secrets
  repair: string; // CLI command or instruction
  lockPath?: string;
  lockPid?: number;
}

export interface BootstrapPrincipal {
  principalId: string;
  credentialHash: string;
  idempotencyKey: string;
}

/** The deep module (§8). HTTP, CLI and tests use only this. */
export interface TenantModule {
  start(): Promise<void>; // discover + open all (pool 4, 30 s)
  readonly started: boolean;
  resolve(id: string): TenantResolution;
  create(
    input: { tenantId: string; name: string } & BootstrapPrincipal,
  ): Promise<{ envelope: TenantEnvelope; created: boolean }>;
  list(): Promise<readonly AdminTenant[]>;
  status(id: string): Promise<AdminTenantStatus | undefined>;
  delete(
    id: string,
    activeWork: "refuse" | "drain" | "cancel",
  ): Promise<void>;
  summarize(): HostAggregate;
  close(): Promise<void>;
}

/** Storage adapter behind the module (§8): OSS directory+SQLite, and in-memory for tests. */
export interface TenantStore {
  enumerate(): Promise<readonly string[]>; // directory names that look like ids
  readEnvelope(id: string): Promise<TenantEnvelope>; // throws typed errors
  create(
    envelope: TenantEnvelope,
    bootstrap: BootstrapPrincipal,
  ): Promise<"created" | "exists">;
  bootstrapMatches(
    id: string,
    bootstrap: BootstrapPrincipal,
  ): Promise<boolean>;
  open(id: string): Promise<TenantHandle>; // runs migration, may throw Quarantine
  trash(id: string, now: Date): Promise<void>;
  removePartial(id: string): Promise<void>;
}

/** Injected into the store so WS-B can test without WS-A. */
export type OpenTenantRuntime = (
  config: TenantConfig,
) => Promise<TenantHandle>;
