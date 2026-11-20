/**
 * The Tenant's stream as the API writes and reads it (ADR-159): who a request acts as on the
 * stream, and its audit read, `GET /v1/tenant/audit`, newest first. The record module writes the
 * events (`record/tenant.ts`), each in the transaction of the change it records.
 */
import { TENANT_EVENT_TYPES, type TenantAuditPage } from "@nylorun/core/contracts";
import { canonical } from "../store/canonical.js";
import type { TenantEventActor } from "../store/types.js";
import type { AuthScope, TenantContext } from "./context.js";
import { fail } from "./http.js";

/**
 * Who a request acts as, from its credential (never its body): the key's name (`bootstrap`,
 * `studio`, an application key's), `<key>:<subject>` for a key acting for a person, or
 * `<issuer>:<subject>` for a trusted issuer's token.
 */
export function principalOf(scope: AuthScope): string {
  if (scope.kind === "token") return `${scope.issuer}:${scope.subject}`;
  if (scope.kind === "subject") return `${scope.principalId}:${scope.subject}`;
  return "principalId" in scope ? scope.principalId : "anonymous";
}

/** A request's Tenant events: its principal, written through the API. */
export function apiActor(scope: AuthScope): TenantEventActor {
  return { principal: principalOf(scope), source: "api" };
}

/** What `GET /v1/tenant/audit` reads: the filters, a page size and where the page before ended. */
export interface TenantAuditQuery {
  readonly limit: number;
  readonly cursor?: string;
  readonly types?: readonly string[];
  readonly since?: string;
  readonly until?: string;
}

/**
 * A page cursor: the last seq of the page before and the filters it was read with, opaque to the
 * client; a cursor read with other filters is refused.
 */
const cursor = {
  encode: (seq: number, filters: object) =>
    Buffer.from(JSON.stringify({ before: seq, filters: canonical(filters) })).toString("base64url"),
  decode: (value: string, filters: object): number => {
    try {
      const read = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { before?: unknown; filters?: unknown };
      if (Number.isSafeInteger(read.before) && read.filters === canonical(filters)) return read.before as number;
    } catch {}
    return fail(400, "Invalid audit cursor", { code: "invalid_request" });
  },
};

/** The `types`, `since` and `until` of an audit read, checked. */
export function auditFilters(query: {
  types?: string | undefined;
  since?: string | undefined;
  until?: string | undefined;
}): Pick<TenantAuditQuery, "types" | "since" | "until"> {
  const types = query.types
    ?.split(",")
    .map((type) => type.trim())
    .filter(Boolean);
  const unknown = types?.find((type) => !(TENANT_EVENT_TYPES as readonly string[]).includes(type));
  if (unknown !== undefined) fail(400, `types: ${unknown} is not a Tenant event type`, { code: "invalid_request" });
  const time = (name: "since" | "until") => {
    const value = query[name];
    if (value === undefined) return undefined;
    const at = Date.parse(value);
    if (!Number.isFinite(at)) fail(400, `${name} must be an ISO time`, { code: "invalid_request" });
    return new Date(at).toISOString();
  };
  const since = time("since");
  const until = time("until");
  return {
    ...(types === undefined || types.length === 0 ? {} : { types: [...new Set(types)].sort() }),
    ...(since === undefined ? {} : { since }),
    ...(until === undefined ? {} : { until }),
  };
}

/** A page of the Tenant's events, newest first; `nextCursor` reads the older ones. */
export async function readTenantAudit(ctx: TenantContext, query: TenantAuditQuery): Promise<TenantAuditPage> {
  const filters = {
    ...(query.types === undefined ? {} : { types: query.types }),
    ...(query.since === undefined ? {} : { since: query.since }),
    ...(query.until === undefined ? {} : { until: query.until }),
  };
  const beforeSeq = query.cursor === undefined ? undefined : cursor.decode(query.cursor, filters);
  // One more than the page, to learn whether another follows.
  const events = await ctx.store.tx((t) =>
    t.tenantEvents({ ...filters, limit: query.limit + 1, ...(beforeSeq === undefined ? {} : { beforeSeq }) }),
  );
  const page = events.slice(0, query.limit);
  const more = events.length > query.limit;
  return { events: page, nextCursor: more ? cursor.encode(page.at(-1)!.seq, filters) : null };
}
