/**
 * Where a session's MCP credential comes from (F9 C1): the session's attached vaults first,
 * then the operator's credential resolver, an HTTP service on the operator's own network that
 * holds people's own credentials (OSS never stores them, F9-D7).
 *
 * Both authorize sites call this: the gateway (`gates/tenant-vaults.ts`, remote MCP servers in
 * the gates service) and the Tenant (`tenant/effects.ts`, the in-process MCP pool).
 *
 * ## The resolver contract
 *
 * Asked only when the attached vaults hold no credential for the URL (the vault's
 * `unauthenticated`), and only for a person's session (never a reserved owner):
 *
 * ```text
 * POST <resolver url>
 * Authorization: Bearer <resolver token>
 * { "owner": "u:priya", "session": "s_…", "turn": "t_…" | null,
 *   "target": { "kind": "mcp", "server": "github", "agent": "support", "url": "https://…/mcp" } }
 *
 * 200 { "headers": { "authorization": "Bearer …" }, "expiresAt"?: "<ISO time>" } → authorized
 * 404                                         → unauthenticated (the call goes without one)
 * anything else, a bad body, or no answer in 5 s → refused: credential_unavailable
 * ```
 *
 * `owner` and `turn` come from the session row, never from the harness. Because authorize runs
 * on every MCP HTTP request, answers (200 and 404) are cached per (owner, url): until
 * `expiresAt`, at most 5 minutes, and 60 s without one. Concurrent misses for one key share one
 * request. Failures are not cached. The resolver's URL is the operator's, so private addresses
 * are allowed; redirects are refused.
 */
import { isSubject } from "@nylorun/core/contracts";
import type { CredentialSelection } from "@nylorun/core/contracts";
import type { AuthorizeResult, VaultService } from "./service.js";

/** The operator's credential resolver (`NYLORUN_RESOLVER_URL`, `NYLORUN_RESOLVER_TOKEN`). */
export interface ResolverConfig {
  readonly url: string;
  readonly token: string;
}

/** What the resolver is asked about: the session's row, as stored. */
export interface CredentialSession {
  readonly id: string;
  readonly ownerUserId: string;
  readonly activeTurnId: string | null;
  readonly vaultIds?: readonly string[];
  readonly credentialSelections?: readonly CredentialSelection[];
}

/** One MCP request: the declared server's URL, its name and the agent that declares it. */
export interface McpCredentialRequest {
  readonly url: string;
  readonly serverName?: string;
  /** The agent used as a tool that declares the server; absent for the session's root agent. */
  readonly agentId?: string;
}

export interface CredentialSourcesOptions {
  readonly vault: Pick<VaultService, "authorize">;
  /** Absent: the vaults are the only source, as before F9. */
  readonly resolver?: ResolverConfig;
  /** Default `globalThis.fetch`. */
  readonly fetch?: typeof fetch;
  /** How long the resolver may take. Default 5 s. */
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export const RESOLVER_TIMEOUT_MS = 5_000;
/** The longest an answer is kept, whatever its `expiresAt`. */
export const RESOLVER_MAX_CACHE_MS = 5 * 60_000;
/** How long an answer without `expiresAt` (and a 404) is kept. */
export const RESOLVER_DEFAULT_CACHE_MS = 60_000;
/** The refusal reason when the resolver could not answer. */
export const CREDENTIAL_UNAVAILABLE = "credential_unavailable";

type Answer =
  | { kind: "headers"; headers: Record<string, string>; expiresAt?: number }
  | { kind: "none" }
  | { kind: "failed" };

type Cached = { answer: Exclude<Answer, { kind: "failed" }>; until: number };

/** RFC 9110 field names. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Headers the MCP transport owns; a resolver may not set them. */
const RESERVED_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "transfer-encoding",
  "connection",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
]);

export class CredentialSources {
  private readonly vault: Pick<VaultService, "authorize">;
  private readonly resolver: ResolverConfig | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, Cached>();
  private readonly pending = new Map<string, Promise<Answer>>();

  constructor(options: CredentialSourcesOptions) {
    this.vault = options.vault;
    this.resolver = options.resolver;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? RESOLVER_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  /** The credential of one MCP request made for `session`. */
  async authorize(
    session: CredentialSession,
    request: McpCredentialRequest,
  ): Promise<AuthorizeResult> {
    const result = await this.vault.authorize({
      sessionId: session.id,
      vaultIds: session.vaultIds ?? [],
      credentialSelections: session.credentialSelections ?? [],
      url: request.url,
      ...(request.serverName === undefined ? {} : { serverName: request.serverName }),
    });
    if (result.status !== "unauthenticated" || !this.resolver) return result;
    // `host` and `installation` are no one: there is no person to resolve for.
    if (!isSubject(session.ownerUserId)) return result;
    const answer = await this.answer(session, request, result.url);
    if (answer.kind === "failed")
      return { status: "refused", url: result.url, credentialIds: [], reason: CREDENTIAL_UNAVAILABLE };
    if (answer.kind === "none") return result;
    return { status: "authorized", url: result.url, headers: { ...answer.headers } };
  }

  private async answer(
    session: CredentialSession,
    request: McpCredentialRequest,
    url: string,
  ): Promise<Answer> {
    const key = JSON.stringify([session.ownerUserId, url]);
    const cached = this.cache.get(key);
    if (cached) {
      if (cached.until > this.now()) return cached.answer;
      this.cache.delete(key);
    }
    let pending = this.pending.get(key);
    if (!pending) {
      pending = this.ask(session, request, url)
        .then((answer) => {
          if (answer.kind !== "failed") {
            const until = this.until(answer);
            if (until > this.now()) this.cache.set(key, { answer, until });
          }
          return answer;
        })
        .finally(() => this.pending.delete(key));
      this.pending.set(key, pending);
    }
    return pending;
  }

  private until(answer: Exclude<Answer, { kind: "failed" }>): number {
    const now = this.now();
    const cap = now + RESOLVER_MAX_CACHE_MS;
    if (answer.kind === "headers" && answer.expiresAt !== undefined)
      return Math.min(answer.expiresAt, cap);
    return now + RESOLVER_DEFAULT_CACHE_MS;
  }

  private async ask(
    session: CredentialSession,
    request: McpCredentialRequest,
    url: string,
  ): Promise<Answer> {
    const resolver = this.resolver!;
    const body = {
      owner: session.ownerUserId,
      session: session.id,
      turn: session.activeTurnId ?? null,
      target: {
        kind: "mcp",
        ...(request.serverName ? { server: request.serverName } : {}),
        ...(request.agentId ? { agent: request.agentId } : {}),
        url,
      },
    };
    try {
      const response = await this.fetchImpl(resolver.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${resolver.token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        return { kind: "none" };
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        return { kind: "failed" };
      }
      return parseAnswer(await response.json(), this.now());
    } catch {
      return { kind: "failed" };
    }
  }
}

function parseAnswer(value: unknown, now: number): Answer {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "failed" };
  const { headers, expiresAt } = value as { headers?: unknown; expiresAt?: unknown };
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return { kind: "failed" };
  const entries = Object.entries(headers as Record<string, unknown>);
  if (entries.length === 0) return { kind: "failed" };
  const out: Record<string, string> = {};
  for (const [name, item] of entries) {
    if (!HEADER_NAME.test(name) || RESERVED_HEADERS.has(name.toLowerCase())) return { kind: "failed" };
    if (typeof item !== "string" || item === "" || /[\r\n\0]/.test(item)) return { kind: "failed" };
    out[name.toLowerCase()] = item;
  }
  if (expiresAt === undefined || expiresAt === null) return { kind: "headers", headers: out };
  if (typeof expiresAt !== "string") return { kind: "failed" };
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return { kind: "failed" };
  // An answer that has already expired is used once and not kept.
  return { kind: "headers", headers: out, expiresAt: Math.max(at, now) };
}
