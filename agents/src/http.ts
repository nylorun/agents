import {
  PROTOCOL_FEATURES,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  TENANT_HEADER,
  checkCompatibility,
  type Compatibility,
  type ProtocolRange,
} from "@nylorun/core/compatibility";

export interface Destination {
  url?: string;
  key?: string;
  tenant?: string;
  fetch?: typeof fetch;
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
  readonly key: string;
  readonly tenant: string;
  readonly fetcher: typeof fetch;
  /** Sent on every request, e.g. `Nylorun-Subject` and `Nylorun-Scopes` (`withHeaders`). */
  readonly headers: Readonly<Record<string, string>> = {};
  private readonly check: HostCheck = { compatible: false, features: [] };

  constructor(
    options: Destination = {},
    role: "server" | "executor" = "server",
  ) {
    const url = options.url ?? env("NYLORUN_RUNTIME_URL");
    const key =
      options.key ??
      env(role === "server" ? "NYLORUN_SERVER_KEY" : "NYLORUN_EXECUTOR_KEY");
    const tenant = options.tenant ?? env("NYLORUN_TENANT");
    if (!url || !key)
      throw new Error(
        `Set Runtime url and ${role} key explicitly or via NYLORUN_RUNTIME_URL / NYLORUN_${role.toUpperCase()}_KEY`,
      );
    if (!tenant)
      throw new Error("Set tenant explicitly or via NYLORUN_TENANT");
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol))
      throw new Error("Runtime requires an HTTP(S) URL");
    this.url = url.replace(/\/$/, "");
    this.key = key;
    this.tenant = tenant;
    this.fetcher = options.fetch ?? globalThis.fetch;
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

  private authHeaders(init: RequestInit = {}): Headers {
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(this.headers))
      headers.set(name, value);
    headers.set("Authorization", `Bearer ${this.key}`);
    headers.set(TENANT_HEADER, this.tenant);
    headers.set(PROTOCOL_HEADER, String(PROTOCOL_VERSION));
    if (init.body) headers.set("Content-Type", "application/json");
    return headers;
  }

  async request(
    path: string,
    init: RequestInit = {},
    options: { retried426?: boolean } = {},
  ): Promise<Response> {
    await this.ensureCompatible(
      init.signal === null ? undefined : init.signal,
    );
    const response = await this.fetcher(this.url + path, {
      ...init,
      headers: this.authHeaders(init),
      redirect: "error",
    });
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
