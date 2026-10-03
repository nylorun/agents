/**
 * The sandboxes service's client (F7.2, D32): the Go service (`sandboxes/`) that alone holds
 * the cluster credentials and drives agent-sandbox Sandboxes in the Tenant's namespace. Core
 * reaches it at `NYLORUN_SANDBOXES_URL` with `NYLORUN_SANDBOXES_TOKEN`; nothing else does.
 *
 * Pull, not push: the service never calls core. Core reads a Sandbox's status when it
 * reconciles (`GET /v1/pods/{name}`, optionally blocking with `?wait=`), and every change it
 * asks for carries an operation id, so a retried `PUT` is a no-op.
 */

/** `PUT /v1/pods/{name}`: the Sandbox the service applies (`driver.Spec` in Go). */
export interface PodSpec {
  readonly opId: string;
  readonly mode: "Running" | "Suspended";
  /** The workload image; the service defaults it to `python:3.13-slim`. */
  readonly image?: string;
  /** The Runtime image the engine is copied from. */
  readonly harnessImage?: string;
  /** Replaces the engine command (diagnostics). */
  readonly command?: readonly string[];
  readonly cpus?: number;
  readonly memoryMiB?: number;
  readonly storageGiB?: number;
  readonly stopGraceSeconds?: number;
  /** RFC 3339: the Sandbox expires then (agent-sandbox `shutdownTime`). */
  readonly shutdownTime?: string;
  readonly shutdownPolicy?: "Retain" | "Delete";
  readonly env?: Readonly<Record<string, string>>;
  /** Written to the Sandbox's join Secret before it is applied. */
  readonly joinToken?: string;
}

/** A Sandbox as the service's informers see it (`driver.Status` in Go). */
export interface PodStatus {
  readonly name: string;
  readonly exists: boolean;
  readonly deleting: boolean;
  readonly mode?: string;
  readonly ready: boolean;
  readonly suspended: boolean;
  readonly expired: boolean;
  readonly podUID?: string;
  readonly podPhase?: string;
  readonly volume: "present" | "missing";
  readonly opId?: string;
  readonly shutdownTime?: string;
  readonly reason?: string;
  readonly message?: string;
  /** With `?wait=`: whether the state was reached before the timeout. */
  readonly met?: boolean;
}

/** `GET /v1/info`: the cluster `nylorun sandbox enable` recorded. */
export interface ClusterInfo {
  readonly namespace: string;
  readonly context: string;
  readonly controllerVersion?: string;
  readonly apiVersion?: string;
  readonly hostAddress?: string;
  readonly ports?: Readonly<Record<string, number>>;
  readonly networkPolicy?: { readonly enforced: boolean; readonly probedAt?: string };
}

export type PodWait = "ready" | "suspended" | "expired" | "gone";

export interface SandboxesClient {
  /** Whether the service is up and its informers synced (`GET /ready`). Never throws. */
  ready(signal?: AbortSignal): Promise<boolean>;
  info(signal?: AbortSignal): Promise<ClusterInfo>;
  put(name: string, spec: PodSpec, signal?: AbortSignal): Promise<PodStatus>;
  status(
    name: string,
    options?: { wait?: PodWait; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<PodStatus>;
  delete(name: string, opId: string, signal?: AbortSignal): Promise<PodStatus>;
}

/** The service refused a request, or did not answer. */
export class SandboxesError extends Error {
  override readonly name = "SandboxesError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The sandboxes service over HTTP. */
export function httpSandboxesClient(options: {
  readonly url: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
  /** Per request, unless the request waits longer. Default 20 s. */
  readonly timeoutMs?: number;
}): SandboxesClient {
  const base = options.url.replace(/\/+$/, "");
  const call = options.fetch ?? fetch;
  const request = async <T>(
    method: string,
    path: string,
    init: { body?: unknown; signal?: AbortSignal; timeoutMs?: number; auth?: boolean } = {},
  ): Promise<T> => {
    const timeout = AbortSignal.timeout(init.timeoutMs ?? options.timeoutMs ?? 20_000);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await call(`${base}${path}`, {
        method,
        headers: {
          ...(init.auth === false ? {} : { authorization: `Bearer ${options.token}` }),
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal,
      });
    } catch (error) {
      throw new SandboxesError(
        0,
        "unreachable",
        `The sandboxes service did not answer: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const text = await response.text();
    let body: unknown;
    try {
      body = text === "" ? undefined : JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      const error = (body as { error?: { code?: string; message?: string } } | undefined)?.error;
      throw new SandboxesError(
        response.status,
        error?.code ?? "error",
        error?.message ?? `The sandboxes service answered ${response.status}`,
      );
    }
    return body as T;
  };
  const pod = (name: string) => `/v1/pods/${encodeURIComponent(name)}`;
  return {
    async ready(signal) {
      try {
        await request("GET", "/ready", { auth: false, timeoutMs: 3_000, ...(signal ? { signal } : {}) });
        return true;
      } catch {
        return false;
      }
    },
    info: (signal) => request("GET", "/v1/info", signal ? { signal } : {}),
    put: (name, spec, signal) => request("PUT", pod(name), { body: spec, ...(signal ? { signal } : {}) }),
    status(name, { wait, timeoutMs, signal } = {}) {
      const query = wait ? `?wait=${wait}&timeoutMs=${Math.min(timeoutMs ?? 30_000, 30_000)}` : "";
      return request("GET", `${pod(name)}${query}`, {
        ...(signal ? { signal } : {}),
        ...(wait ? { timeoutMs: Math.min(timeoutMs ?? 30_000, 30_000) + 10_000 } : {}),
      });
    },
    delete: (name, opId, signal) =>
      request("DELETE", `${pod(name)}?opId=${encodeURIComponent(opId)}`, signal ? { signal } : {}),
  };
}
