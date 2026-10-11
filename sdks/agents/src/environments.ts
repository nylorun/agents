/**
 * Environments (protocol 11, D55, D56): `client.environments`. An Environment is one sandbox
 * (kind `virtual`, `pod` or `none`) with a recipe that can change, and one vault of secrets for
 * its shell, MCP servers and HTTP tools. It has its own id and outlives the sessions that name
 * it; whether it serves one session, one person or a project is the app's choice, made here:
 *
 * - `environments.forSession(...)`: one Environment for one session. It creates the
 *   Environment, opens the session on it, and `release()` deletes the Environment (and its
 *   vault) when the session is done.
 * - `environments.put(id, recipe)`: one Environment per person or per project, by a
 *   deterministic id (`users/alice/web`); get-or-create, or change its recipe, in one call.
 *   Write its secrets with `environments.secrets.put(id, name, secret)` and open sessions on it
 *   with `createSession({ environment: id })`.
 *
 * Ids may hold `/`; they are sent percent-encoded as one path segment. Secret values are
 * write-only: no call reads one back.
 */
import {
  EnvironmentPageSchema,
  isEnvironmentId,
  type DeleteEnvironmentResponse,
  type EnvironmentEvent,
  type EnvironmentSecretView,
  type EnvironmentView,
  type PutEnvironmentRequest,
  type PutEnvironmentSecretRequest,
} from "@nylorun/core/contracts";
import { id, segment, type Transport } from "./http.js";
import type { CreateSessionOptions, SessionClient } from "./session-client.js";

/** What an Environment is made of: its kind, recipe, labels and owner guard. */
export type EnvironmentRecipeInput = Omit<PutEnvironmentRequest, "requestId">;
/** One secret of an Environment's vault, as written. */
export type EnvironmentSecretInput = PutEnvironmentSecretRequest;

/** A session opened on an Environment of its own (`environments.forSession`). */
export interface SessionEnvironmentHandle {
  readonly session: SessionClient;
  readonly environment: EnvironmentView;
  /** Deletes the Environment, its vault and its files; call it when the session is done. */
  release(options?: { signal?: AbortSignal }): Promise<DeleteEnvironmentResponse>;
}

export interface ForSessionOptions {
  /** The session to open, as `createSession` takes it, without `environment`. */
  readonly session: Omit<CreateSessionOptions, "environment">;
  /** The Environment's recipe and labels. Default: a virtual one within the Tenant's defaults. */
  readonly recipe?: EnvironmentRecipeInput;
  /** Secrets to write before the session opens, by name. */
  readonly secrets?: Readonly<Record<string, EnvironmentSecretInput>>;
  /** The Environment's id. Default: `sessions/<session id>`. */
  readonly environmentId?: string;
  readonly signal?: AbortSignal;
}

/** An Environment's secrets: `client.environments.secrets`. */
export class EnvironmentSecretsClient {
  constructor(
    private readonly transport: Transport,
    private readonly path: (environmentId: string) => string,
  ) {}

  /**
   * Creates or replaces secret `name` (`PUT /v1/environments/{id}/secrets/{name}`): for
   * `environment_secret` and `environment_variable` the name is the variable's. A second
   * credential for a host or a URL is a 409 `credential_conflict`.
   */
  async put(
    environmentId: string,
    name: string,
    secret: EnvironmentSecretInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<EnvironmentSecretView> {
    return this.transport.json(
      `${this.path(environmentId)}/secrets/${segment(name)}`,
      "PUT",
      { requestId: id(), ...secret },
      options.signal,
    );
  }

  /** The secrets' names, types and bindings; never a value. */
  async list(
    environmentId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<EnvironmentSecretView[]> {
    const reply = await this.transport.json<{ secrets: EnvironmentSecretView[] }>(
      `${this.path(environmentId)}/secrets`,
      "GET",
      undefined,
      options.signal,
    );
    return reply.secrets;
  }

  async get(
    environmentId: string,
    name: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<EnvironmentSecretView> {
    return this.transport.json(
      `${this.path(environmentId)}/secrets/${segment(name)}`,
      "GET",
      undefined,
      options.signal,
    );
  }

  async delete(
    environmentId: string,
    name: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ id: string }> {
    return this.transport.json(
      `${this.path(environmentId)}/secrets/${segment(name)}`,
      "DELETE",
      undefined,
      options.signal,
    );
  }
}

export class EnvironmentsClient {
  constructor(
    private readonly transport: Transport,
    /** `AgentsClient.createSession`, bound. */
    private readonly createSession: (options: CreateSessionOptions) => Promise<SessionClient>,
  ) {}

  private path(environmentId: string): string {
    if (!isEnvironmentId(environmentId))
      throw new TypeError(
        `${environmentId} is not an Environment id: up to 200 characters, /-separated segments of letters, digits, '.', '_' and '-'`,
      );
    return `/v1/environments/${segment(environmentId)}`;
  }

  /** The Environment's secrets. */
  get secrets(): EnvironmentSecretsClient {
    return new EnvironmentSecretsClient(this.transport, (environmentId) => this.path(environmentId));
  }

  /**
   * Creates the Environment and its vault, or finds the one with this id
   * (`PUT /v1/environments/{id}`). On an existing one, `kind` and `storage` are fixed (a
   * different one is a 409), labels replace, and any other change writes the recipe and bumps
   * its `version`: a pod's image and resources apply when it next starts from stopped.
   */
  async put(
    environmentId: string,
    recipe: EnvironmentRecipeInput = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<EnvironmentView> {
    return this.transport.json(
      this.path(environmentId),
      "PUT",
      { requestId: id(), ...recipe },
      options.signal,
    );
  }

  async get(environmentId: string, options: { signal?: AbortSignal } = {}): Promise<EnvironmentView> {
    return this.transport.json(this.path(environmentId), "GET", undefined, options.signal);
  }

  /** The Environments with every label in `labels` that this client reaches. */
  async list(
    options: { labels?: Readonly<Record<string, string>>; signal?: AbortSignal } = {},
  ): Promise<EnvironmentView[]> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options.labels ?? {}))
      query.append("label", `${key}=${value}`);
    const search = query.toString();
    const reply = await this.transport.json<{ environments: EnvironmentView[] }>(
      `/v1/environments${search ? `?${search}` : ""}`,
      "GET",
      undefined,
      options.signal,
    );
    return reply.environments;
  }

  async page(
    options: {
      labels?: Readonly<Record<string, string>>;
      limit?: number;
      cursor?: string;
      signal?: AbortSignal;
    } = {},
  ) {
    await this.transport.requireFeature("session-reads", options.signal);
    const query = new URLSearchParams({ limit: String(options.limit ?? 50) });
    if (options.cursor !== undefined) query.set("cursor", options.cursor);
    for (const [key, value] of Object.entries(options.labels ?? {}))
      query.append("label", `${key}=${value}`);
    return EnvironmentPageSchema.parse(
      await this.transport.json(`/v1/environments?${query}`, "GET", undefined, options.signal),
    );
  }

  /** Stops a pod Environment: its volume is kept, and the next turn starts it again. */
  async stop(environmentId: string, options: { signal?: AbortSignal } = {}): Promise<EnvironmentView> {
    return this.transport.json(`${this.path(environmentId)}/stop`, "POST", {}, options.signal);
  }

  /** Resets a pod Environment: a new pod on a new, empty volume, with its recipe applied. */
  async reset(environmentId: string, options: { signal?: AbortSignal } = {}): Promise<EnvironmentView> {
    return this.transport.json(`${this.path(environmentId)}/reset`, "POST", {}, options.signal);
  }

  /** Deletes the Environment, its vault and its files; `deleted` is false when there was none. */
  async delete(
    environmentId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<DeleteEnvironmentResponse> {
    return this.transport.json(this.path(environmentId), "DELETE", undefined, options.signal);
  }

  /** The Environment's lifecycle events, from `from` on. */
  async events(
    environmentId: string,
    options: { from?: number; signal?: AbortSignal } = {},
  ): Promise<EnvironmentEvent[]> {
    const reply = await this.transport.json<{ events: EnvironmentEvent[] }>(
      `${this.path(environmentId)}/events${options.from === undefined ? "" : `?from=${options.from}`}`,
      "GET",
      undefined,
      options.signal,
    );
    return reply.events;
  }

  /**
   * One Environment for one session: creates the Environment (`sessions/<session id>` unless
   * `environmentId` names another), writes `secrets`, opens the session on it, and returns both
   * with `release()`, which deletes the Environment. If the session cannot be opened, the
   * Environment is deleted again.
   */
  async forSession(options: ForSessionOptions): Promise<SessionEnvironmentHandle> {
    const sessionId = options.session.id ?? id();
    const environmentId =
      options.environmentId ??
      (isEnvironmentId(`sessions/${sessionId}`) ? `sessions/${sessionId}` : `sessions/${id()}`);
    const signal = options.signal ? { signal: options.signal } : {};
    const environment = await this.put(environmentId, options.recipe ?? {}, signal);
    let session: SessionClient;
    try {
      for (const [name, secret] of Object.entries(options.secrets ?? {}))
        await this.secrets.put(environmentId, name, secret, signal);
      session = await this.createSession({
        ...options.session,
        id: sessionId,
        environment: environmentId,
      });
    } catch (error) {
      await this.delete(environmentId).catch(() => undefined);
      throw error;
    }
    return {
      session,
      environment,
      release: (release = {}) => this.delete(environmentId, release),
    };
  }
}
