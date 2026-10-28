/**
 * The credential provider (v0.25 CP-E): a service outside the Runtime that holds a person's keys
 * and adds them to the requests their Agents' sandboxes send, so the Runtime never sees a value.
 * The Host's operator names it with `NYLORUN_CREDENTIAL_PROVIDER_URL` and
 * `NYLORUN_CREDENTIAL_PROVIDER_TOKEN` (Host feature `credential-provider`); without them nothing
 * here runs.
 *
 * Three calls, each with `Authorization: Bearer <token>`:
 * - `POST <url>/v1/hosts` `{ agentId, owner }` → `{ hosts: string[] }`: the hosts the owner's keys
 *   are bound to, each an exact host name or a `*.<suffix>` pattern (`*.googleapis.com`, v0.26
 *   TM-E1). A pattern matches as `network.allow`'s do: `run.googleapis.com` and
 *   `a.b.googleapis.com`, never `googleapis.com` itself. An IP literal or a malformed entry is
 *   dropped. egress-gate lets a pod Agent's sandbox reach them (inside the Tenant's egress
 *   ceiling), terminates TLS for them on 443 and hands each request on;
 * - `POST <url>/v1/environment` `{ agentId, owner }` → `{ variables: Entry[] }`: the variables each
 *   of a pod Agent's segments sets, under the vault's own (v0.26 TM-E2). An entry is a name (`"X"`,
 *   set to the stand-in `nylorun_managed`, as before v0.26), `{ name, standIn }` (set to that
 *   stand-in, shaped like the vendor's keys) or `{ name, value }` (set to that plain value, a
 *   setting beside a key and never a secret). A `standIn` or `value` is 1 to 1,024 printable
 *   characters, with no control character or line break; an entry with anything else, or a name
 *   a shell can't set, is dropped, and the first entry for a name wins;
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
import { ENVIRONMENT_SECRET_SENTINEL } from "@nylorun/core/contracts";
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

/** A stand-in or plain value: 1 to 1,024 printable characters, no control character or line break. */
const VALUE = /^[^\p{Cc}\p{Cs}\p{Zl}\p{Zp}]{1,1024}$/u;

/** One variable a pod Agent's segments set: its name and the value the sandbox sees. */
export interface ProviderVariable {
  readonly name: string;
  /** The stand-in (`nylorun_managed` unless the provider names another) or a plain value. */
  readonly value: string;
}

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
  /**
   * The variables `agentId`'s sessions set, each with its stand-in or plain value; none without
   * an owner.
   */
  environment(agentId: string, owner: string | undefined): Promise<readonly ProviderVariable[]>;
  /**
   * The hosts `owner`'s keys are bound to (lowercase): exact names and `*.<suffix>` patterns, to
   * match as `network.allow`'s do (`egressAllows`); none without an owner.
   */
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
  const cache = new Map<string, { readonly until: number; readonly value: readonly unknown[] }>();
  const pending = new Map<string, Promise<readonly unknown[]>>();
  /** The calls failing now: each is logged once, until one succeeds. */
  const failing = new Set<Call>();

  /** What a call answers: the list, and whether it failed. */
  type Answer = { readonly ok: boolean; readonly value: readonly unknown[] };

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
    return { ok: true, value: call === "hosts" ? hostsOf(list) : variablesOf(list) };
  }

  function answer(call: Call, agentId: string, owner: string | undefined): Promise<readonly unknown[]> {
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
    environment: (agentId, owner) => answer("environment", agentId, owner) as Promise<readonly ProviderVariable[]>,
    hosts: (agentId, owner) => answer("hosts", agentId, owner) as Promise<readonly string[]>,
    forwardUrl: (path) => new URL(`${url}/v1/forward${path.startsWith("/") ? path : `/${path}`}`),
    forwardHeaders: ({ host, agentId, owner }) => ({
      [PROVIDER_HEADERS.host]: host,
      [PROVIDER_HEADERS.agent]: agentId,
      [PROVIDER_HEADERS.owner]: owner,
      [PROVIDER_HEADERS.token]: settings.token,
    }),
  };
}

/**
 * The hosts of a `/v1/hosts` answer: exact host names and `*.<suffix>` patterns, lowercase, without
 * a trailing root dot, once each; an IP literal or a malformed entry is dropped.
 */
function hostsOf(list: readonly unknown[]): readonly string[] {
  const items = list.filter((item): item is string => typeof item === "string").slice(0, ANSWER_MAX);
  return [...new Set(items.map((host) => host.toLowerCase().replace(/\.$/, "")).filter(isSandboxHostPattern))];
}

/**
 * The variables of a `/v1/environment` answer, each with the value the sandbox sees: a bare name is
 * the stand-in `nylorun_managed`, `{ name, standIn }` that stand-in, `{ name, value }` that value.
 * Any other entry is dropped, and the first entry for a name wins.
 */
function variablesOf(list: readonly unknown[]): readonly ProviderVariable[] {
  const variables = new Map<string, ProviderVariable>();
  for (const item of list) {
    if (variables.size >= ANSWER_MAX) break;
    const variable = variableOf(item);
    if (variable && !variables.has(variable.name)) variables.set(variable.name, variable);
  }
  return [...variables.values()];
}

function variableOf(item: unknown): ProviderVariable | undefined {
  if (typeof item === "string") return VARIABLE.test(item) ? { name: item, value: ENVIRONMENT_SECRET_SENTINEL } : undefined;
  if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
  const { name, standIn, value } = item as Record<string, unknown>;
  if (typeof name !== "string" || !VARIABLE.test(name)) return undefined;
  // Exactly one of the two: an entry naming both, or neither, is not one the engine can read.
  if ((standIn === undefined) === (value === undefined)) return undefined;
  const set = standIn ?? value;
  return typeof set === "string" && VALUE.test(set) ? { name, value: set } : undefined;
}
