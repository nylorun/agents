/**
 * The Management API client (`/v1/tenant/*`, protocol 8): the Tenant's settings, models,
 * credential coverage, MCP server previews, signing keys and application keys, with a
 * management key. An Environment's secrets are written on the Runtime API
 * (`@nylorun/agents`, `client.environments.secrets`). It imports nothing from
 * Node, so a browser app that reaches the Runtime through its own proxy (Studio) uses it too:
 * `@nylorun/admin/client`. `createAdmin()` in the package's main entry finds the URL and key.
 */
import { parseBody, requestHeaders } from "@nylorun/core/transport";
import {
  ModelCallExportPageSchema,
  type CredentialCoverage,
  type CredentialCoverageRequest,
  type HostModelCatalog,
  type HostModelView,
  type ListProvidersResponse,
  type McpPreview,
  type McpPreviewRequest,
  type ModelCallExportPage,
  type ModelBudgets,
  type ModelInputsView,
  type ModelUsageQuery,
  type ModelUsageTotals,
  type OperatorKey,
  type PutHostModelRequest,
  type PutModelBudgetsRequest,
  type PutModelInputsRequest,
  type PutToolPolicyRequest,
  type PutOperatorKeyResponse,
  type PutTenantArtifactsRequest,
  type PutTenantEnvironmentsRequest,
  type ResetTenantRequest,
  type ResetTenantResponse,
  type SeedTenantConfigRequest,
  type SeedTenantConfigResponse,
  type SelectHostModelRequest,
  type SigningKeyView,
  type TenantArtifactsView,
  type TenantSandboxView,
  type TenantStatus,
  type ToolPolicy,
} from "@nylorun/core/contracts";
import { AdminError, rejection } from "./errors.js";

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
  /** Resets the Tenant's sessions, Environments or both. */
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
  /**
   * Sets what a catalog model reads beyond its catalog's inputs (protocol 12): only inputs in its
   * `addableInputs`; an empty list removes the additions. A custom endpoint sets
   * `settings.inputs` with `put` instead.
   */
  setInputs(request: Body<PutModelInputsRequest>): Promise<ModelInputsView>;
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

export interface ManagementMcp {
  /**
   * A remote MCP server's tools before an agent names it (R2b C12): the Runtime connects with
   * the credential for `url` in the vault of `environmentId` (none without one), lists the
   * tools and closes; it never calls
   * one. Each tool has the name the model would call it, made with `name` (default: from the
   * URL's host). A server that needs a person's sign-in answers `authRequired`, with its
   * protected-resource metadata. A server that cannot be listed rejects with
   * `mcp_preview_failed` (`details.failure`).
   */
  preview(request: McpPreviewRequest): Promise<McpPreview>;
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
    /** The Tenant's Environment settings: limits, the pods' stop grace and placement. */
    put(request: Body<PutTenantEnvironmentsRequest>): Promise<TenantSandboxView>;
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
  /**
   * Which secret of Environment `environmentId` each remote MCP server and HTTP tool of the
   * saved agent `agentId` would get in a session that names it (`covered`), or none
   * (`missing`). Host feature `credential-coverage`.
   */
  readonly coverage: (request: Body<CredentialCoverageRequest>) => Promise<CredentialCoverage>;
  readonly mcp: ManagementMcp;
  /**
   * The rules the Tool Gate applies to every MCP and HTTP tool call (R5 step 2): `deny` refuses
   * a call, `ask` holds it until a person approves it on the session, `allow` runs it.
   */
  readonly toolPolicy: {
    get(): Promise<ToolPolicy>;
    /** Replaces every rule; an empty list allows every call. */
    put(request: Body<PutToolPolicyRequest>): Promise<ToolPolicy>;
  };
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
      setInputs: (request) => call("PUT", "/v1/tenant/models/inputs", withId(request)),
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
    this.coverage = (request) => call("POST", "/v1/tenant/credential-coverage", withId(request));
    this.toolPolicy = {
      get: () => call("GET", "/v1/tenant/tool-policy"),
      put: (request) => call("PUT", "/v1/tenant/tool-policy", withId(request)),
    };
    this.mcp = {
      preview: (request) => call("POST", "/v1/tenant/mcp/preview", request),
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
      ...requestHeaders(this.#key),
      accept: "application/json",
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
    const parsed = text ? parseBody(text) : undefined;
    if (!response.ok) throw rejection(response.status, parsed, `${method} ${path} failed`);
    return parsed as T;
  }
}

/** A Management API client for `url`, with a management key (or behind a proxy that adds one). */
export function createManagementClient(options: ManagementClientOptions): ManagementClient {
  return new ManagementClient(options);
}
