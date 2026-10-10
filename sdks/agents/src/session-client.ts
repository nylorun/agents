/**
 * The Tenant API client classes, with no Node-only imports. `client.ts` adds `createClient`,
 * which resolves the connection from the environment or the Project link.
 */
import type {
  AgentManifest,
  BuiltAgent,
  BuiltWorkflow,
  JsonValue,
  SandboxToolName,
  SkillFileSource,
  WorkflowManifest,
} from "@nylorun/core/define";
import {
  SANDBOX_TOOL_NAMES,
  codeToolRefusal,
  delegateOf,
  isBuiltWorkflow,
  isSandboxToolName,
} from "@nylorun/core/define";
import { z } from "zod";
import { SCOPES_HEADER, SUBJECT_HEADER } from "@nylorun/core/compatibility";
import {
  SessionManifestViewSchema,
  SessionUsageTotalsSchema,
  ModelCallsPageSchema,
  type SessionItemsResponse,
  type SessionSummary,
  type ListAgentsResponse,
  type ListPublicAgentsResponse,
  parseSessionEvent,
  parseSubjectHeaders,
  type SubjectScope,
  type AcceptedResponse,
  type CredentialSelection,
  type LiveEvent,
  type MessagePart,
  type SandboxRequest,
  type SessionCommand,
} from "@nylorun/core/contracts";
import { SessionsReadClient } from "./reads.js";
import { AccessClient } from "./access.js";
import { SandboxesClient } from "./sandboxes.js";
import { ArtifactsClient } from "./artifacts.js";
import { FilesClient } from "./files.js";
import { Transport, env, id, segment, type Destination } from "./http.js";
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
export interface AgentSource {
  readonly id: string;
  readonly manifest: AgentManifest | WorkflowManifest;
  build?(): BuiltAgent | BuiltWorkflow;
  getBinding?: BuiltAgent["getBinding"] | BuiltWorkflow["getBinding"];
}

const middlewareClosure =
  "Hosted definitions support declarative capabilities, not middleware closures";

/** The agent's declarations, then those of each agent it uses as a tool. */
function declarationsOf(agent: AgentSource) {
  if (isBuiltWorkflow(agent) || (agent.manifest as { kind?: string }).kind === "workflow")
    return [];
  const built = agent.build?.() ?? agent;
  if (isBuiltWorkflow(built)) return [];
  const binding = built.getBinding?.();
  if (!binding || !("declarations" in binding)) return [];
  const found = [...(binding.declarations ?? [])];
  for (const tool of binding.tools ?? []) {
    const delegate = delegateOf(tool);
    found.push(...(delegate?.agent?.getBinding().declarations ?? []));
    // A flow agent used as a tool: its agents' declarations.
    for (const leaf of Object.values(delegate?.workflow?.getBinding().agents ?? {}))
      found.push(...(leaf.declarations ?? []));
  }
  return found;
}

/** The bytes of every skill file the agent's definition names, by `sha256:<hex>`. */
function skillFilesOf(agent: AgentSource, into = new Map<string, SkillFileSource>()) {
  for (const item of declarationsOf(agent))
    for (const [sha256, source] of Object.entries(item.skillFiles ?? {})) into.set(sha256, source);
  return into;
}

/** Closures stay on the live binding. The published manifest cannot name them. */
export function assertNoMiddlewareClosures(agent: AgentSource): void {
  if (declarationsOf(agent).some((item) => item.hasMiddleware))
    throw new Error(middlewareClosure);
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
  id?: string;
  agentId: string;
  ownerUserId: string;
  info?: Record<string, unknown>;
  requestId?: string;
  vaultIds?: readonly string[];
  credentialSelections?: readonly CredentialSelection[];
  /**
   * The session's sandbox: omit for the Tenant default, `false` for none, `{ id }` to attach a
   * sandbox resource (`client.sandboxes`, Host feature `sandboxes`), or an inline sandbox
   * (`image`, `network.allow`, `resources`) checked against the Tenant's limits. `{ session }`
   * shares another session's and is deprecated: use `client.sandboxes.forSession()` or
   * `ensure()` and `{ id }`. Fixed once the session exists.
   */
  sandbox?: SandboxRequest;
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
   * and vaults (Host feature `subject-headers`). For app servers, which authenticate the person
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
   * Sandboxes as a resource (Host feature `sandboxes`): `ensure` one by id, `list` them by
   * label, `delete` one, or give a session its own with `forSession`.
   */
  get sandboxes(): SandboxesClient {
    return new SandboxesClient(this.transport, (options) => this.createSession(options));
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
  listAgents(
    options: { signal?: AbortSignal } = {}
  ): Promise<ListAgentsResponse | { agents: (ListPublicAgentsResponse["agents"][number] & { manifest?: never })[] }> {
    return this.transport.json("/v1/agents", "GET", undefined, options.signal);
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
  /**
   * Registers the agent's definition (`PUT /v1/agents/{id}`), first uploading the skill files
   * it names that the Runtime does not hold. A definition with a tool that runs your code
   * (`tool({ run })`, a flow's tool stage) is refused before anything is sent: the Runtime runs
   * agents from their manifests alone. `implementationVersion` defaults to
   * `NYLORUN_IMPLEMENTATION_VERSION`, else `dev`.
   */
  async saveAgent(
    agent: AgentSource | BuiltWorkflow,
    options: { implementationVersion?: string; requestId?: string } = {}
  ) {
    const files = new Map<string, SkillFileSource>();
    if (isBuiltWorkflow(agent)) {
      // A flow agent embeds its agents: one document, carrying their files.
      for (const binding of Object.values(agent.getBinding().agents)) {
        const leaf = { id: binding.manifest.id, manifest: binding.manifest, getBinding: () => binding };
        assertNoMiddlewareClosures(leaf);
        skillFilesOf(leaf, files);
      }
    } else {
      assertNoMiddlewareClosures(agent);
      skillFilesOf(agent, files);
    }
    const refusal = codeToolRefusal(agent.manifest as AgentManifest | WorkflowManifest);
    if (refusal) throw new Error(refusal);
    await this.files.ensure(files);
    return this.transport.json(`/v1/agents/${segment(agent.id)}`, "PUT", {
      requestId: options.requestId ?? id(),
      manifest: agent.manifest,
      implementationVersion:
        options.implementationVersion ?? env("NYLORUN_IMPLEMENTATION_VERSION") ?? "dev",
    });
  }
  async createSession(options: CreateSessionOptions): Promise<SessionClient> {
    const sessionId = options.id ?? id();
    await this.transport.json(`/v1/sessions/${segment(sessionId)}`, "PUT", {
      requestId: options.requestId ?? id(),
      agentId: options.agentId,
      ownerUserId: options.ownerUserId,
      ...(options.info ? { info: options.info } : {}),
      ...(options.vaultIds ? { vaultIds: options.vaultIds } : {}),
      ...(options.credentialSelections
        ? { credentialSelections: options.credentialSelections }
        : {}),
      ...(options.sandbox === undefined ? {} : { sandbox: options.sandbox }),
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
  command(command: SessionCommand, signal?: AbortSignal) {
    return this.transport.json<AcceptedResponse>(
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
  input(value: string | JsonValue, options: CommandOptions) {
    const base = {
      type: "message" as const,
      requestId: options.requestId ?? id(),
      idempotencyKey: options.idempotencyKey,
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
  inputParts(parts: readonly MessagePart[], options: CommandOptions) {
    return this.command(
      {
        type: "message",
        requestId: options.requestId ?? id(),
        idempotencyKey: options.idempotencyKey,
        parts: [...parts],
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
export { SandboxesClient } from "./sandboxes.js";
export type { ForSessionOptions, SandboxSpec, SessionSandboxHandle } from "./sandboxes.js";
