/**
 * The Management API client (`/v1/tenant/*`, protocol 8): the Tenant's settings, models,
 * vaults, signing keys and application keys, with a management key. It imports nothing from
 * Node, so a browser app that reaches the Runtime through its own proxy (Studio) uses it too:
 * `@nylorun/admin/client`. `createAdmin()` in the package's main entry finds the URL and key.
 */
import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
} from "@nylorun/core/compatibility";
import {
  ModelCallExportPageSchema,
  RejectedResponseSchema,
  type CreateCredentialRequest,
  type CreateVaultRequest,
  type CredentialInfo,
  type HostModelCatalog,
  type HostModelView,
  type ListProvidersResponse,
  type ModelCallExportPage,
  type ModelBudgets,
  type ModelUsageQuery,
  type ModelUsageTotals,
  type OperatorKey,
  type PutHostModelRequest,
  type PutModelBudgetsRequest,
  type PutOperatorKeyResponse,
  type PutTenantArtifactsRequest,
  type PutTenantSandboxRequest,
  type ResetTenantRequest,
  type ResetTenantResponse,
  type RotateCredentialRequest,
  type SeedTenantConfigRequest,
  type SeedTenantConfigResponse,
  type SelectHostModelRequest,
  type SigningKeyView,
  type StartOAuthRequest,
  type StartOAuthResponse,
  type TenantArtifactsView,
  type TenantSandboxView,
  type TenantStatus,
  type VaultInfo,
} from "@nylorun/core/contracts";
import { AdminError } from "./errors.js";

export interface ManagementClientOptions {
  /** The Tenant's URL, or a proxy in front of it. */
  url: string;
  /** A management key. Omit it behind a proxy that adds the credential (Studio's). */
  key?: string;
  /** Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Sent on every request, after the client's own headers. */
  headers?: Record<string, string>;
}

/** A request body without its `requestId`: the client makes one when it is not given. */
type Body<T> = Omit<T, "requestId"> & { requestId?: string };

export interface ManagementTenant {
  /** The Tenant's status: its envelope, schema, streams and harnesses. */
  status(): Promise<TenantStatus>;
  /** Seeds the Tenant's configuration where it is unset (`nylorun start` does this). */
  seed(request: Body<SeedTenantConfigRequest>): Promise<SeedTenantConfigResponse>;
  /** Resets the Tenant's sessions, sandboxes or both. */
  reset(request: Body<ResetTenantRequest>): Promise<ResetTenantResponse>;
}

/** The Tenant's keys: application keys are managed here; management keys only on its machine. */
export interface ManagementKeys {
  /** Every key by name, with its role and when it was issued; never the keys. */
  list(): Promise<OperatorKey[]>;
  /** Creates or rotates application key `id`; the key is in the answer this once. */
  put(id: string): Promise<PutOperatorKeyResponse>;
  /** Deletes application key `id`: true when it existed. */
  delete(id: string): Promise<boolean>;
}

export interface ManagementModels {
  /** Every provider and model the Runtime knows. */
  catalog(): Promise<HostModelCatalog>;
  /** The providers the Tenant has credentials for. */
  providers(): Promise<ListProvidersResponse>;
  /** The Tenant's model: provider, model and whether a credential is set. */
  get(): Promise<HostModelView>;
  /** Sets a provider's credential (and, optionally, the model). */
  put(request: Body<PutHostModelRequest>): Promise<HostModelView>;
  /** Chooses the provider and model among those with credentials. */
  select(request: Body<SelectHostModelRequest>): Promise<HostModelView>;
  /** What the Tenant's model calls used, for one scope and period. */
  usage(query: ModelUsageQuery): Promise<ModelUsageTotals>;
  /**
   * Every recorded model call, unfiltered, in safe transaction order (Host feature
   * `calls-export`): pages from `after` until `caughtUp`. Each page's `next` is the position to
   * resume from; call again to follow. Deduplicate by row id.
   */
  exportCalls(options?: { after?: string; limit?: number }): AsyncIterable<ModelCallExportPage>;
  readonly budgets: {
    get(): Promise<ModelBudgets>;
    /** Replaces every budget; an empty list removes every cap. */
    put(request: Body<PutModelBudgetsRequest>): Promise<ModelBudgets>;
  };
}

export interface ManagementVaults {
  create(request: Body<CreateVaultRequest>): Promise<VaultInfo>;
  /** The installation vaults, after `ownerUserId`'s when it is given. */
  list(ownerUserId?: string): Promise<VaultInfo[]>;
  get(vaultId: string): Promise<VaultInfo>;
  delete(vaultId: string): Promise<{ id: string }>;
  readonly credentials: {
    create(vaultId: string, request: Body<CreateCredentialRequest>): Promise<CredentialInfo>;
    list(vaultId: string): Promise<CredentialInfo[]>;
    get(vaultId: string, credentialId: string): Promise<CredentialInfo>;
    /** Rotates the credential's secret. */
    rotate(
      vaultId: string,
      credentialId: string,
      request: Body<RotateCredentialRequest>,
    ): Promise<CredentialInfo>;
    delete(vaultId: string, credentialId: string): Promise<{ id: string }>;
  };
  /** Starts an MCP OAuth connect into an installation vault: open `authorizeUrl` in a browser. */
  startOAuth(vaultId: string, request: StartOAuthRequest): Promise<StartOAuthResponse>;
}

export interface ManagementSigningKeys {
  list(): Promise<SigningKeyView[]>;
  /**
   * standby → current → previous → revoked, and a new standby. Refused while the key it would
   * revoke may still verify a live token; `force` skips that and ends those tokens.
   */
  rotate(options?: { force?: boolean }): Promise<SigningKeyView[]>;
  /** Revokes a previous or standby key; rotate before revoking the current one. */
  revoke(keyId: string): Promise<SigningKeyView>;
}

export interface ManagementSettings {
  readonly sandbox: {
    get(): Promise<TenantSandboxView>;
    put(request: Body<PutTenantSandboxRequest>): Promise<TenantSandboxView>;
  };
  readonly artifacts: {
    get(): Promise<TenantArtifactsView>;
    put(request: Body<PutTenantArtifactsRequest>): Promise<TenantArtifactsView>;
  };
}

const segment = (value: string) => encodeURIComponent(value);
const withId = <T extends object>(body: T): T & { requestId: string } => ({
  requestId: crypto.randomUUID(),
  ...body,
});

/** One client of the Management API. */
export class ManagementClient {
  readonly url: string;
  readonly tenant: ManagementTenant;
  readonly keys: ManagementKeys;
  readonly models: ManagementModels;
  readonly vaults: ManagementVaults;
  readonly signingKeys: ManagementSigningKeys;
  readonly settings: ManagementSettings;
  readonly #key: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #headers: Record<string, string>;

  constructor(options: ManagementClientOptions) {
    this.url = options.url.replace(/\/$/, "");
    this.#key = options.key;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#headers = options.headers ?? {};
    const call = <T>(method: string, path: string, body?: unknown) =>
      this.request<T>(method, path, body);
    this.tenant = {
      status: () => call("GET", "/v1/tenant"),
      seed: (request) => call("PUT", "/v1/tenant/config/seed", withId(request)),
      reset: (request) => call("POST", "/v1/tenant/reset", withId(request)),
    };
    this.keys = {
      list: async () => (await call<{ keys: OperatorKey[] }>("GET", "/v1/tenant/keys")).keys,
      put: (id) => call("PUT", `/v1/tenant/keys/${segment(id)}`),
      delete: async (id) => {
        try {
          await call("DELETE", `/v1/tenant/keys/${segment(id)}`);
          return true;
        } catch (error) {
          if (error instanceof AdminError && error.status === 404 && error.message === `No key ${id}`)
            return false;
          throw error;
        }
      },
    };
    this.models = {
      catalog: () => call("GET", "/v1/tenant/models"),
      providers: () => call("GET", "/v1/tenant/providers"),
      get: () => call("GET", "/v1/tenant/model"),
      put: (request) => call("PUT", "/v1/tenant/model", withId(request)),
      select: (request) => call("PUT", "/v1/tenant/model/selection", withId(request)),
      usage: (query) => {
        const search = new URLSearchParams(
          Object.entries(query).flatMap(([name, value]) =>
            value === undefined ? [] : [[name, String(value)]],
          ),
        );
        return call("GET", `/v1/tenant/usage?${search}`);
      },
      exportCalls: (options = {}) => this.pageCalls(options),
      budgets: {
        get: () => call("GET", "/v1/tenant/budgets"),
        put: (request) => call("PUT", "/v1/tenant/budgets", withId(request)),
      },
    };
    const vault = (vaultId: string) => `/v1/tenant/vaults/${segment(vaultId)}`;
    const credential = (vaultId: string, credentialId: string) =>
      `${vault(vaultId)}/credentials/${segment(credentialId)}`;
    this.vaults = {
      create: (request) => call("POST", "/v1/tenant/vaults", withId(request)),
      list: async (ownerUserId) =>
        (
          await call<{ vaults: VaultInfo[] }>(
            "GET",
            ownerUserId === undefined
              ? "/v1/tenant/vaults"
              : `/v1/tenant/vaults?ownerUserId=${segment(ownerUserId)}`,
          )
        ).vaults,
      get: (vaultId) => call("GET", vault(vaultId)),
      delete: (vaultId) => call("DELETE", vault(vaultId)),
      credentials: {
        create: (vaultId, request) =>
          call("POST", `${vault(vaultId)}/credentials`, withId(request)),
        list: async (vaultId) =>
          (await call<{ credentials: CredentialInfo[] }>("GET", `${vault(vaultId)}/credentials`))
            .credentials,
        get: (vaultId, credentialId) => call("GET", credential(vaultId, credentialId)),
        rotate: (vaultId, credentialId, request) =>
          call("POST", credential(vaultId, credentialId), withId(request)),
        delete: (vaultId, credentialId) => call("DELETE", credential(vaultId, credentialId)),
      },
      startOAuth: (vaultId, request) => call("POST", `${vault(vaultId)}/oauth/start`, request),
    };
    this.signingKeys = {
      list: async () =>
        (await call<{ keys: SigningKeyView[] }>("GET", "/v1/tenant/signing-keys")).keys,
      rotate: async (options = {}) =>
        (
          await call<{ keys: SigningKeyView[] }>(
            "POST",
            "/v1/tenant/signing-keys/rotate",
            withId(options.force ? { force: true } : {}),
          )
        ).keys,
      revoke: (keyId) =>
        call("POST", `/v1/tenant/signing-keys/${segment(keyId)}/revoke`, withId({})),
    };
    this.settings = {
      sandbox: {
        get: () => call("GET", "/v1/tenant/sandbox"),
        put: (request) => call("PUT", "/v1/tenant/sandbox", withId(request)),
      },
      artifacts: {
        get: () => call("GET", "/v1/tenant/artifacts"),
        put: (request) => call("PUT", "/v1/tenant/artifacts", withId(request)),
      },
    };
  }

  private async *pageCalls(options: {
    after?: string;
    limit?: number;
  }): AsyncIterable<ModelCallExportPage> {
    let after = options.after;
    while (true) {
      const query = new URLSearchParams({ limit: String(options.limit ?? 200) });
      if (after !== undefined) query.set("after", after);
      const page = ModelCallExportPageSchema.parse(
        await this.request<unknown>("GET", `/v1/tenant/calls/model?${query}`),
      );
      yield page;
      if (page.caughtUp) return;
      if (page.next === null || page.next === after)
        throw new Error("Model export did not advance its cursor");
      after = page.next;
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
      accept: "application/json",
      ...(this.#key ? { authorization: `Bearer ${this.#key}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...this.#headers,
    };
    const response = await this.#fetch(this.url + path, {
      method,
      headers,
      redirect: "error",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!response.ok) {
      const rejected = RejectedResponseSchema.safeParse(parsed);
      if (rejected.success)
        throw new AdminError(rejected.data.code, rejected.data.message, {
          status: response.status,
          details: rejected.data.details,
        });
      throw new AdminError("not_found", `${method} ${path} failed (${response.status})`, {
        status: response.status,
        details: parsed,
      });
    }
    return parsed as T;
  }
}

/** A Management API client for `url`, with a management key (or behind a proxy that adds one). */
export function createManagementClient(options: ManagementClientOptions): ManagementClient {
  return new ManagementClient(options);
}
