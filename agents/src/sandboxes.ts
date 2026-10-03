/**
 * Sandboxes as a resource (Host feature `sandboxes`): `client.sandboxes`. A sandbox has its own
 * id and outlives the sessions attached to it; whether it serves one session, one person or a
 * project is the app's choice, made here:
 *
 * - `sandboxes.forSession(...)`: one sandbox for one session. It creates the sandbox, opens the
 *   session attached to it, and `release()` deletes the sandbox when the session is done. It
 *   replaces sharing through another session (`sandbox: { session }`, `sandboxOwnerId`).
 * - `sandboxes.ensure(id, spec)`: one sandbox per person or per project, by a deterministic id
 *   (`user-42`, `team-a/proj-42`); get-or-create in one call. Attach sessions to it with
 *   `createSession({ sandbox: { id } })`.
 *
 * Ids may hold `/`; they are sent percent-encoded as one path segment.
 */
import {
  isSandboxId,
  type DeleteSandboxResponse,
  type PutSandboxRequest,
  type SandboxEvent,
  type SandboxView,
} from "@nylorun/core/contracts";
import { id, segment, type Transport } from "./http.js";
import type { CreateSessionOptions, SessionClient } from "./session-client.js";

const FEATURE = "sandboxes";

/** What a sandbox is made of: fixed once it exists, except its labels. */
export type SandboxSpec = Omit<PutSandboxRequest, "requestId">;

/** A session opened on a sandbox of its own (`sandboxes.forSession`). */
export interface SessionSandboxHandle {
  readonly session: SessionClient;
  readonly sandbox: SandboxView;
  /** Deletes the sandbox and its files; call it when the session is done. */
  release(options?: { signal?: AbortSignal }): Promise<DeleteSandboxResponse>;
}

export interface ForSessionOptions {
  /** The session to open, as `createSession` takes it, without `sandbox`. */
  readonly session: Omit<CreateSessionOptions, "sandbox">;
  /** The sandbox's spec and labels. Default: a virtual sandbox within the Tenant's defaults. */
  readonly spec?: SandboxSpec;
  /** The sandbox's id. Default: `sessions/<session id>`. */
  readonly sandboxId?: string;
  readonly signal?: AbortSignal;
}

export class SandboxesClient {
  constructor(
    private readonly transport: Transport,
    /** `AgentsClient.createSession`, bound. */
    private readonly createSession: (options: CreateSessionOptions) => Promise<SessionClient>,
  ) {}

  private path(sandboxId: string): string {
    if (!isSandboxId(sandboxId))
      throw new TypeError(
        `${sandboxId} is not a sandbox id: up to 200 characters, /-separated segments of letters, digits, '.', '_' and '-'`,
      );
    return `/v1/sandboxes/${segment(sandboxId)}`;
  }

  /**
   * Creates the sandbox, or finds the one with this id (`PUT /v1/sandboxes/{id}`). Its spec is
   * fixed once it exists: a different one is a 409. Labels, when given, replace its labels.
   */
  async ensure(
    sandboxId: string,
    spec: SandboxSpec = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<SandboxView> {
    const path = this.path(sandboxId);
    await this.transport.requireFeature(FEATURE, options.signal);
    return this.transport.json(path, "PUT", { requestId: id(), ...spec }, options.signal);
  }

  async get(sandboxId: string, options: { signal?: AbortSignal } = {}): Promise<SandboxView> {
    const path = this.path(sandboxId);
    await this.transport.requireFeature(FEATURE, options.signal);
    return this.transport.json(path, "GET", undefined, options.signal);
  }

  /** The sandboxes with every label in `labels` that this client reaches. */
  async list(
    options: { labels?: Readonly<Record<string, string>>; signal?: AbortSignal } = {},
  ): Promise<SandboxView[]> {
    await this.transport.requireFeature(FEATURE, options.signal);
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options.labels ?? {}))
      query.append("label", `${key}=${value}`);
    const search = query.toString();
    const reply = await this.transport.json<{ sandboxes: SandboxView[] }>(
      `/v1/sandboxes${search ? `?${search}` : ""}`,
      "GET",
      undefined,
      options.signal,
    );
    return reply.sandboxes;
  }

  /** Deletes the sandbox and its files; `deleted` is false when there was none. */
  async delete(
    sandboxId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<DeleteSandboxResponse> {
    const path = this.path(sandboxId);
    await this.transport.requireFeature(FEATURE, options.signal);
    return this.transport.json(path, "DELETE", undefined, options.signal);
  }

  /** The sandbox's lifecycle events, from `from` on. */
  async events(
    sandboxId: string,
    options: { from?: number; signal?: AbortSignal } = {},
  ): Promise<SandboxEvent[]> {
    const path = this.path(sandboxId);
    await this.transport.requireFeature(FEATURE, options.signal);
    const reply = await this.transport.json<{ events: SandboxEvent[] }>(
      `${path}/events${options.from === undefined ? "" : `?from=${options.from}`}`,
      "GET",
      undefined,
      options.signal,
    );
    return reply.events;
  }

  /**
   * One sandbox for one session: creates the sandbox (`sessions/<session id>` unless
   * `sandboxId` names another), opens the session attached to it, and returns both with
   * `release()`, which deletes the sandbox. If the session cannot be opened, the sandbox is
   * deleted again.
   */
  async forSession(options: ForSessionOptions): Promise<SessionSandboxHandle> {
    const sessionId = options.session.id ?? id();
    const sandboxId =
      options.sandboxId ??
      (isSandboxId(`sessions/${sessionId}`) ? `sessions/${sessionId}` : `sessions/${id()}`);
    const sandbox = await this.ensure(sandboxId, options.spec ?? {}, {
      ...(options.signal ? { signal: options.signal } : {}),
    });
    let session: SessionClient;
    try {
      session = await this.createSession({
        ...options.session,
        id: sessionId,
        sandbox: { id: sandboxId },
      });
    } catch (error) {
      await this.delete(sandboxId).catch(() => undefined);
      throw error;
    }
    return {
      session,
      sandbox,
      release: (release = {}) => this.delete(sandboxId, release),
    };
  }
}
