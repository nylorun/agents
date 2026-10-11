/**
 * The suite's only way into the Runtime: its public Runtime API with an application key, and its
 * Management API with a management key, over `fetch`. Nothing here knows the Runtime's code.
 */

/** An event of a session's record, as `GET /v1/sessions/{id}/items` serves it. */
export interface RecordEvent {
  readonly type: string;
  readonly seq: number;
  readonly turnId: string | null;
  readonly runId?: string | null;
  readonly source?: { readonly kind: string; readonly id?: string };
  readonly evidence?: string;
  readonly principal?: { readonly kind: string; readonly id: string };
  readonly time?: string;
  readonly payload: any;
}

/** A metered model call (`GET /v1/sessions/{id}/calls/model`). */
export interface ModelCallRow {
  readonly effectId?: string;
  readonly turnId: string;
  readonly provider: string;
  readonly outcome?: string;
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
}

/** A journaled tool call (`GET /v1/sessions/{id}/calls/tool`). */
export interface ToolCallRow {
  readonly effectId: string;
  readonly turnId: string;
  readonly callId?: string;
  readonly toolName?: string;
  readonly kind?: string;
  readonly status: string;
  readonly attempts?: number;
  readonly error?: { readonly code: string; readonly message: string } | null;
}

/** `GET /v1/sessions/{id}`, the fields the suite reads. */
export interface SessionView {
  readonly id: string;
  readonly status: string;
  readonly activeTurnId: string | null;
  readonly harness?: string;
  readonly mcpSnapshot?: unknown;
  readonly uncertainEffects?: readonly unknown[];
}

export interface Answer<T = any> {
  readonly status: number;
  readonly body: T;
}

export interface ClientOptions {
  /** The Runtime's base URL, e.g. `http://127.0.0.1:4000`. */
  readonly runtime: string;
  /** An application key: the Runtime API. */
  readonly key: string;
  /** A management key: the Management API (`/v1/tenant/*`). */
  readonly manageKey: string;
  readonly fetch?: typeof fetch;
}

/** A refusal from the Runtime, with what it answered. */
export class RuntimeError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`${method} ${path} answered ${status}: ${JSON.stringify(body)?.slice(0, 300)}`);
  }
}

export class RuntimeClient {
  private readonly base: string;
  private readonly fetch: typeof fetch;
  private protocol: string | undefined;

  constructor(private readonly options: ClientOptions) {
    this.base = options.runtime.replace(/\/+$/, "");
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  /**
   * The Runtime's protocol, from `/health`: every Runtime API request names it (`Nylorun-Protocol`).
   * The suite speaks what the Runtime speaks newest.
   */
  async health(): Promise<{ protocol: number; body: any }> {
    const response = await this.fetch(`${this.base}/health`);
    const body = (await response.json().catch(() => ({}))) as any;
    if (!response.ok) throw new RuntimeError("GET", "/health", response.status, body);
    const protocol = Number(body?.protocol?.max ?? body?.protocol);
    if (!Number.isInteger(protocol)) throw new Error("GET /health names no protocol");
    this.protocol = String(protocol);
    return { protocol, body };
  }

  /** One request; `manage` uses the management key. Answers whatever status came back. */
  async request<T = any>(
    method: string,
    path: string,
    body?: unknown,
    manage = false,
  ): Promise<Answer<T>> {
    if (this.protocol === undefined) await this.health();
    const response = await this.fetch(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${manage ? this.options.manageKey : this.options.key}`,
        "nylorun-protocol": this.protocol!,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text === "" ? undefined : JSON.parse(text);
    } catch {
      /* not JSON: kept as text */
    }
    return { status: response.status, body: parsed as T };
  }

  /** `request`, refusing anything but a 2xx. */
  async ok<T = any>(method: string, path: string, body?: unknown, manage = false): Promise<T> {
    const answer = await this.request<T>(method, path, body, manage);
    if (answer.status < 200 || answer.status > 299)
      throw new RuntimeError(method, path, answer.status, answer.body);
    return answer.body;
  }

  tenant(): Promise<any> {
    return this.ok("GET", "/v1/tenant", undefined, true);
  }

  /** Turns on the Tenant's fixture model (insert-if-absent: it stays on). */
  seedFixtureModel(requestId: string): Promise<{ applied: string[]; kept: string[] }> {
    return this.ok("PUT", "/v1/tenant/config/seed", { requestId, fixtureModel: true }, true);
  }

  putAgent(id: string, manifest: unknown, requestId: string): Promise<unknown> {
    return this.ok("PUT", `/v1/agents/${encodeURIComponent(id)}`, {
      requestId,
      manifest,
      implementationVersion: "conformance",
    });
  }

  putEnvironment(
    id: string,
    spec: { kind: string; harness: string; image?: string },
  ): Promise<unknown> {
    return this.ok("PUT", `/v1/environments/${encodeURIComponent(id)}`, spec);
  }

  deleteEnvironment(id: string): Promise<Answer> {
    return this.request("DELETE", `/v1/environments/${encodeURIComponent(id)}`);
  }

  openSession(
    id: string,
    body: { agentId: string; ownerUserId: string; environment?: string },
  ): Promise<unknown> {
    return this.ok("PUT", `/v1/sessions/${encodeURIComponent(id)}`, {
      requestId: `open-${id}`,
      ...body,
    });
  }

  session(id: string): Promise<SessionView> {
    return this.ok("GET", `/v1/sessions/${encodeURIComponent(id)}`);
  }

  command(id: string, body: Record<string, unknown>): Promise<any> {
    return this.ok("POST", `/v1/sessions/${encodeURIComponent(id)}/commands`, body);
  }

  async items(id: string): Promise<RecordEvent[]> {
    const page = await this.ok<{ items: RecordEvent[] }>(
      "GET",
      `/v1/sessions/${encodeURIComponent(id)}/items`,
    );
    return page.items;
  }

  modelCalls(id: string, turnId?: string): Promise<ModelCallRow[]> {
    return this.pages<ModelCallRow>(`/v1/sessions/${encodeURIComponent(id)}/calls/model`, turnId);
  }

  toolCalls(id: string, turnId?: string): Promise<ToolCallRow[]> {
    return this.pages<ToolCallRow>(`/v1/sessions/${encodeURIComponent(id)}/calls/tool`, turnId);
  }

  /** A session sandbox route (`POST /v1/sessions/{id}/sandbox/{tool}`): any status. */
  sandbox(id: string, tool: string, input: Record<string, unknown>): Promise<Answer> {
    return this.request("POST", `/v1/sessions/${encodeURIComponent(id)}/sandbox/${tool}`, input);
  }

  private async pages<T>(path: string, turnId?: string): Promise<T[]> {
    const rows: T[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 100; page += 1) {
      const query = new URLSearchParams({ limit: "100" });
      if (turnId) query.set("turnId", turnId);
      if (cursor) query.set("cursor", cursor);
      const body: { calls: T[]; nextCursor: string | null } = await this.ok(
        "GET",
        `${path}?${query}`,
      );
      rows.push(...body.calls);
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    return rows;
  }
}
