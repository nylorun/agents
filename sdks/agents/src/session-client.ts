/**
 * The Runtime API client classes, with no Node-only imports. `client.ts` adds `createClient`,
 * which resolves the connection from the environment or the Project link.
 */
import type { JsonValue, SandboxToolName } from "@nylorun/core/define";
import { SANDBOX_TOOL_NAMES, isSandboxToolName } from "@nylorun/core/define";
import { z } from "zod";
import { SCOPES_HEADER, SUBJECT_HEADER } from "@nylorun/core/compatibility";
import {
  SessionManifestViewSchema,
  SessionUsageTotalsSchema,
  ModelCallsPageSchema,
  ToolCallsPageSchema,
  TurnTraceSchema,
  type SessionItemsResponse,
  type SessionSummary,
  parseSessionEvent,
  parseSubjectHeaders,
  type SubjectScope,
  type CommandResponse,
  type MessageDelivery,
  type LiveEvent,
  type MessagePart,
  type SessionCommand,
} from "@nylorun/core/contracts";
import { SessionsReadClient } from "./reads.js";
import { AccessClient } from "./access.js";
import { AgentInstancesClient } from "./agents.js";
import { AgentManifestsClient, type AgentSource } from "./agent-manifests.js";
import { ArtifactsClient } from "./artifacts.js";
import { FilesClient } from "./files.js";
import { Transport, id, segment, type Destination } from "./http.js";
import { observeSSE } from "./sse.js";

/** Application-principal access to a session's sandbox built-ins (workflows.md §8). */
export type SessionSandbox = {
  readonly [K in SandboxToolName]: (
    args: Record<string, unknown>,
  ) => Promise<unknown>;
};

function sessionSandboxOf(transport: Transport, sessionId: string): SessionSandbox {
  const call = (tool: SandboxToolName, args: Record<string, unknown>) =>
    transport.json(
      `/v1/sessions/${segment(sessionId)}/sandbox/${segment(tool)}`,
      "POST",
      args,
    );
  const sandbox = {} as Record<SandboxToolName, SessionSandbox[SandboxToolName]>;
  for (const tool of SANDBOX_TOOL_NAMES) {
    if (!isSandboxToolName(tool)) continue;
    sandbox[tool] = (args) => call(tool, args);
  }
  return sandbox as SessionSandbox;
}

function linkedSessionId(event: LiveEvent): string | undefined {
  if (event.type !== "node.agent") return undefined;
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return undefined;
  const sessionId = (payload as { sessionId?: unknown }).sessionId;
  return typeof sessionId === "string" && sessionId.length > 0
    ? sessionId
    : undefined;
}
export interface SessionView {
  id: string;
  agentId: string;
  ownerUserId: string;
  status: string;
  activeTurnId: string | null;
  waits?: unknown;
  [key: string]: unknown;
}
/** `AgentsClient.createSession`'s options. */
export interface CreateSessionOptions {
  /** The session's id, which the app chooses (D71). Default: a new UUID. */
  id?: string;
  /**
   * The Agent the session runs on (`client.agents`): its manifest version, its sandbox and its
   * vault's credentials. Fixed once the session exists.
   */
  agent: string;
  ownerUserId: string;
  info?: Record<string, unknown>;
  requestId?: string;
}
export interface ActAsOptions {
  /** What the subject may do; the Runtime grants nothing else. Default `["sessions:own"]`. */
  scopes?: readonly SubjectScope[];
}

export class AgentsClient {
  readonly transport: Transport;
  /** The subject this client acts for (`as`), or `undefined` for the principal itself. */
  readonly subject: string | undefined;
  constructor(destination: Destination = {}) {
    this.transport = new Transport(destination);
    this.subject = undefined;
  }
  /**
   * A client that acts for `subject`: every call sends `Nylorun-Subject` and
   * `Nylorun-Scopes`, and the Runtime limits it to the scopes and to the subject's own sessions
   * (Host feature `subject-headers`). For app servers, which authenticate the person
   * themselves and hold the key; nothing is minted, cached or refreshed.
   */
  as(subject: string, options: ActAsOptions = {}): AgentsClient {
    if (this.subject !== undefined)
      throw new Error(`This client already acts for ${this.subject}`);
    const scopes = [...(options.scopes ?? ["sessions:own"])].join(" ");
    const parsed = parseSubjectHeaders(subject, scopes);
    if (!parsed.ok) throw new TypeError(parsed.message);
    const client = Object.create(AgentsClient.prototype) as AgentsClient;
    return Object.assign(client, {
      transport: this.transport.withHeaders({
        [SUBJECT_HEADER]: subject,
        [SCOPES_HEADER]: [...parsed.scopes].join(" "),
      }),
      subject,
    });
  }
  /** The public keys that verify the tokens the Tenant signs. */
  get access(): AccessClient {
    return new AccessClient(this.transport);
  }
  /**
   * Agent manifests (protocol 16): `save` a manifest's next version (a v8 document, what
   * `composeManifest` read, or a built agent with its runtime section), `plan` a save, read
   * their versions.
   */
  get agentManifests(): AgentManifestsClient {
    return new AgentManifestsClient(this.transport);
  }
  /**
   * Agents (protocol 16): `put` one by id from a saved manifest (create or find), write its
   * `secrets`, `list` them, `stop`, `reset`, `fork` or `delete` one. Sessions run on them.
   */
  get agents(): AgentInstancesClient {
    return new AgentInstancesClient(this.transport);
  }
  /** File artifacts: upload, list, download with Range, capability links (protocol 6). */
  get artifacts(): ArtifactsClient {
    return new ArtifactsClient(this.transport);
  }
  /** Definition files: the skill files a definition names, by content hash. */
  get files(): FilesClient {
    return new FilesClient(this.transport);
  }
  /** The Runtime's protocol features, including optional ones such as `transcript-events`. */
  hostFeatures(options: { signal?: AbortSignal } = {}): Promise<readonly string[]> {
    return this.transport.hostFeatures(options.signal);
  }
  get sessions(): SessionsReadClient {
    return new SessionsReadClient(this.transport);
  }
  listSessions(
    options: { agentId?: string; signal?: AbortSignal } = {}
  ): Promise<{ sessions: SessionSummary[] }> {
    const query = options.agentId
      ? `?agentId=${encodeURIComponent(options.agentId)}`
      : "";
    return this.transport.json(
      `/v1/sessions${query}`,
      "GET",
      undefined,
      options.signal
    );
  }
  async createSession(options: CreateSessionOptions): Promise<SessionClient> {
    const sessionId = options.id ?? id();
    await this.transport.json(`/v1/sessions/${segment(sessionId)}`, "PUT", {
      requestId: options.requestId ?? id(),
      agent: options.agent,
      ownerUserId: options.ownerUserId,
      ...(options.info ? { info: options.info } : {}),
    });
    return this.session(sessionId);
  }
  session(sessionId: string): SessionClient {
    return new SessionClient(this.transport, sessionId);
  }
}
export type CommandOptions = {
  idempotencyKey: string;
  requestId?: string;
  signal?: AbortSignal;
};
/**
 * A message's options. `delivery` says what a message to a busy session does (protocol 17):
 * `queue` (the default) waits for the running turn to end, `reject` is refused with
 * `409 session_busy`.
 */
export type MessageOptions = CommandOptions & { delivery?: MessageDelivery };
export class SessionClient {
  readonly sandbox: SessionSandbox;
  constructor(private readonly transport: Transport, readonly id: string) {
    this.sandbox = sessionSandboxOf(transport, id);
  }
  private get path() {
    return `/v1/sessions/${segment(this.id)}`;
  }
  inspect(signal?: AbortSignal) {
    return this.transport.json<SessionView>(
      this.path,
      "GET",
      undefined,
      signal
    );
  }
  /** Pending waits / interactions from the session inspect view. */
  async pending(signal?: AbortSignal) {
    const view = await this.inspect(signal);
    return view.waits ?? [];
  }
  /** A message answers `queued` when it waits for the running turn (protocol 17). */
  command(command: SessionCommand, signal?: AbortSignal) {
    return this.transport.json<CommandResponse>(
      `${this.path}/commands`,
      "POST",
      command,
      signal
    );
  }
  /**
   * Start a turn. Strings become `message.content`; any other JSON value becomes
   * `message.data` (workflows.md §5).
   */
  input(value: string | JsonValue, options: MessageOptions) {
    const base = {
      type: "message" as const,
      requestId: options.requestId ?? id(),
      idempotencyKey: options.idempotencyKey,
      ...(options.delivery ? { delivery: options.delivery } : {}),
    };
    return this.command(
      typeof value === "string"
        ? { ...base, content: value }
        : { ...base, data: value },
      options.signal
    );
  }
  /**
   * Start a turn with text and file parts (protocol 6): a file part names an artifact (upload
   * it with `client.artifacts.upload`), at a version or its latest, and the model reads it, an
   * image as an image and a text file as text.
   */
  inputParts(parts: readonly MessagePart[], options: MessageOptions) {
    return this.command(
      {
        type: "message",
        requestId: options.requestId ?? id(),
        idempotencyKey: options.idempotencyKey,
        parts: [...parts],
        ...(options.delivery ? { delivery: options.delivery } : {}),
      },
      options.signal
    );
  }
  approve(interactionId: string, approved: boolean, options: CommandOptions) {
    return this.command(
      {
        type: "approve",
        interactionId,
        approved,
        requestId: options.requestId ?? id(),
        idempotencyKey: options.idempotencyKey,
      },
      options.signal
    );
  }
  respond(interactionId: string, value: JsonValue, options: CommandOptions) {
    return this.command(
      {
        type: "respond",
        interactionId,
        value,
        requestId: options.requestId ?? id(),
        idempotencyKey: options.idempotencyKey,
      },
      options.signal
    );
  }
  cancel(options: CommandOptions & { reason?: string }) {
    return this.command(
      {
        type: "cancel",
        requestId: options.requestId ?? id(),
        idempotencyKey: options.idempotencyKey,
        ...(options.reason ? { reason: options.reason } : {}),
      },
      options.signal
    );
  }
  async manifest(options: { signal?: AbortSignal } = {}) {
    await this.transport.requireFeature("session-reads", options.signal);
    return SessionManifestViewSchema.parse(
      await this.transport.json(`${this.path}/manifest`, "GET", undefined, options.signal),
    );
  }
  async usage(options: { turnId?: string; signal?: AbortSignal } = {}) {
    await this.transport.requireFeature("session-reads", options.signal);
    const query = new URLSearchParams();
    if (options.turnId !== undefined) query.set("turnId", options.turnId);
    return SessionUsageTotalsSchema.parse(
      await this.transport.json(
        `${this.path}/usage${query.size ? `?${query}` : ""}`,
        "GET",
        undefined,
        options.signal,
      ),
    );
  }
  async modelCalls(
    options: { turnId?: string; limit?: number; cursor?: string; signal?: AbortSignal } = {},
  ) {
    await this.transport.requireFeature("session-reads", options.signal);
    const query = new URLSearchParams({ limit: String(options.limit ?? 50) });
    if (options.turnId !== undefined) query.set("turnId", options.turnId);
    if (options.cursor !== undefined) query.set("cursor", options.cursor);
    return ModelCallsPageSchema.parse(
      await this.transport.json(
        `${this.path}/calls/model?${query}`,
        "GET",
        undefined,
        options.signal,
      ),
    );
  }
  /**
   * The session's tool calls (R5, Host feature `tool-calls`), in the order they were first sent:
   * each one's tool, input, status and sends. `attempts` above 1: a crash re-sent it.
   */
  async toolCalls(
    options: { turnId?: string; limit?: number; cursor?: string; signal?: AbortSignal } = {},
  ) {
    await this.transport.requireFeature("tool-calls", options.signal);
    const query = new URLSearchParams({ limit: String(options.limit ?? 50) });
    if (options.turnId !== undefined) query.set("turnId", options.turnId);
    if (options.cursor !== undefined) query.set("cursor", options.cursor);
    return ToolCallsPageSchema.parse(
      await this.transport.json(`${this.path}/calls/tool?${query}`, "GET", undefined, options.signal),
    );
  }
  /**
   * A turn's trace (R7, Host feature `traces`): its spans as OTLP/HTTP JSON (`resourceSpans`), as
   * the Runtime posts them to an OTLP collector. Post it to a collector's `/v1/traces` to backfill
   * one, or read it without one.
   */
  async trace(turnId: string, options: { signal?: AbortSignal } = {}) {
    await this.transport.requireFeature("traces", options.signal);
    return TurnTraceSchema.parse(
      await this.transport.json(
        `${this.path}/turns/${encodeURIComponent(turnId)}/trace`,
        "GET",
        undefined,
        options.signal,
      ),
    );
  }
  /** `agent` narrows to one agent used as a tool: its delegationId or its path. */
  history(options: {
    cursor?: string;
    agent?: string;
    signal?: AbortSignal;
    limit: number;
  }): Promise<SessionItemsResponse & { tail: boolean }>;
  history(options?: {
    cursor?: string;
    agent?: string;
    signal?: AbortSignal;
  }): Promise<SessionItemsResponse>;
  async history(
    options: { cursor?: string; agent?: string; signal?: AbortSignal; limit?: number } = {},
  ) {
    const query = new URLSearchParams();
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.agent) query.set("agent", options.agent);
    if (options.limit !== undefined) {
      await this.transport.requireFeature("session-reads", options.signal);
      query.set("limit", String(options.limit));
    }
    const search = query.toString();
    const schema = z.object({ items: z.array(z.unknown()), cursor: z.string().nullable() });
    const page = (
      options.limit === undefined ? schema : schema.extend({ tail: z.boolean() })
    ).parse(
      await this.transport.json(
        `${this.path}/items${search ? `?${search}` : ""}`,
        "GET",
        undefined,
        options.signal,
      ),
    );
    // Typed when the catalog knows the type; a newer Runtime's type stays a bare envelope.
    return {
      items: page.items.map(parseSessionEvent),
      cursor: page.cursor,
      ...("tail" in page ? { tail: page.tail } : {}),
    };
  }
  async *observe(
    options: { cursor?: string; signal?: AbortSignal; follow?: boolean } = {},
  ) {
    if (!options.follow) {
      yield* this.observeOne(this.id, options);
      return;
    }
    yield* this.observeFollowing(options);
  }

  private async *observeOne(
    sessionId: string,
    options: { cursor?: string; signal?: AbortSignal },
  ) {
    for await (const frame of observeSSE(
      this.transport,
      `/v1/sessions/${segment(sessionId)}/events`,
      options,
    )) {
      if (frame.event === "heartbeat" || frame.event === "ready") continue;
      yield parseSessionEvent(JSON.parse(frame.data));
    }
  }

  /**
   * Own session stream plus linked agent sessions announced in `node.agent`
   * events, merged by `time` then arrival order (workflows.md §11).
   */
  private async *observeFollowing(options: {
    cursor?: string;
    signal?: AbortSignal;
  }) {
    const signal = options.signal;
    const linked = new Set<string>();
    const queue: LiveEvent[] = [];
    let wait: (() => void) | undefined;
    let open = 1;
    let failed: unknown;

    const wake = () => {
      wait?.();
      wait = undefined;
    };
    const push = (event: LiveEvent) => {
      queue.push(event);
      queue.sort((a, b) => {
        const byTime = a.time.localeCompare(b.time);
        return byTime !== 0 ? byTime : a.cursor.localeCompare(b.cursor);
      });
      wake();
    };
    const pump = async (
      sessionId: string,
      cursor?: string,
    ): Promise<void> => {
      try {
        for await (const event of this.observeOne(sessionId, { cursor, signal })) {
          push(event);
          const link = linkedSessionId(event);
          if (link && link !== this.id && !linked.has(link)) {
            linked.add(link);
            open += 1;
            void pump(link).finally(() => {
              open -= 1;
              wake();
            });
          }
        }
      } catch (error) {
        if (!signal?.aborted) failed = error;
      }
    };

    void pump(this.id, options.cursor).finally(() => {
      open -= 1;
      wake();
    });

    while (!signal?.aborted) {
      if (failed) throw failed;
      if (queue.length) {
        yield queue.shift()!;
        continue;
      }
      if (open <= 0) return;
      await new Promise<void>((resolve) => {
        wait = resolve;
      });
    }
  }
}

export { RuntimeError, IncompatibleRuntimeError } from "./http.js";
export type { Destination, IncompatibleReason } from "./http.js";
export type { LiveEvent } from "@nylorun/core/contracts";
export { AccessClient } from "./access.js";
export { AgentInstancesClient, AgentMemoriesClient, AgentSecretsClient, runtimeFiles } from "./agents.js";
export type { AgentFilter, AgentInput, AgentSecretInput, RuntimeFileBytes } from "./agents.js";
export { AgentManifestsClient, ManifestGapsError, agentManifest, requirementGaps } from "./agent-manifests.js";
export type {
  AgentManifestDocument,
  AgentManifestFromAgent,
  AgentManifestInput,
  AgentManifestSaveOptions,
  AgentSource,
  ComposedManifest,
  DefinitionFiles,
} from "./agent-manifests.js";
