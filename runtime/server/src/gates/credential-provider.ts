/**
 * The credential provider (v0.25 CP-E): a service outside the Runtime that holds a person's keys
 * and adds them to the requests their Agents' sandboxes send, so the Runtime never sees a value.
 * The Host's operator names it with `NYLORUN_CREDENTIAL_PROVIDER_URL` and
 * `NYLORUN_CREDENTIAL_PROVIDER_TOKEN` (Host feature `credential-provider`); without them nothing
 * here runs.
 *
 * Three calls, each with `Authorization: Bearer <token>`:
 * - `POST <url>/v1/hosts` `{ agentId, owner }` → `{ hosts: string[] }`: the exact host names the
 *   owner's keys are bound to. egress-gate lets a pod Agent's sandbox reach them (inside the
 *   Tenant's egress ceiling), terminates TLS for them on 443 and hands each request on;
 * - `POST <url>/v1/environment` `{ agentId, owner }` → `{ variables: string[] }`: the variables
 *   each of a pod Agent's segments sets to the stand-in `nylorun_managed`, under the vault's own;
 * - `ANY <url>/v1/forward/<path and query>`: one request of the sandbox's, with its headers as it
 *   sent them (its own `Authorization` or inject header included, which the provider replaces),
 *   plus `nylorun-provider-host`, `-agent`, `-owner` and, in place of a bearer the sandbox's own
 *   `Authorization` would clash with, `nylorun-provider-token`. The provider sends it on to
 *   `https://<host>/<path>` and streams the answer back (`egress-credentials.ts`).
 *
 * Only an Agent with an owner (its owner guard) is asked about; one without gets nothing and no
 * call. An answer is kept per Agent and owner for `credentialProvider.cacheMs` (15 s). A call
 * that fails (unreachable, slow past `timeoutMs`, a non-2xx answer, a body of another shape)
 * answers nothing, kept for `retryMs`, so the gate refuses what it refused before; it is logged
 * once until a call succeeds again. The token is never logged.
 */
import { isSandboxHostPattern } from "@nylorun/core/define";
import type { Logger } from "../tenant/types.js";
import { hostTuning } from "../tuning.js";

/** The headers the engine adds to a request it hands to the provider's forward route. */
export const PROVIDER_HEADERS = {
  /** The host the sandbox addressed, e.g. `api.vercel.com`. */
  host: "nylorun-provider-host",
  /** The Agent (the egress sandbox) the request comes from. */
  agent: "nylorun-provider-agent",
  /** The Agent's owner, e.g. `u:<org>:<user>`. */
  owner: "nylorun-provider-owner",
  /** The provider's token: the sandbox's own `Authorization` header is left as it sent it. */
  token: "nylorun-provider-token",
} as const;

/** Every header of this prefix a sandbox sends is dropped before the engine sets its own. */
export const PROVIDER_HEADER_PREFIX = "nylorun-provider-";

/** The most host names, or variables, one answer may hold; the rest are ignored. */
const ANSWER_MAX = 256;

/** A variable name a shell can set. */
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Where the provider is and its token (`StackConfig.credentialProvider`). */
export interface CredentialProviderSettings {
  /** `NYLORUN_CREDENTIAL_PROVIDER_URL`, without a trailing slash. */
  readonly url: string;
  /** `NYLORUN_CREDENTIAL_PROVIDER_TOKEN`. */
  readonly token: string;
}

export interface CredentialProvider {
  /** The provider's base URL, without a trailing slash. */
  readonly url: string;
  /** The variables to set to the stand-in for `agentId`'s sessions; none without an owner. */
  environment(agentId: string, owner: string | undefined): Promise<readonly string[]>;
  /** The exact host names `owner`'s keys are bound to (lowercase); none without an owner. */
  hosts(agentId: string, owner: string | undefined): Promise<readonly string[]>;
  /** Where one request to `path` (origin form, `/v2/projects?x=1`) is handed. */
  forwardUrl(path: string): URL;
  /** The headers that go with it, the provider's token among them. */
  forwardHeaders(at: { readonly host: string; readonly agentId: string; readonly owner: string }): Record<string, string>;
}

type Call = "hosts" | "environment";

export function createCredentialProvider(
  settings: CredentialProviderSettings,
  options: {
    readonly logger: Logger;
    /** Tests replace the HTTP client. */
    readonly fetch?: typeof fetch;
  },
): CredentialProvider {
  const url = settings.url.replace(/\/+$/, "");
  const { logger } = options;
  const fetchImpl = options.fetch ?? fetch;
  const cache = new Map<string, { readonly until: number; readonly value: readonly string[] }>();
  const pending = new Map<string, Promise<readonly string[]>>();
  /** The calls failing now: each is logged once, until one succeeds. */
  const failing = new Set<Call>();

  /** What a call answers: the list, and whether it failed. */
  type Answer = { readonly ok: boolean; readonly value: readonly string[] };

  function fail(call: Call, agentId: string, reason: string, fields: Record<string, unknown> = {}): Answer {
    if (!failing.has(call)) {
      failing.add(call);
      logger.warn("credential_provider_failed", { call, agentId, reason, ...fields });
    }
    return { ok: false, value: [] };
  }

  async function ask(call: Call, agentId: string, owner: string): Promise<Answer> {
    let response: Response;
    try {
      response = await fetchImpl(`${url}/v1/${call}`, {
        method: "POST",
        headers: { authorization: `Bearer ${settings.token}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ agentId, owner }),
        signal: AbortSignal.timeout(hostTuning().credentialProvider.timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "Error";
      return fail(call, agentId, name === "TimeoutError" ? "timeout" : "unreachable", {
        code: (error as { cause?: { code?: unknown } })?.cause?.code ?? name,
      });
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return fail(call, agentId, "status", { status: response.status });
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return fail(call, agentId, "not_json");
    }
    const list = (body as Record<string, unknown> | null)?.[call === "hosts" ? "hosts" : "variables"];
    if (!Array.isArray(list)) return fail(call, agentId, "shape");
    if (failing.delete(call)) logger.info("credential_provider_recovered", { call });
    const items = list.filter((item): item is string => typeof item === "string").slice(0, ANSWER_MAX);
    const value =
      call === "hosts"
        ? [...new Set(items.map((host) => host.toLowerCase().replace(/\.$/, "")).filter(isExactHost))]
        : [...new Set(items.filter((name) => VARIABLE.test(name)))];
    return { ok: true, value };
  }

  function answer(call: Call, agentId: string, owner: string | undefined): Promise<readonly string[]> {
    if (owner === undefined || owner === "") return Promise.resolve([]);
    const key = `${call}\u0000${agentId}\u0000${owner}`;
    const cached = cache.get(key);
    if (cached && Date.now() < cached.until) return Promise.resolve(cached.value);
    const inFlight = pending.get(key);
    if (inFlight) return inFlight;
    const tuning = hostTuning().credentialProvider;
    const asked = ask(call, agentId, owner)
      .catch(() => fail(call, agentId, "failed"))
      .then(({ ok, value }) => {
        // A failure is kept for `retryMs`, an answer for `cacheMs`.
        const ttl = ok ? tuning.cacheMs : tuning.retryMs;
        cache.delete(key);
        cache.set(key, { until: Date.now() + ttl, value });
        if (cache.size > tuning.cacheEntries) cache.delete(cache.keys().next().value!);
        return value;
      })
      .finally(() => pending.delete(key));
    pending.set(key, asked);
    return asked;
  }

  return {
    url,
    environment: (agentId, owner) => answer("environment", agentId, owner),
    hosts: (agentId, owner) => answer("hosts", agentId, owner),
    forwardUrl: (path) => new URL(`${url}/v1/forward${path.startsWith("/") ? path : `/${path}`}`),
    forwardHeaders: ({ host, agentId, owner }) => ({
      [PROVIDER_HEADERS.host]: host,
      [PROVIDER_HEADERS.agent]: agentId,
      [PROVIDER_HEADERS.owner]: owner,
      [PROVIDER_HEADERS.token]: settings.token,
    }),
  };
}

/** An exact host name (no `*.` pattern, no IP literal), as egress-gate serves. */
function isExactHost(host: string): boolean {
  return !host.startsWith("*.") && isSandboxHostPattern(host);
}
