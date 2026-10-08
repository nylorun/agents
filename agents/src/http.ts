import {
  PROTOCOL_FEATURES,
  type ProtocolRange,
} from "@nylorun/core/compatibility";
import {
  advertisedProtocol,
  checkHealth,
  clientCompatibility,
  describeIncompatibility,
  readBody,
  requestHeaders,
  type Incompatibility,
} from "@nylorun/core/transport";

/**
 * Bearer tokens for a client that holds no Tenant key: a trusted issuer's tokens (Host feature
 * `trusted-issuers`), from the operator's identity provider. `get` returns a current token and
 * may fetch a new one; `invalidate` drops the cached one after the Runtime answered
 * `401 token_expired`.
 */
export interface TokenSource {
  get(signal?: AbortSignal): Promise<string>;
  invalidate(): void;
}

/**
 * Where a client sends its requests. Nothing names a Tenant: the Runtime at `url` serves one
 * (protocol 5).
 */
export interface Destination {
  url?: string;
  key?: string;
  fetch?: typeof fetch;
  /** Instead of `key`: a trusted issuer's tokens. The client then skips the `/health` check. */
  token?: TokenSource;
}

export function env(name: string): string | undefined {
  return typeof process !== "undefined" ? process.env[name] : undefined;
}

export class RuntimeError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`Runtime HTTP ${status}: ${JSON.stringify(body)}`);
  }
}

export type IncompatibleReason = Incompatibility;

/** Host protocol is outside the client's supported range or missing required features. */
export class IncompatibleRuntimeError extends Error {
  readonly compatibility: IncompatibleReason;
  readonly remedy: string;
  readonly host: ProtocolRange;

  constructor(compatibility: IncompatibleReason) {
    const remedy = remedyFor(compatibility);
    super(`Incompatible Runtime: ${describeIncompatibility(compatibility)}. ${remedy}`);
    this.name = "IncompatibleRuntimeError";
    this.compatibility = compatibility;
    this.remedy = remedy;
    this.host = compatibility.host;
  }
}

function remedyFor(compatibility: IncompatibleReason): string {
  if (compatibility.reason === "feature") {
    return "Upgrade the Runtime Host (nylorun runtime restart from a newer CLI) so it advertises the required features.";
  }
  if (compatibility.client < compatibility.host.min) {
    return "Upgrade this client (npm i -D @nylorun/agents@latest) or use a CLI that matches the Host protocol.";
  }
  return "Upgrade the Runtime Host with nylorun runtime restart from a newer CLI, or install a matching older client (npm i -D @nylorun/cli@<compatible>).";
}

/** The Host compatibility result, shared by a transport and its `withHeaders` copies. */
interface HostCheck {
  compatible: boolean;
  /** Features the Host advertised at the last compatibility check. */
  features: readonly string[];
  /** The Host's protocol range at the last compatibility check. */
  range?: ProtocolRange;
}

export class Transport {
  readonly url: string;
  /** The Tenant key; empty for a client that uses issuer tokens. */
  readonly key: string;
  readonly token: TokenSource | undefined;
  readonly fetcher: typeof fetch;
  /** Sent on every request, e.g. `Nylorun-Subject` and `Nylorun-Scopes` (`withHeaders`). */
  readonly headers: Readonly<Record<string, string>> = {};
  private readonly check: HostCheck = { compatible: false, features: [] };

  constructor(options: Destination = {}) {
    const url = options.url ?? env("NYLORUN_RUNTIME_URL");
    const token = options.token;
    const key = token ? "" : options.key ?? env("NYLORUN_SERVER_KEY");
    if (!url || (!token && !key))
      throw new Error(
        "Set Runtime url and server key explicitly or via NYLORUN_RUNTIME_URL / NYLORUN_SERVER_KEY",
      );
    if (token && options.key)
      throw new Error("Use a Tenant key or issuer tokens, not both");
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol))
      throw new Error("Runtime requires an HTTP(S) URL");
    this.url = url.replace(/\/$/, "");
    this.key = key!;
    this.token = token;
    // Browsers may not call `/health` (it refuses `Origin`); token clients rely on `426`.
    if (token) this.check.compatible = true;
    // Called as a method on a page's window would otherwise lose `this`.
    const fetcher = options.fetch ?? globalThis.fetch;
    this.fetcher = options.fetch ? fetcher : (input, init) => fetcher(input, init);
  }

  /**
   * The same destination with `headers` added to every request. The copy shares this
   * transport's compatibility check, so a copy made per request does not repeat `/health`.
   */
  withHeaders(headers: Readonly<Record<string, string>>): Transport {
    const copy = Object.create(Transport.prototype) as Transport;
    return Object.assign(copy, this, {
      headers: Object.freeze({ ...this.headers, ...headers }),
    });
  }

  /** Clears the cached Host compatibility result (used after a 426). */
  clearCompatibilityCache(): void {
    this.check.compatible = false;
  }

  private async ensureCompatible(signal?: AbortSignal): Promise<void> {
    if (this.check.compatible) return;
    const health = await checkHealth(this.url, {
      fetch: this.fetcher,
      ...(signal ? { signal } : {}),
    });
    if (health.result === "failed") throw new RuntimeError(health.status, health.body);
    if (health.result === "unadvertised")
      throw new IncompatibleRuntimeError({
        ok: false,
        reason: "feature",
        missing: [...PROTOCOL_FEATURES],
        host: { min: 0, max: 0, features: [] },
      });
    if (health.result === "incompatible") throw new IncompatibleRuntimeError(health.compatibility);
    this.check.features = [...health.protocol.features];
    this.check.range = health.protocol;
    this.check.compatible = true;
  }

  /** Throws `IncompatibleRuntimeError` before anything is sent when the Host lacks `feature`. */
  async requireFeature(feature: string, signal?: AbortSignal): Promise<void> {
    const features = await this.hostFeatures(signal);
    if (!features.includes(feature))
      throw new IncompatibleRuntimeError({
        ok: false,
        reason: "feature",
        missing: [feature],
        host: this.check.range ?? { min: 0, max: 0, features },
      });
  }

  /** The Host's protocol features, including optional ones, from its `/health`. */
  async hostFeatures(signal?: AbortSignal): Promise<readonly string[]> {
    await this.ensureCompatible(signal);
    return this.check.features;
  }

  private async authHeaders(init: RequestInit = {}): Promise<Headers> {
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(this.headers))
      headers.set(name, value);
    const bearer = this.token
      ? await this.token.get(init.signal ?? undefined)
      : this.key;
    for (const [name, value] of Object.entries(requestHeaders(bearer)))
      headers.set(name, value);
    // JSON unless the caller says otherwise (an artifact upload sends the file's type).
    if (init.body && !headers.has("content-type")) headers.set("Content-Type", "application/json");
    return headers;
  }

  async request(
    path: string,
    init: RequestInit = {},
    options: { retried426?: boolean; retried401?: boolean } = {},
  ): Promise<Response> {
    await this.ensureCompatible(
      init.signal === null ? undefined : init.signal,
    );
    const response = await this.fetcher(this.url + path, {
      ...init,
      headers: await this.authHeaders(init),
      redirect: "error",
    });
    // An expired token: get a new one and try once more.
    if (response.status === 401 && this.token && !options.retried401) {
      const body = (await response.clone().json().catch(() => undefined)) as
        | { code?: unknown }
        | undefined;
      if (body?.code === "token_expired") {
        await response.body?.cancel().catch(() => {});
        this.token.invalidate();
        return this.request(path, init, { ...options, retried401: true });
      }
    }
    if (response.status === 426) {
      this.clearCompatibilityCache();
      if (!options.retried426) {
        await this.ensureCompatible(
          init.signal === null ? undefined : init.signal,
        );
        return this.request(path, init, { retried426: true });
      }
      const body = await readBody(response);
      const protocol = advertisedProtocol(body);
      if (protocol) {
        const result = clientCompatibility(protocol);
        if (!result.ok) throw new IncompatibleRuntimeError(result);
      }
      throw new RuntimeError(426, body);
    }
    if (!response.ok) throw new RuntimeError(response.status, await readBody(response));
    return response;
  }

  /**
   * Sends a request with this client's credentials and returns the Runtime's response as it
   * is, errors included (an app server passing a response through, e.g. the AG-UI handler).
   */
  async forward(path: string, init: RequestInit = {}): Promise<Response> {
    await this.ensureCompatible(init.signal === null ? undefined : init.signal);
    return this.fetcher(this.url + path, {
      ...init,
      headers: await this.authHeaders(init),
      redirect: "error",
    });
  }

  async json<T>(
    path: string,
    method = "GET",
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.request(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
    return response.status === 204
      ? (undefined as T)
      : (response.json() as Promise<T>);
  }
}

export const id = () => globalThis.crypto.randomUUID();
export const segment = (value: string) => encodeURIComponent(value);
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const stop = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
}
