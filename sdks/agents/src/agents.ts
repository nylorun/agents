/**
 * Agents (protocol 16): `client.agents`. An Agent is the live instance of one version of an agent
 * manifest (`client.agentManifests`): one environment of the manifest's runtime kind (`virtual`,
 * `pod` or `none`), one vault of secrets for its shell, MCP servers and HTTP tools, and the
 * sessions that run on it. It is made only from a saved manifest, `name` (tracking) or `name@n`
 * (pinned), and runs one version of it at a time: `put` with another version moves it, and a save
 * moves every Agent that tracks the manifest (track T3). Its manifest, kind, harness and storage
 * are fixed (`409 agent_fixed_field`): `fork` makes a new Agent to change them. It has
 * its own id and outlives its sessions; whether it serves one person or a project is the app's
 * choice, made by its id:
 *
 * - `agents.put("users/alice/triage", { manifest: "triage", owner: "alice" })`: get-or-create
 *   in one call. Write its secrets with `agents.secrets.put(id, name, { value })` and open
 *   sessions on it with `createSession({ agent: id, ... })`. Creating it opens no session (D71).
 *
 * Ids may hold `/`; they are sent percent-encoded as one path segment. Secret values are
 * write-only: no call reads one back.
 *
 * Triggers (track T4, D74): what its manifest's `runtime.triggers` declares starts its turns with
 * no client connected. `triggers(id)` lists them with their status and next run, `pauseTrigger`,
 * `resumeTrigger` and `runTrigger` change or run one, `rotateWebhookSecret` makes a webhook
 * trigger's signing secret (D75), and `runs(id)` pages what each fire came to.
 *
 * Disk versions (Host feature `environment-disk-versions`): `snapshot(id)` keeps a version of
 * the Agent's disk between turns, `restore(id, version)` puts one back, and
 * `put(id, { manifest, from: { agent, version } })` creates a new Agent from another's version.
 */
import {
  AgentPageSchema,
  isAgentId,
  type AgentDiskVersions,
  type AgentEvent,
  type AgentEventType,
  type AgentForkPlan,
  type AgentMovePlan,
  type AgentRestore,
  type AgentSecretView,
  type AgentSnapshot,
  type AgentView,
  type DeleteAgentResponse,
  type ForkAgentRequest,
  type PutAgentRequest,
  type PutAgentSecretRequest,
  type TriggerRun,
  type TriggerRunPage,
  type TriggerView,
} from "@nylorun/core/contracts";
import { definitionFileHash } from "./files.js";
import { id, segment, type Transport } from "./http.js";

/** What an Agent is made from (`manifest: "name"` or `"name@n"`), and its owner guard, labels and `from`. */
export type AgentInput = Omit<PutAgentRequest, "requestId">;
/**
 * One secret of an Agent's vault, as written: typed, or only its value (`{ value }`, or
 * `{ headers }` for a `headers` secret) when its manifest declares the slot (D64).
 */
export type AgentSecretInput =
  | PutAgentSecretRequest
  | { readonly value: string }
  | { readonly headers: Readonly<Record<string, string>> };
/** Which Agents a `list` or `page` answers: those with every label, and the state or manifest given. */
export interface AgentFilter {
  readonly labels?: Readonly<Record<string, string>>;
  /** `working`, `sleeping`, `input_required`, `failing` or `paused`. */
  readonly state?: string;
  /** The agent manifest's name. */
  readonly manifest?: string;
  /** `true`: only Agents moving to another version of their manifest (track T3); `false`: the others. */
  readonly outdated?: boolean;
}

/** The bytes of files by hash, by `sha256:<hex>` (`runtimeFiles(...).bytes`). */
export type RuntimeFileBytes = Readonly<Record<string, Uint8Array>>;

/**
 * A runtime section's `files` entry by content hash (Q6): `contents` (each file's path under
 * `path` and its bytes or text) hashed, as `entry` for the manifest's `runtime.files` and `bytes`
 * for `agentManifests.save`'s `files`, which uploads them. Each file holds at most 2 GiB.
 */
export async function runtimeFiles(
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

function filterQuery(filter: AgentFilter, query = new URLSearchParams()): URLSearchParams {
  for (const [key, value] of Object.entries(filter.labels ?? {})) query.append("label", `${key}=${value}`);
  if (filter.state !== undefined) query.set("state", filter.state);
  if (filter.manifest !== undefined) query.set("manifest", filter.manifest);
  if (filter.outdated !== undefined) query.set("outdated", String(filter.outdated));
  return query;
}

/** An Agent's secrets: `client.agents.secrets`. */
export class AgentSecretsClient {
  constructor(
    private readonly transport: Transport,
    private readonly path: (agentId: string) => string,
  ) {}

  /**
   * Creates or replaces secret `name` (`PUT /v1/agents/{id}/secrets/{name}`): for
   * `environment_secret` and `environment_variable` the name is the variable's. A second
   * credential for a host or a URL is a 409 `credential_conflict`. When the Agent's manifest
   * declares the secret's slot (D64), send only `{ value }` (or `{ headers }`); a name it does
   * not declare is `409 secret_not_in_manifest`.
   */
  async put(
    agentId: string,
    name: string,
    secret: AgentSecretInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<AgentSecretView> {
    return this.transport.json(
      `${this.path(agentId)}/secrets/${segment(name)}`,
      "PUT",
      { requestId: id(), ...secret },
      options.signal,
    );
  }

  /** The secrets' names, types and bindings; never a value. */
  async list(agentId: string, options: { signal?: AbortSignal } = {}): Promise<AgentSecretView[]> {
    const reply = await this.transport.json<{ secrets: AgentSecretView[] }>(
      `${this.path(agentId)}/secrets`,
      "GET",
      undefined,
      options.signal,
    );
    return reply.secrets;
  }

  async get(agentId: string, name: string, options: { signal?: AbortSignal } = {}): Promise<AgentSecretView> {
    return this.transport.json(`${this.path(agentId)}/secrets/${segment(name)}`, "GET", undefined, options.signal);
  }

  async delete(agentId: string, name: string, options: { signal?: AbortSignal } = {}): Promise<{ id: string }> {
    return this.transport.json(`${this.path(agentId)}/secrets/${segment(name)}`, "DELETE", undefined, options.signal);
  }
}

/** The Tenant's Agents: `client.agents`. */
export class AgentInstancesClient {
  constructor(private readonly transport: Transport) {}

  private path(agentId: string): string {
    if (!isAgentId(agentId))
      throw new TypeError(
        `${agentId} is not an Agent id: up to 200 characters, /-separated segments of letters, digits, '.', '_' and '-'`,
      );
    return `/v1/agents/${segment(agentId)}`;
  }

  /** The Agent's secrets. */
  get secrets(): AgentSecretsClient {
    return new AgentSecretsClient(this.transport, (agentId) => this.path(agentId));
  }

  /**
   * Creates the Agent, its vault and its compute from a saved agent manifest, or finds the one
   * with this id (`PUT /v1/agents/{id}`): `{ manifest: "name" }` tracks the manifest (its latest
   * version when the Agent is made), `"name@n"` pins version n. On an existing Agent, labels
   * replace, `owner` sets or clears the owner guard, and `manifest` moves it to that version of
   * its manifest (track T3): at once, at its pod's next start for a runtime change (`targetVersion`,
   * `waitingFor: "start"`), or once a required secret the version adds is set. Another manifest,
   * kind, harness or storage is `409 agent_fixed_field` (fork it instead).
   */
  async put(agentId: string, input: AgentInput, options: { signal?: AbortSignal } = {}): Promise<AgentView> {
    return this.transport.json(this.path(agentId), "PUT", { requestId: id(), ...input }, options.signal);
  }

  /**
   * What `put` would do to the existing Agent (`PUT /v1/agents/{id}?dryRun=true`, track T3): the
   * version it runs and the one `input.manifest` names, when that applies (`now`, `next_start`,
   * `secrets`, or `refused` with each fixed field), the changes, and the secrets it would wait
   * for or leave unused. Nothing changes.
   */
  async plan(agentId: string, input: AgentInput, options: { signal?: AbortSignal } = {}): Promise<AgentMovePlan> {
    const reply = await this.transport.json<{ plan: AgentMovePlan }>(
      `${this.path(agentId)}?dryRun=true`,
      "PUT",
      { requestId: id(), ...input },
      options.signal,
    );
    return reply.plan;
  }

  async get(agentId: string, options: { signal?: AbortSignal } = {}): Promise<AgentView> {
    return this.transport.json(this.path(agentId), "GET", undefined, options.signal);
  }

  /** The Agents this client reaches with every label in `labels`, and the `state` or `manifest` given. */
  async list(options: AgentFilter & { signal?: AbortSignal } = {}): Promise<AgentView[]> {
    const search = filterQuery(options).toString();
    const reply = await this.transport.json<{ agents: AgentView[] }>(
      `/v1/agents${search ? `?${search}` : ""}`,
      "GET",
      undefined,
      options.signal,
    );
    return reply.agents;
  }

  /** One page of `list` (Host feature `session-reads`). */
  async page(options: AgentFilter & { limit?: number; cursor?: string; signal?: AbortSignal } = {}) {
    await this.transport.requireFeature("session-reads", options.signal);
    const query = new URLSearchParams({ limit: String(options.limit ?? 50) });
    if (options.cursor !== undefined) query.set("cursor", options.cursor);
    filterQuery(options, query);
    return AgentPageSchema.parse(await this.transport.json(`/v1/agents?${query}`, "GET", undefined, options.signal));
  }

  /** Stops a pod Agent's compute: its volume is kept, and the next turn starts it again. */
  async stop(agentId: string, options: { signal?: AbortSignal } = {}): Promise<AgentView> {
    return this.transport.json(`${this.path(agentId)}/stop`, "POST", {}, options.signal);
  }

  /**
   * Applies a version the Agent waits to apply (`POST /v1/agents/{id}/restart`, track T3): a
   * running pod stops, so the next turn starts it on the version; a stopped one starts at once.
   * `retry` first moves it to the version that failed to start again. Refused during a turn.
   */
  async restart(agentId: string, options: { retry?: boolean; signal?: AbortSignal } = {}): Promise<AgentView> {
    return this.transport.json(
      `${this.path(agentId)}/restart`,
      "POST",
      { requestId: id(), ...(options.retry ? { retry: true } : {}) },
      options.signal,
    );
  }

  /** Resets a pod Agent: a new pod on a new, empty volume, with its runtime section applied. */
  async reset(agentId: string, options: { signal?: AbortSignal } = {}): Promise<AgentView> {
    return this.transport.json(`${this.path(agentId)}/reset`, "POST", {}, options.signal);
  }

  /**
   * Keeps a version of the Agent's disk (`POST /v1/agents/{id}/snapshot`), between turns;
   * `unchanged` when the disk is as the latest version has it.
   */
  async snapshot(agentId: string, options: { signal?: AbortSignal } = {}): Promise<AgentSnapshot> {
    await this.transport.requireFeature("environment-disk-versions", options.signal);
    return this.transport.json(`${this.path(agentId)}/snapshot`, "POST", {}, options.signal);
  }

  /**
   * Puts disk version `version` back: at once for a virtual Agent (`done`), on a new volume
   * seeded before the next turn for a pod (`pending`).
   */
  async restore(
    agentId: string,
    version: number | "latest",
    options: { signal?: AbortSignal } = {},
  ): Promise<AgentRestore> {
    await this.transport.requireFeature("environment-disk-versions", options.signal);
    return this.transport.json(`${this.path(agentId)}/restore`, "POST", { requestId: id(), version }, options.signal);
  }

  /**
   * Forks the Agent into a new one, `options.id` (Q15): how an Agent changes what is fixed for its
   * life (its manifest, kind, harness or storage). It is made from `options.manifest` (default the source's manifest,
   * tracking), its disk starts from `options.disk` (`latest`, the default, snapshots first; a
   * version; or `empty`) and the secrets the new manifest declares are copied
   * (`options.secrets: "none"` copies none). The source keeps what it runs, its disk and its
   * sessions. Answers the new Agent and the plan it ran.
   */
  async fork(
    agentId: string,
    options: Omit<ForkAgentRequest, "requestId" | "dryRun"> & { signal?: AbortSignal },
  ): Promise<{ agent: AgentView; plan: AgentForkPlan }> {
    const { signal, ...body } = options;
    return this.transport.json(`${this.path(agentId)}/fork`, "POST", { requestId: id(), ...body }, signal);
  }

  /** What `fork` would do (the disk, the secrets copied and left behind, the changes), making nothing. */
  async planFork(
    agentId: string,
    options: Omit<ForkAgentRequest, "requestId" | "dryRun"> & { signal?: AbortSignal },
  ): Promise<AgentForkPlan> {
    const { signal, ...body } = options;
    const answer = await this.transport.json<{ plan: AgentForkPlan }>(
      `${this.path(agentId)}/fork`,
      "POST",
      { ...body, dryRun: true },
      signal,
    );
    return answer.plan;
  }

  /** The Agent's disk versions, newest first. */
  async versions(agentId: string, options: { signal?: AbortSignal } = {}): Promise<AgentDiskVersions> {
    await this.transport.requireFeature("environment-disk-versions", options.signal);
    return this.transport.json(`${this.path(agentId)}/versions`, "GET", undefined, options.signal);
  }

  /** Deletes disk version `version`; `deleted` is false when there was none. */
  async deleteVersion(
    agentId: string,
    version: number,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ agentId: string; version: number; deleted: boolean }> {
    return this.transport.json(`${this.path(agentId)}/versions/${version}`, "DELETE", undefined, options.signal);
  }

  /** Deletes the Agent, its vault and its files; `deleted` is false when there was none. */
  async delete(agentId: string, options: { signal?: AbortSignal } = {}): Promise<DeleteAgentResponse> {
    return this.transport.json(this.path(agentId), "DELETE", undefined, options.signal);
  }

  /**
   * The Agent's events, from `from` on: its lifecycle, and `agent.egress` for every connection
   * its sandbox opens (with the turns that were running). `types` keeps only those types;
   * `since` and `until` keep events recorded in that window (ISO times or `Date`s).
   */
  async events(
    agentId: string,
    options: {
      from?: number;
      types?: readonly AgentEventType[];
      since?: string | Date;
      until?: string | Date;
      signal?: AbortSignal;
    } = {},
  ): Promise<AgentEvent[]> {
    const query = new URLSearchParams();
    if (options.from !== undefined) query.set("from", String(options.from));
    if (options.types !== undefined && options.types.length > 0) query.set("types", options.types.join(","));
    const iso = (at: string | Date) => (at instanceof Date ? at.toISOString() : at);
    if (options.since !== undefined) query.set("since", iso(options.since));
    if (options.until !== undefined) query.set("until", iso(options.until));
    const search = query.toString();
    const reply = await this.transport.json<{ events: AgentEvent[] }>(
      `${this.path(agentId)}/events${search === "" ? "" : `?${search}`}`,
      "GET",
      undefined,
      options.signal,
    );
    return reply.events;
  }

  /** The Agent's triggers: each one's status (`active`, `paused`, `completed`), next and last run. */
  async triggers(agentId: string, options: { signal?: AbortSignal } = {}): Promise<TriggerView[]> {
    const reply = await this.transport.json<{ triggers: TriggerView[] }>(`${this.path(agentId)}/triggers`, "GET", undefined, options.signal);
    return reply.triggers;
  }

  /** Pauses trigger `triggerId`: it stops firing until it is resumed. Answers the Agent's triggers. */
  async pauseTrigger(agentId: string, triggerId: string, options: { signal?: AbortSignal } = {}): Promise<TriggerView[]> {
    const reply = await this.transport.json<{ triggers: TriggerView[] }>(
      `${this.path(agentId)}/triggers/${segment(triggerId)}/pause`,
      "POST",
      {},
      options.signal,
    );
    return reply.triggers;
  }

  /** Resumes trigger `triggerId` from its next time after now. Answers the Agent's triggers. */
  async resumeTrigger(agentId: string, triggerId: string, options: { signal?: AbortSignal } = {}): Promise<TriggerView[]> {
    const reply = await this.transport.json<{ triggers: TriggerView[] }>(
      `${this.path(agentId)}/triggers/${segment(triggerId)}/resume`,
      "POST",
      {},
      options.signal,
    );
    return reply.triggers;
  }

  /**
   * Runs trigger `triggerId` once now, as if it fired: `idempotencyKey` (default a new one) makes a
   * retried call answer the same run.
   */
  async runTrigger(
    agentId: string,
    triggerId: string,
    options: { idempotencyKey?: string; signal?: AbortSignal } = {},
  ): Promise<TriggerRun> {
    const response = await this.transport.request(`${this.path(agentId)}/triggers/${segment(triggerId)}/run`, {
      method: "POST",
      headers: { "idempotency-key": options.idempotencyKey ?? id() },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return ((await response.json()) as { run: TriggerRun }).run;
  }

  /**
   * A new Standard Webhooks signing secret for webhook trigger `triggerId` (`whsec_…`), shown this
   * once with the trigger's `webhookUrl`; the one before stops working at once.
   */
  async rotateWebhookSecret(
    agentId: string,
    triggerId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ triggerId: string; webhookUrl: string; secret: string }> {
    return this.transport.json(`${this.path(agentId)}/triggers/${segment(triggerId)}/secret`, "POST", {}, options.signal);
  }

  /** The Agent's runs, newest first; `triggerId` keeps one trigger's. */
  async runs(
    agentId: string,
    options: { triggerId?: string; limit?: number; cursor?: string; signal?: AbortSignal } = {},
  ): Promise<TriggerRunPage> {
    const query = new URLSearchParams({ limit: String(options.limit ?? 50) });
    if (options.triggerId !== undefined) query.set("triggerId", options.triggerId);
    if (options.cursor !== undefined) query.set("cursor", options.cursor);
    return this.transport.json(`${this.path(agentId)}/runs?${query}`, "GET", undefined, options.signal);
  }
}
