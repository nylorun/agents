/**
 * An embedded Studio's session (Studio §8.4): the bearer token lives in this
 * module only, never in storage, a cookie or the URL.
 *
 * - `redeem` exchanges the embedder's login token at `POST /_studio/sessions`.
 * - Ten minutes before the session expires, and whenever the server answers
 *   401, Studio asks the embedder for a new login token (`token.expiring`) and
 *   holds requests until it arrives, then retries each once.
 * - Without a token for `waitMs`, waiting requests fail and the status becomes
 *   `failed`; `retry` asks again.
 */
import { StudioSessionResponseSchema } from "@nylorun/agents/studio-embed";
import type { OutboundMessage } from "./bridge.ts";

export type EmbedStatus = "waiting" | "ready" | "reconnecting" | "failed";

/** How long before expiry Studio asks for a new token. */
export const REFRESH_BEFORE_MS = 10 * 60 * 1000;
/** How long requests wait for a token before failing. */
export const TOKEN_WAIT_MS = 30 * 1000;

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class EmbedSessionUnavailableError extends Error {
  constructor() {
    super("Studio is waiting for the app to sign it in.");
    this.name = "EmbedSessionUnavailableError";
  }
}

export type EmbedSession = Readonly<{
  status(): EmbedStatus;
  subscribe(listener: (status: EmbedStatus) => void): () => void;
  /** Exchanges a login token from `init` or `token.refresh`. */
  redeem(loginToken: string): Promise<void>;
  /** `fetch` with the session's bearer; waits for a session when there is none. */
  fetch: Fetch;
  /** Asks the embedder for a token again after `failed`. */
  retry(): void;
  stop(): void;
}>;

export function createEmbedSession(options: {
  fetch: Fetch;
  post: (message: OutboundMessage) => void;
  now?: () => number;
  waitMs?: number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}): EmbedSession {
  const now = options.now ?? Date.now;
  const waitMs = options.waitMs ?? TOKEN_WAIT_MS;
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer =
    options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));

  let token: string | undefined;
  let expiresAt = 0;
  let status: EmbedStatus = "waiting";
  let refreshTimer: unknown;
  const listeners = new Set<(status: EmbedStatus) => void>();
  let waiters: { resolve: (token: string) => void; reject: (error: Error) => void }[] = [];

  const setStatus = (next: EmbedStatus) => {
    if (next === status) return;
    status = next;
    for (const listener of listeners) listener(next);
  };

  const askForToken = () => {
    options.post({
      kind: "token.expiring",
      expiresAt: expiresAt > 0 ? new Date(expiresAt).toISOString() : null,
    });
  };

  /** The session is gone (expired, or the server refused it): ask for another. */
  const lose = (used: string) => {
    if (token !== used) return;
    token = undefined;
    setStatus("reconnecting");
    askForToken();
  };

  const current = (): Promise<string> => {
    if (token !== undefined && expiresAt > now()) return Promise.resolve(token);
    if (token !== undefined) lose(token);
    return new Promise<string>((resolve, reject) => {
      const waiter = { resolve, reject };
      waiters.push(waiter);
      setTimer(() => {
        if (!waiters.includes(waiter)) return;
        waiters = waiters.filter((other) => other !== waiter);
        setStatus("failed");
        reject(new EmbedSessionUnavailableError());
      }, waitMs);
    });
  };

  const redeem = async (loginToken: string) => {
    const response = await options.fetch("/_studio/sessions", {
      method: "POST",
      credentials: "omit",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: loginToken }),
    });
    if (!response.ok) {
      options.post({
        kind: "error",
        code: "token_invalid",
        message: `Studio refused the login token (HTTP ${response.status}).`,
      });
      return;
    }
    const session = StudioSessionResponseSchema.parse(await response.json());
    token = session.sessionToken;
    expiresAt = Date.parse(session.expiresAt);
    if (refreshTimer !== undefined) clearTimer(refreshTimer);
    const issued = token;
    refreshTimer = setTimer(
      () => {
        if (token === issued) askForToken();
      },
      Math.max(0, expiresAt - now() - REFRESH_BEFORE_MS),
    );
    setStatus("ready");
    const ready = waiters;
    waiters = [];
    for (const waiter of ready) waiter.resolve(issued);
    options.post({
      kind: "session",
      tenant: session.tenant,
      subject: session.subject,
      expiresAt: session.expiresAt,
    });
  };

  const withBearer = (init: RequestInit | undefined, bearer: string): RequestInit => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${bearer}`);
    return { ...init, headers, credentials: "omit" };
  };

  const fetchWithSession: Fetch = async (input, init) => {
    const first = await current();
    const response = await options.fetch(input, withBearer(init, first));
    if (response.status !== 401) return response;
    // Retry once with a fresh session; a streaming body cannot be replayed.
    lose(first);
    if (init?.body instanceof ReadableStream) return response;
    const second = await current();
    return options.fetch(input, withBearer(init, second));
  };

  return Object.freeze({
    status: () => status,
    subscribe(listener: (status: EmbedStatus) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    redeem,
    fetch: fetchWithSession,
    retry() {
      setStatus(token === undefined ? "reconnecting" : status);
      askForToken();
    },
    stop() {
      if (refreshTimer !== undefined) clearTimer(refreshTimer);
      listeners.clear();
    },
  });
}
