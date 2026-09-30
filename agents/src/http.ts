import {
  PROTOCOL_FEATURES,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  PUBLISHABLE_KEY_HEADER,
  TENANT_HEADER,
  checkCompatibility,
  type Compatibility,
  type ProtocolRange,
} from "@nylorun/core/compatibility";

/**
 * Subject tokens for a client that holds no Tenant key (a browser or an app; Host feature
 * `subject-tokens`). `get` returns a current token and may fetch a new one; `invalidate`
 * drops the cached one after the Runtime answered `401 token_expired`.
 */
export interface TokenSource {
  get(signal?: AbortSignal): Promise<string>;
  invalidate(): void;
}

export interface Destination {
  url?: string;
  key?: string;
  tenant?: string;
  fetch?: typeof fetch;
  /** Instead of `key`: subject tokens. The client then skips the `/health` check. */
  token?: TokenSource;
  /** A publishable key (Host feature `browser-access`); it also names the Tenant. */
  publishableKey?: string;
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

export type IncompatibleReason = Extract<Compatibility, { ok: false }>;

/** Host protocol is outside the client's supported range or missing required features. */
export class IncompatibleRuntimeError extends Error {
  readonly compatibility: IncompatibleReason;
  readonly remedy: string;
  readonly host: ProtocolRange;

  constructor(compatibility: IncompatibleReason) {
    const remedy = remedyFor(compatibility);
    const detail =
      compatibility.reason === "version"
        ? `client protocol ${compatibility.client} is outside Host range ${compatibility.host.min}–${compatibility.host.max}`
        : `Host is missing required features: ${compatibility.missing.join(", ")}`;
    super(`Incompatible Runtime: ${detail}. ${remedy}`);
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

function parseProtocolRange(value: unknown): ProtocolRange | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.min !== "number" ||
    typeof record.max !== "number" ||
    !Array.isArray(record.features) ||
    !record.features.every((f) => typeof f === "string")
  )
    return undefined;
  return {
    min: record.min,
    max: record.max,
    features: record.features as readonly string[],
  };
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
  /** The Tenant key; empty for a client that uses subject tokens. */
  readonly key: string;
  /** The Tenant id; empty when a publishable key names it. */
  readonly tenant: string;
  readonly token: TokenSource | undefined;
  readonly publishableKey: string | undefined;
  readonly fetcher: typeof fetch;
  /** Sent on every request, e.g. `Nylorun-Subject` and `Nylorun-Scopes` (`withHeaders`). */
  readonly headers: Readonly<Record<string, string>> = {};
  private readonly check: HostCheck = { compatible: false, features: [] };

  constructor(
    options: Destination = {},
    role: "server" | "executor" = "server",
  ) {
    const url = options.url ?? env("NYLORUN_RUNTIME_URL");
    const token = options.token;
    const key = token
      ? ""
      : options.key ??
        env(role === "server" ? "NYLORUN_SERVER_KEY" : "NYLORUN_EXECUTOR_KEY");
    const tenant = options.tenant ?? (token ? undefined : env("NYLORUN_TENANT"));
    if (!url || (!token && !key))
      throw new Error(
        `Set Runtime url and ${role} key explicitly or via NYLORUN_RUNTIME_URL / NYLORUN_${role.toUpperCase()}_KEY`,
      );
    if (token && options.key)
      throw new Error("Use a Tenant key or subject tokens, not both");
    if (!tenant && !options.publishableKey)
      throw new Error("Set tenant explicitly or via NYLORUN_TENANT");
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol))
      throw new Error("Runtime requires an HTTP(S) URL");
    this.url = url.replace(/\/$/, "");
    this.key = key!;
    this.tenant = tenant ?? "";
    this.token = token;
    this.publishableKey = options.publishableKey;
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

  /**
   * The same destination with another bearer (a delivery token for an Action endpoint's
   * callbacks). Like `withHeaders`, the copy shares this transport's compatibility check.
   */
  withKey(key: string): Transport {
    const copy = Object.create(Transport.prototype) as Transport;
    return Object.assign(copy, this, { key });
  }

  /** Clears the cached Host compatibility result (used after a 426). */
  clearCompatibilityCache(): void {
    this.check.compatible = false;
  }

  private async ensureCompatible(signal?: AbortSignal): Promise<void> {
    if (this.check.compatible) return;
    const response = await this.fetcher(`${this.url}/health`, {
      method: "GET",
      redirect: "error",
      signal,
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep text */
    }
    if (!response.ok)
      throw new RuntimeError(response.status, body);
    const protocol = parseProtocolRange(
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>).protocol
        : undefined,
    );
    if (!protocol)
      throw new IncompatibleRuntimeError({
        ok: false,
        reason: "feature",
        missing: [...PROTOCOL_FEATURES],
        host: { min: 0, max: 0, features: [] },
      });
    const result = checkCompatibility(
      { version: PROTOCOL_VERSION, required: [...PROTOCOL_FEATURES] },
      protocol,
    );
    if (!result.ok) throw new IncompatibleRuntimeError(result);
    this.check.features = [...protocol.features];
    this.check.range = protocol;
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
    headers.set("Authorization", `Bearer ${bearer}`);
    if (this.tenant) headers.set(TENANT_HEADER, this.tenant);
    if (this.publishableKey)
      headers.set(PUBLISHABLE_KEY_HEADER, this.publishableKey);
    headers.set(PROTOCOL_HEADER, String(PROTOCOL_VERSION));
    if (init.body) headers.set("Content-Type", "application/json");
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
    // An expired or revoked subject token: get a new one and try once more.
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
      const text = await response.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* keep text */
      }
      const protocol = parseProtocolRange(
        body && typeof body === "object" && !Array.isArray(body)
          ? (body as Record<string, unknown>).protocol
          : undefined,
      );
      if (protocol) {
        const result = checkCompatibility(
          { version: PROTOCOL_VERSION, required: [...PROTOCOL_FEATURES] },
          protocol,
        );
        if (!result.ok) throw new IncompatibleRuntimeError(result);
      }
      throw new RuntimeError(426, body);
    }
    if (!response.ok) {
      const text = await response.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* keep text */
      }
      throw new RuntimeError(response.status, body);
    }
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
