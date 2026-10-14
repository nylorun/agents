/**
 * Environments (protocol 11, D55, D56): `client.environments`. An Environment is one sandbox
 * (kind `virtual`, `pod` or `none`) made from an environment manifest's version or from inline
 * fields, and one vault of secrets for its shell, MCP servers and HTTP tools. It never changes
 * what it runs after it is made (protocol 14, D63): a new version reaches an agent through a new
 * Environment. It has its own id and outlives the sessions that name it; whether it serves one
 * session, one person or a project is the app's choice, made here:
 *
 * - `environments.forSession(...)`: one Environment for one session. It creates the
 *   Environment, opens the session on it, and `release()` deletes the Environment (and its
 *   vault) when the session is done.
 * - `environments.put(id, { manifest: "analyst-box" })` (or inline fields): one Environment per
 *   person or per project, by a deterministic id (`users/alice/web`); get-or-create in one call.
 *   Write its secrets with `environments.secrets.put(id, name, { value })` and open sessions on
 *   it with `createSession({ environment: id })`.
 * - `environments.manifests.save(manifest)`: save an environment manifest's next version, like
 *   `saveAgent`; `plan(manifest)` answers what a save would do and saves nothing.
 *
 * Ids may hold `/`; they are sent percent-encoded as one path segment. Secret values are
 * write-only: no call reads one back.
 *
 * Disk versions (Host feature `environment-disk-versions`): `snapshot(id)` keeps a version of
 * the Environment's disk between turns, `restore(id, version)` puts one back, and
 * `put(id, { from: { environment, version } })` creates a new Environment from another's version.
 *
 * `fork(id, { id: next })` is how an Environment gets a new manifest version (Q15): a new
 * Environment made from it, with the source's disk and secrets; `planFork` answers what it would do.
 */
import {
  ENVIRONMENT_MANIFEST_SCHEMA_VERSION,
  EnvironmentManifestSchema,
  EnvironmentPageSchema,
  isEnvironmentId,
  isEnvironmentManifestName,
  type DeleteEnvironmentManifestResponse,
  type EnvironmentManifest,
  type EnvironmentManifestPlan,
  type EnvironmentManifestVersions,
  type EnvironmentForkPlan,
  type EnvironmentManifestView,
  type ForkEnvironmentRequest,
  type SaveEnvironmentManifestResponse,
  type DeleteEnvironmentResponse,
  type EnvironmentEvent,
  type EnvironmentEventType,
  type EnvironmentRestore,
  type EnvironmentSecretView,
  type EnvironmentSnapshot,
  type EnvironmentVersions,
  type EnvironmentView,
  type PutEnvironmentRequest,
  type PutEnvironmentSecretRequest,
} from "@nylorun/core/contracts";
import { definitionFileHash, FilesClient } from "./files.js";
import { id, segment, type Transport } from "./http.js";
import type { CreateSessionOptions, SessionClient } from "./session-client.js";

/**
 * What an Environment is made from: an environment manifest (`manifest: "name"` or `"name@n"`)
 * or the inline fields, and its labels, owner guard and `from`.
 */
export type EnvironmentInput = Omit<PutEnvironmentRequest, "requestId">;
/**
 * One secret of an Environment's vault, as written: typed, or only its value (`{ value }`, or
 * `{ headers }` for a `headers` secret) when what the Environment runs declares its slot (D64).
 */
export type EnvironmentSecretInput =
  | PutEnvironmentSecretRequest
  | { readonly value: string }
  | { readonly headers: Readonly<Record<string, string>> };
/** An environment manifest as authored: `manifestSchemaVersion` may be left out. */
export type EnvironmentManifestInput = Omit<EnvironmentManifest, "manifestSchemaVersion"> & {
  readonly manifestSchemaVersion?: typeof ENVIRONMENT_MANIFEST_SCHEMA_VERSION;
  /** For editors; dropped here, as the CLI drops it. */
  readonly $schema?: string;
};

/**
 * An environment manifest (protocol 14, D63): checked now against the schema the Runtime
 * enforces, with `manifestSchemaVersion` filled in and `$schema` dropped. Save it with
 * `client.environments.manifests.save()`, or make an Environment from it inline.
 */
export function environmentManifest(input: EnvironmentManifestInput): EnvironmentManifest {
  const { $schema: _, ...rest } = input;
  return EnvironmentManifestSchema.parse({ manifestSchemaVersion: ENVIRONMENT_MANIFEST_SCHEMA_VERSION, ...rest });
}

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
  /**
   * What the Environment is made from (a `manifest` or inline fields) and its labels. Default: a
   * virtual one within the Tenant's defaults.
   */
  readonly recipe?: EnvironmentInput;
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
   * credential for a host or a URL is a 409 `credential_conflict`. When what the Environment
   * runs declares the secret's slot (D64), send only `{ value }` (or `{ headers }`); a name it
   * does not declare is `409 secret_not_in_manifest`.
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

/**
 * Environment manifests (protocol 14, D63): `client.environments.manifests`. A save writes the
 * manifest's next version, or answers the latest unchanged, and changes no Environment: an
 * Environment keeps the version it was made from.
 */
/** The bytes of files by hash, by `sha256:<hex>` (`environmentFiles(...).bytes`). */
export type EnvironmentFileBytes = Readonly<Record<string, Uint8Array>>;

/**
 * A manifest `files` entry by content hash (Q6): `contents` (each file's path under `path` and
 * its bytes or text) hashed, as `entry` for the manifest and `bytes` for `manifests.save`'s
 * `files`, which uploads them. Each file holds at most 10 MiB.
 */
export async function environmentFiles(
  path: string,
  contents: Readonly<Record<string, Uint8Array | string>>,
): Promise<{ entry: { path: string; files: Record<string, string> }; bytes: Record<string, Uint8Array> }> {
  const files: Record<string, string> = {};
  const bytes: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(contents).sort(([a], [b]) => a.localeCompare(b))) {
    const data = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const sha256 = await definitionFileHash(data);
    files[name] = sha256;
    bytes[sha256] = data;
  }
  return { entry: { path, files }, bytes };
}

export class EnvironmentManifestsClient {
  constructor(private readonly transport: Transport) {}

  private path(name: string): string {
    if (!isEnvironmentManifestName(name))
      throw new TypeError(`${name} is not an environment manifest's name: 1-64 letters, digits, '.', '_' and '-'`);
    return `/v1/environment-manifests/${segment(name)}`;
  }

  private async send<T>(
    manifest: EnvironmentManifestInput,
    query: string,
    options: { ifMatch?: number; files?: EnvironmentFileBytes; signal?: AbortSignal },
  ) {
    const { ifMatch, signal } = options;
    const body = environmentManifest(manifest);
    // Its files by hash (Q6): uploaded first, each only when the Runtime does not hold it.
    if (options.files)
      await new FilesClient(this.transport).ensure(
        new Map(Object.entries(options.files).map(([sha256, bytes]) => [sha256, { size: bytes.byteLength, read: async () => bytes }])),
        signal ? { signal } : {},
      );
    const transport = ifMatch === undefined ? this.transport : this.transport.withHeaders({ "If-Match": String(ifMatch) });
    return transport.json<T>(`${this.path(body.name)}${query}`, "PUT", { requestId: id(), ...body }, signal);
  }

  /**
   * Saves `manifest` (`PUT /v1/environment-manifests/{name}`). `ifMatch`: the version you read
   * (`0` for none yet); a save over a newer one is `412 manifest_changed`. `files`: the bytes of
   * its files by hash (`environmentFiles(...).bytes`), uploaded first when the Runtime lacks them.
   */
  async save(
    manifest: EnvironmentManifestInput,
    options: { ifMatch?: number; files?: EnvironmentFileBytes; signal?: AbortSignal } = {},
  ): Promise<SaveEnvironmentManifestResponse> {
    return this.send(manifest, "", options);
  }

  /** What saving `manifest` would do (`?dryRun=true`): changes, errors, warnings, and the Environments behind. */
  async plan(
    manifest: EnvironmentManifestInput,
    options: { ifMatch?: number; files?: EnvironmentFileBytes; signal?: AbortSignal } = {},
  ): Promise<EnvironmentManifestPlan> {
    return this.send(manifest, "?dryRun=true", options);
  }

  /** The latest version of manifest `name`, or version `version`. */
  async get(name: string, options: { version?: number; signal?: AbortSignal } = {}): Promise<EnvironmentManifestView> {
    return this.transport.json(
      `${this.path(name)}${options.version === undefined ? "" : `/versions/${options.version}`}`,
      "GET",
      undefined,
      options.signal,
    );
  }

  /** Each manifest's latest version. */
  async list(options: { signal?: AbortSignal } = {}): Promise<EnvironmentManifestView[]> {
    const reply = await this.transport.json<{ manifests: EnvironmentManifestView[] }>(
      "/v1/environment-manifests",
      "GET",
      undefined,
      options.signal,
    );
    return reply.manifests;
  }

  /** Every version of manifest `name`, newest first. */
  async versions(name: string, options: { signal?: AbortSignal } = {}): Promise<EnvironmentManifestVersions> {
    return this.transport.json(`${this.path(name)}/versions`, "GET", undefined, options.signal);
  }

  /** Deletes every version; refused while an Environment was made from one (`409 manifest_in_use`). */
  async delete(name: string, options: { signal?: AbortSignal } = {}): Promise<DeleteEnvironmentManifestResponse> {
    return this.transport.json(this.path(name), "DELETE", undefined, options.signal);
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

  /** Environment manifests (protocol 14, D63): named, versioned definitions of a kind of Environment. */
  get manifests(): EnvironmentManifestsClient {
    return new EnvironmentManifestsClient(this.transport);
  }

  /**
   * Creates the Environment and its vault, or finds the one with this id
   * (`PUT /v1/environments/{id}`), from an environment manifest (`{ manifest: "name" }` takes
   * the latest version, `"name@n"` version n) or from inline fields. It never changes what it
   * runs after that (protocol 14): on an existing one, labels replace and `ownerUserId` sets or
   * clears the owner guard, fields that match are accepted, and anything else is
   * `409 environment_immutable`.
   */
  async put(
    environmentId: string,
    recipe: EnvironmentInput = {},
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

  /**
   * Keeps a version of the Environment's disk (`POST /v1/environments/{id}/snapshot`), between
   * turns; `unchanged` when the disk is as the latest version has it.
   */
  async snapshot(environmentId: string, options: { signal?: AbortSignal } = {}): Promise<EnvironmentSnapshot> {
    await this.transport.requireFeature("environment-disk-versions", options.signal);
    return this.transport.json(`${this.path(environmentId)}/snapshot`, "POST", {}, options.signal);
  }

  /**
   * Puts disk version `version` back: at once for a virtual Environment (`done`), on a new volume
   * seeded before the next turn for a pod (`pending`).
   */
  async restore(
    environmentId: string,
    version: number | "latest",
    options: { signal?: AbortSignal } = {},
  ): Promise<EnvironmentRestore> {
    await this.transport.requireFeature("environment-disk-versions", options.signal);
    return this.transport.json(
      `${this.path(environmentId)}/restore`,
      "POST",
      { requestId: id(), version },
      options.signal,
    );
  }

  /**
   * Forks the Environment into a new one, `options.id` (Q15): how an Environment gets a new
   * manifest version, since none ever changes what it runs. It is made from `options.manifest`
   * (default the source's manifest at its latest version), its disk starts from `options.disk`
   * (`latest`, the default, snapshots first; a version; or `empty`) and the secrets the new
   * manifest declares are copied (`options.secrets: "none"` copies none). The source keeps what
   * it runs, its disk and its sessions. Answers the new Environment and the plan it ran.
   */
  async fork(
    environmentId: string,
    options: Omit<ForkEnvironmentRequest, "requestId" | "dryRun"> & { signal?: AbortSignal },
  ): Promise<{ environment: EnvironmentView; plan: EnvironmentForkPlan }> {
    const { signal, ...body } = options;
    await this.transport.requireFeature("environment-manifests", signal);
    return this.transport.json(`${this.path(environmentId)}/fork`, "POST", { requestId: id(), ...body }, signal);
  }

  /** What `fork` would do (the disk, the secrets copied and left behind, the changes), making nothing. */
  async planFork(
    environmentId: string,
    options: Omit<ForkEnvironmentRequest, "requestId" | "dryRun"> & { signal?: AbortSignal },
  ): Promise<EnvironmentForkPlan> {
    const { signal, ...body } = options;
    await this.transport.requireFeature("environment-manifests", signal);
    const answer = await this.transport.json<{ plan: EnvironmentForkPlan }>(
      `${this.path(environmentId)}/fork`,
      "POST",
      { ...body, dryRun: true },
      signal,
    );
    return answer.plan;
  }

  /** The Environment's disk versions, newest first. */
  async versions(environmentId: string, options: { signal?: AbortSignal } = {}): Promise<EnvironmentVersions> {
    await this.transport.requireFeature("environment-disk-versions", options.signal);
    return this.transport.json(`${this.path(environmentId)}/versions`, "GET", undefined, options.signal);
  }

  /** Deletes disk version `version`; `deleted` is false when there was none. */
  async deleteVersion(
    environmentId: string,
    version: number,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ environmentId: string; version: number; deleted: boolean }> {
    return this.transport.json(
      `${this.path(environmentId)}/versions/${version}`,
      "DELETE",
      undefined,
      options.signal,
    );
  }

  /** Deletes the Environment, its vault and its files; `deleted` is false when there was none. */
  async delete(
    environmentId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<DeleteEnvironmentResponse> {
    return this.transport.json(this.path(environmentId), "DELETE", undefined, options.signal);
  }

  /**
   * The Environment's events, from `from` on: its lifecycle, and `environment.egress` for every
   * connection its sandbox opens (with the turns that were running). `types` keeps only those
   * types; `since` and `until` keep events recorded in that window (ISO times or `Date`s).
   */
  async events(
    environmentId: string,
    options: {
      from?: number;
      types?: readonly EnvironmentEventType[];
      since?: string | Date;
      until?: string | Date;
      signal?: AbortSignal;
    } = {},
  ): Promise<EnvironmentEvent[]> {
    const query = new URLSearchParams();
    if (options.from !== undefined) query.set("from", String(options.from));
    if (options.types !== undefined && options.types.length > 0) query.set("types", options.types.join(","));
    const iso = (at: string | Date) => (at instanceof Date ? at.toISOString() : at);
    if (options.since !== undefined) query.set("since", iso(options.since));
    if (options.until !== undefined) query.set("until", iso(options.until));
    const search = query.toString();
    const reply = await this.transport.json<{ events: EnvironmentEvent[] }>(
      `${this.path(environmentId)}/events${search === "" ? "" : `?${search}`}`,
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
