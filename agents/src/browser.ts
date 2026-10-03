/**
 * `@nylorun/agents/browser`: a Runtime client for browsers and apps that hold no Tenant key
 * (Host features `subject-tokens` and `browser-access`). The page ships a publishable key; the
 * app server's token route returns a subject token for the signed-in person; the client keeps
 * it in memory, fetches a new one a minute before it expires or when the Runtime answers
 * `401 token_expired`, and never asks for two at once.
 *
 * No Node-only module is imported here or below.
 */
import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  PUBLISHABLE_KEY_HEADER,
} from "@nylorun/core/compatibility";
import type { CredentialSelection, VaultInfo } from "@nylorun/core/contracts";
import type { TokenSource } from "./http.js";
import { AgentsClient, type SessionClient } from "./session-client.js";
import type { ArtifactsClient } from "./artifacts.js";

/** What the token callback returns: the token, or the app server's `{ token, expiresAt }`. */
export type TokenReply = string | { token: string; expiresAt?: string };

export interface BrowserClientOptions {
  /** The Runtime's URL, as the page reaches it. */
  url: string;
  /** The Tenant's publishable key for this app (`nr_pub_…`). */
  publishableKey: string;
  /** Returns a subject token for the signed-in person, usually from your app server. */
  token(signal?: AbortSignal): Promise<TokenReply>;
  fetch?: typeof fetch;
}

/** Fetch a new token this long before the current one expires. */
const REFRESH_EARLY_MS = 60_000;

interface Claims {
  sub?: string;
  exp?: number;
}

/** The token's claims, read without verifying (the Runtime verifies). */
export function readClaims(token: string): Claims {
  const payload = token.split(".")[1];
  if (!payload) return {};
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const json = new TextDecoder().decode(
      Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
    );
    return JSON.parse(json) as Claims;
  } catch {
    return {};
  }
}

/** A token kept in memory, fetched on demand, one fetch at a time. */
export class CachedToken implements TokenSource {
  private current: { token: string; expiresAt: number } | undefined;
  private pending: Promise<string> | undefined;

  constructor(
    private readonly fetchToken: (signal?: AbortSignal) => Promise<TokenReply>,
    private readonly now: () => number = Date.now
  ) {}

  get(signal?: AbortSignal): Promise<string> {
    if (this.current && this.current.expiresAt - REFRESH_EARLY_MS > this.now())
      return Promise.resolve(this.current.token);
    this.pending ??= this.fetchToken(signal)
      .then((reply) => {
        const token = typeof reply === "string" ? reply : reply.token;
        if (typeof token !== "string" || token === "")
          throw new Error("The token callback returned no token");
        const expiresAt =
          typeof reply !== "string" && reply.expiresAt
            ? Date.parse(reply.expiresAt)
            : (readClaims(token).exp ?? 0) * 1000;
        this.current = { token, expiresAt };
        return token;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  invalidate(): void {
    this.current = undefined;
  }

  /** The subject of the current token, fetching one if needed. */
  async subject(signal?: AbortSignal): Promise<string> {
    const sub = readClaims(await this.get(signal)).sub;
    if (!sub) throw new Error("The subject token names no subject");
    return sub;
  }
}

/** Reattaching a run the Runtime ended for its token, at most this many times in a row. */
const MAX_REATTACH = 5;

/** One SSE frame's raw text, its `id:` and its parsed `data:` (AG-UI event), if any. */
interface Frame {
  readonly text: string;
  readonly id?: string;
  readonly event?: { type?: string; name?: string };
}

function parseFrame(text: string): Frame {
  let id: string | undefined;
  let data: string | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("id: ")) id = line.slice(4);
    else if (line.startsWith("data: ")) data = line.slice(6);
  }
  let event: Frame["event"];
  try {
    event = data === undefined ? undefined : JSON.parse(data);
  } catch {
    event = undefined;
  }
  return { text, ...(id ? { id } : {}), ...(event ? { event } : {}) };
}

/** The frames of an SSE body, as they arrive. */
async function* frames(body: ReadableStream<Uint8Array>): AsyncGenerator<Frame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const text = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (text.trim() !== "") yield parseFrame(text);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** The signed-in person's view of the Runtime: their sessions and vaults, the agents they may use. */
export class BrowserClient {
  /** The underlying Tenant API client, for anything this class does not wrap. */
  readonly client: AgentsClient;
  readonly url: string;
  readonly publishableKey: string;
  private readonly tokens: CachedToken;
  private readonly fetcher: typeof fetch;

  constructor(options: BrowserClientOptions) {
    this.url = options.url.replace(/\/$/, "");
    this.publishableKey = options.publishableKey;
    this.tokens = new CachedToken((signal) => options.token(signal));
    const base = options.fetch ?? globalThis.fetch;
    // Called as a method, a page's window.fetch would lose its receiver.
    this.fetcher = options.fetch ? base : (input, init) => base(input, init);
    this.client = new AgentsClient({
      url: this.url,
      publishableKey: options.publishableKey,
      token: this.tokens,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  /** The person the tokens are for. */
  subject(signal?: AbortSignal): Promise<string> {
    return this.tokens.subject(signal);
  }

  /** A current token, e.g. for a request this client does not make itself. */
  token(signal?: AbortSignal): Promise<string> {
    return this.tokens.get(signal);
  }

  /** The agents the person may use: id, name and description. */
  listAgents(signal?: AbortSignal) {
    return this.client.listAgents({ ...(signal ? { signal } : {}) }) as unknown as Promise<{
      agents: { agentId: string; name?: string; description?: string }[];
    }>;
  }

  listSessions(agentId?: string, signal?: AbortSignal) {
    return this.client.listSessions({
      ...(agentId ? { agentId } : {}),
      ...(signal ? { signal } : {}),
    });
  }

  session(sessionId: string): SessionClient {
    return this.client.session(sessionId);
  }

  /** The person's file artifacts, in their own sessions (protocol 6). */
  get artifacts(): ArtifactsClient {
    return this.client.artifacts;
  }

  /** A session of the person's own; the owner is always the token's subject. */
  async createSession(options: {
    id?: string;
    agentId: string;
    vaultIds?: readonly string[];
    credentialSelections?: readonly CredentialSelection[];
    /** A sandbox the token's `sandboxes` grants reach (Host feature `sandboxes`). */
    sandbox?: { id: string };
  }): Promise<SessionClient> {
    return this.client.createSession({
      ...options,
      ownerUserId: await this.subject(),
    });
  }

  async createVault(options: {
    name: string;
    idempotencyKey: string;
    metadata?: Record<string, string>;
  }): Promise<VaultInfo> {
    return this.client.createVault({ ...options, ownerUserId: await this.subject() });
  }

  async listVaults(signal?: AbortSignal): Promise<{ vaults: VaultInfo[] }> {
    return this.client.listVaults(await this.subject(signal), signal);
  }

  /** `fetch` with this client's credentials, retrying once after `401 token_expired`. */
  private async send(input: string, init: RequestInit = {}, retried = false): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${await this.tokens.get(init.signal ?? undefined)}`);
    headers.set(PUBLISHABLE_KEY_HEADER, this.publishableKey);
    headers.set(PROTOCOL_HEADER, String(PROTOCOL_VERSION));
    const response = await this.fetcher(input, { ...init, headers });
    if (response.status !== 401 || retried) return response;
    const body = (await response.clone().json().catch(() => undefined)) as
      | { code?: unknown }
      | undefined;
    if (body?.code !== "token_expired") return response;
    await response.body?.cancel().catch(() => {});
    this.tokens.invalidate();
    return this.send(input, init, true);
  }

  /**
   * For `@ag-ui/client`'s `HttpAgent`: `new HttpAgent({ url, fetch })`. The `fetch` adds the
   * publishable key and a current token, and when the Runtime ends a run's stream because the
   * token expired or was revoked, it reattaches with a new token from the last event, so the
   * agent sees one run.
   */
  agUi(agentId: string): {
    url: string;
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  } {
    const url = `${this.url}/v1/ag-ui/agents/${encodeURIComponent(agentId)}`;
    const fetchRun = async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const response = await this.send(target, init);
      const isStream = response.headers.get("content-type")?.includes("text/event-stream");
      const method = (init.method ?? "GET").toUpperCase();
      if (!response.ok || !isStream || !response.body || method !== "POST" || target !== url)
        return response;
      let run: { threadId?: string; runId?: string } = {};
      try {
        run = JSON.parse(String(init.body ?? "{}"));
      } catch {
        /* not a RunAgentInput: pass the stream through as it is */
      }
      if (!run.threadId) return response;
      return new Response(this.stitch(response.body, url, run.threadId, run.runId, init.signal ?? undefined), {
        status: response.status,
        headers: response.headers,
      });
    };
    return { url, fetch: fetchRun };
  }

  /** The thread's messages, for `HttpAgent`'s `initialMessages`. */
  async agUiHistory(agentId: string, threadId: string, signal?: AbortSignal): Promise<unknown[]> {
    const response = await this.send(
      `${this.url}/v1/ag-ui/agents/${encodeURIComponent(agentId)}/threads/${encodeURIComponent(threadId)}/messages`,
      { method: "GET", ...(signal ? { signal } : {}) }
    );
    if (!response.ok) throw new Error(`Runtime HTTP ${response.status}`);
    return (await response.json()) as unknown[];
  }

  /**
   * Passes a run's frames through; on `nylorun.stream_closed` before the run finished, fetches
   * the rest from the last event id and continues without repeating `RUN_STARTED`.
   */
  private stitch(
    body: ReadableStream<Uint8Array>,
    url: string,
    threadId: string,
    runId: string | undefined,
    signal: AbortSignal | undefined
  ): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const self = this;
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        let lastId: string | undefined;
        let source: ReadableStream<Uint8Array> | null = body;
        let reattaching = false;
        try {
          for (let attempt = 0; source && attempt <= MAX_REATTACH; attempt += 1) {
            let closed = false;
            for await (const frame of frames(source)) {
              if (frame.event?.type === "CUSTOM" && frame.event.name === "nylorun.stream_closed") {
                if (frame.id) lastId = frame.id;
                closed = true;
                break;
              }
              // The reattached stream starts its run again; the agent already has it.
              if (reattaching && frame.event?.type === "RUN_STARTED") continue;
              if (frame.id) lastId = frame.id;
              controller.enqueue(encoder.encode(`${frame.text}\n\n`));
            }
            source = null;
            if (!closed || !lastId || signal?.aborted) break;
            reattaching = true;
            const query = runId ? `?runId=${encodeURIComponent(runId)}` : "";
            const next = await self.send(
              `${url}/threads/${encodeURIComponent(threadId)}/events${query}`,
              {
                method: "GET",
                headers: { accept: "text/event-stream", "last-event-id": lastId },
                ...(signal ? { signal } : {}),
              }
            );
            // 204: the run ended with nothing after the last event; there is no more to send.
            if (next.ok && next.status !== 204 && next.body) source = next.body;
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });
  }
}

export function createBrowserClient(options: BrowserClientOptions): BrowserClient {
  return new BrowserClient(options);
}
