/**
 * `@nylorun/agents/browser`: a Runtime client for browsers and apps that hold no Tenant key
 * (Host features `subject-tokens` and `browser-access`). The page ships a publishable key; the
 * app server's token route returns a subject token for the signed-in person; the client keeps
 * it in memory, fetches a new one a minute before it expires or when the Runtime answers
 * `401 token_expired`, and never asks for two at once.
 *
 * No Node-only module is imported here or below.
 */
import type { CredentialSelection, VaultInfo } from "@nylorun/core/contracts";
import type { TokenSource } from "./http.js";
import { AgentsClient, type SessionClient } from "./session-client.js";

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

/** The signed-in person's view of the Runtime: their sessions and vaults, the agents they may use. */
export class BrowserClient {
  /** The underlying Tenant API client, for anything this class does not wrap. */
  readonly client: AgentsClient;
  readonly url: string;
  readonly publishableKey: string;
  private readonly tokens: CachedToken;

  constructor(options: BrowserClientOptions) {
    this.url = options.url.replace(/\/$/, "");
    this.publishableKey = options.publishableKey;
    this.tokens = new CachedToken((signal) => options.token(signal));
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

  /** A session of the person's own; the owner is always the token's subject. */
  async createSession(options: {
    id?: string;
    agentId: string;
    vaultIds?: readonly string[];
    credentialSelections?: readonly CredentialSelection[];
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
}

export function createBrowserClient(options: BrowserClientOptions): BrowserClient {
  return new BrowserClient(options);
}
