/**
 * The keys provider's decide route (ADR-142): on Agent Substrate, Substrate's egress adds a
 * sandbox's keys, and the keys provider beside it asks the Tenant here, for every keyed request,
 * what to add. It is served on egress-gate's listener (the gateway's `--service egress`, 4200),
 * which the sandboxes service's edge forwards its keys port to; no actor's egress policy allows
 * that port.
 *
 * `POST /nylorun/v1/egress/decide` with `Authorization: Bearer <NYLORUN_EGRESS_KEYS_TOKEN>` and
 * `{ actor, sandboxId, host }`, where `actor` is the actor's name as Substrate's egress verified it
 * and `sandboxId` and `host` come from the reference in the actor's rule
 * (`ate-secret://keys.nylorun.dev/<sandboxId>/<host>`). In order:
 *
 * 1. the sandbox is a live pod whose current incarnation is `actor` (its `k8sName`), else 403:
 *    one actor can never use another sandbox's reference;
 * 2. an `environment_secret` of its Environment bound to `host` wins, as on egress-gate: the vault
 *    releases it (one read, audited, unsealed by keys) and `200 { value }` carries the whole header
 *    value; a refusal is 403;
 * 3. a host the outside credential source lists for the Agent's owner, inside the Tenant's egress
 *    ceiling, is allowed: `200 { fetch: { agentId, owner, host } }`, and the keys provider asks the
 *    source for the value. The Runtime never sees a person's key (ADR-82 §3, D49);
 * 4. else `404 not_found`.
 *
 * Without the token setting the route is off (404). Every decision is logged, never a value.
 */
import { timingSafeEqual, createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isSandboxHostPattern } from "@nylorun/core/define";
import type { Logger } from "../tenant/types.js";
import { withinCeiling } from "../sandbox/resolve.js";
import type { CredentialProvider } from "./credential-provider.js";
import type { EgressCredentialRelease } from "./egress-credentials.js";
import { egressAllows } from "./egress.js";

/** The route's path. */
export const EGRESS_DECIDE_PATH = "/nylorun/v1/egress/decide";

/** The largest body the route reads. */
const MAX_BODY = 4096;

/** What the route reads of a sandbox: its incarnation, owner and the Tenant's egress ceiling. */
export interface DecideSandboxes {
  live(sandboxId: string): Promise<
    | {
        /** The current incarnation's name: the actor's name on Agent Substrate. */
        readonly name?: string;
        readonly owner?: string;
        readonly ceiling?: readonly string[];
      }
    | undefined
  >;
}

export interface EgressDecideOptions {
  /** NYLORUN_EGRESS_KEYS_TOKEN; none: the route is off. */
  readonly token?: string;
  readonly sandboxes: DecideSandboxes;
  /** The vault's release of an `environment_secret` bound to a host (as egress-gate's). */
  release(sandboxId: string, host: string): Promise<EgressCredentialRelease>;
  /** The outside credential source, for a person's keys. */
  readonly provider?: CredentialProvider;
  readonly logger: Logger;
}

export type Decision =
  | { readonly status: 200; readonly body: { readonly value: string } | { readonly fetch: { readonly agentId: string; readonly owner: string; readonly host: string } }; readonly outcome: string; readonly credentialId?: string }
  | { readonly status: 400 | 403 | 404 | 503; readonly code: string; readonly outcome: string };

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** The decision for one keyed request (steps 1–4 above). */
export async function decide(
  options: Omit<EgressDecideOptions, "token" | "logger">,
  input: { readonly actor: string; readonly sandboxId: string; readonly host: string },
): Promise<Decision> {
  const sandbox = await options.sandboxes.live(input.sandboxId);
  if (!sandbox || sandbox.name === undefined || sandbox.name !== input.actor)
    return { status: 403, code: "permission_denied", outcome: "not_this_sandbox" };
  const released = await options.release(input.sandboxId, input.host);
  if (released.status === "released")
    return { status: 200, body: { value: released.value }, outcome: "vault", credentialId: released.credentialId };
  if (released.status === "refused") return { status: 403, code: "permission_denied", outcome: `vault_${released.reason}` };
  const { provider } = options;
  if (provider && sandbox.owner !== undefined) {
    const hosts = await provider.hosts(input.sandboxId, sandbox.owner);
    const listed = hosts.includes(input.host) || egressAllows(input.host, hosts);
    if (listed && sandbox.ceiling && !withinCeiling(input.host, sandbox.ceiling))
      return { status: 403, code: "permission_denied", outcome: "outside_ceiling" };
    if (listed)
      return {
        status: 200,
        body: { fetch: { agentId: input.sandboxId, owner: sandbox.owner, host: input.host } },
        outcome: "outside",
      };
  }
  return { status: 404, code: "not_found", outcome: "no_key" };
}

/**
 * The route's handler: `true` when it answered `req`, `false` for any other request, which the
 * caller answers as before.
 */
export function egressDecideHandler(options: EgressDecideOptions): (req: IncomingMessage, res: ServerResponse) => boolean {
  const want = options.token ? digest(options.token) : undefined;
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  return (req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== EGRESS_DECIDE_PATH) return false;
    if (!want) {
      send(res, 404, { error: { code: "not_found", message: "keys at Substrate's egress are off" } });
      return true;
    }
    if (req.method !== "POST") {
      send(res, 405, { error: { code: "method_not_allowed", message: "POST only" } });
      return true;
    }
    const presented = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    if (!presented || !timingSafeEqual(digest(presented), want)) {
      options.logger.warn("egress_decide_refused", { reason: "token" });
      send(res, 401, { error: { code: "unauthorized", message: "missing or wrong token" } });
      return true;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
    });
    req.on("end", () => {
      void (async () => {
        let input: { actor: string; sandboxId: string; host: string } | undefined;
        try {
          const body = size <= MAX_BODY ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : undefined;
          if (
            body &&
            typeof body.actor === "string" &&
            typeof body.sandboxId === "string" &&
            typeof body.host === "string" &&
            body.actor !== "" &&
            body.sandboxId !== "" &&
            isSandboxHostPattern(body.host)
          )
            input = { actor: body.actor, sandboxId: body.sandboxId, host: body.host.toLowerCase() };
        } catch {
          input = undefined;
        }
        if (!input) {
          send(res, 400, { error: { code: "invalid_request", message: "the body is {actor, sandboxId, host}" } });
          return;
        }
        let decision: Decision;
        try {
          decision = await decide(options, input);
        } catch (error) {
          options.logger.warn("egress_decide_failed", {
            sandboxId: input.sandboxId,
            host: input.host,
            error: error instanceof Error ? error.message : String(error),
          });
          send(res, 503, { error: { code: "unavailable", message: "the decision failed; retry" } });
          return;
        }
        const fields = {
          sandboxId: input.sandboxId,
          host: input.host,
          outcome: decision.outcome,
          ...("credentialId" in decision && decision.credentialId ? { credentialId: decision.credentialId } : {}),
        };
        if (decision.status === 200) {
          options.logger.info("egress_decided", fields);
          send(res, 200, decision.body);
        } else {
          options.logger.warn("egress_decide_refused", fields);
          send(res, decision.status, { error: { code: decision.code, message: decision.outcome } });
        }
      })();
    });
    return true;
  };
}
