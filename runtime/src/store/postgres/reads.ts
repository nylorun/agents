import { z } from "zod";
/** Drizzle read projections on a separate, read-only Tenant pool. */
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import type {
  ModelCall,
  SandboxView,
  SessionListItem,
  SessionManifestView,
  SessionUsageTotals,
} from "@nylorun/core/contracts";
import type { ReadAccess, ReadStore } from "../../reads/types.js";
import { readCursor } from "../../reads/cursor.js";
import { fail } from "../../tenant/http.js";
import { sandboxWorkspaceKey } from "../../sandbox/records.js";
import { database, driverError, type Transaction } from "./db.js";
import { createPostgresReadClient, type PostgresClient } from "./connect.js";
import {
  modelUsage,
  sandboxResources,
  sandboxes,
  sessions,
  sessionEvents,
  type ModelUsageRow,
} from "./schema.js";

const sessionFields = {
  id: sessions.id,
  agentId: sessions.agentId,
  ownerUserId: sessions.ownerUserId,
  status: sessions.status,
  activeTurnId: sql<string | null>`${sessions.body}->>'activeTurnId'`,
  lastTurnId: sql<string | null>`${sessions.body}->>'lastTurnId'`,
  sandboxId: sessions.sandboxId,
  createdAt: sessions.createdAt,
};
function accessWhere(access: ReadAccess): SQL | undefined {
  return and(
    access.owner === undefined ? undefined : eq(sessions.ownerUserId, access.owner),
    access.agents === undefined ? undefined : inArray(sessions.agentId, [...access.agents]),
  );
}
function publicCall(row: ModelUsageRow): ModelCall {
  return {
    id: row.id,
    sessionId: row.sessionId,
    turnId: row.turnId,
    agentId: row.agentId,
    provider: row.provider,
    model: row.model,
    at: row.createdAt,
    outcome: "completed",
    usage: {
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      totalTokens: row.totalTokens,
      cachedTokens: row.cachedTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      reasoningTokens: row.reasoningTokens,
      costUsd: row.costUsd,
      duplicate: row.duplicate,
      tokensReported: row.tokensReported,
      costKnown: row.costKnown,
    },
  };
}
function keyOf(
  key: (string | null)[] | undefined,
  length: number,
  timestamp = false,
  nullable = false,
): (string | null)[] | undefined {
  if (
    key &&
    (key.length !== length ||
      key.at(-1) === "" ||
      key.some((v, i) => v === null && !(nullable && i === 0)))
  )
    fail(400, "Invalid cursor key", { code: "cursor_invalid" });
  if (
    key &&
    timestamp &&
    key[0] !== null &&
    !z.iso
      .datetime({ offset: true })
      .safeParse(key[0]!.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00")).success
  )
    fail(400, "Invalid cursor timestamp", { code: "cursor_invalid" });
  return key;
}
export function createPostgresReadStore(source: PostgresClient, tenantId: string): ReadStore {
  const pool = createPostgresReadClient(source);
  const db = database(pool);
  const latestEvent = db
    .select({ at: sessionEvents.committedAt })
    .from(sessionEvents)
    .where(eq(sessionEvents.sessionId, sessions.id))
    .orderBy(desc(sessionEvents.seq))
    .limit(1);
  const fields = { ...sessionFields, lastEventAt: sql<string | null>`(${latestEvent})` };
  const read = <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> =>
    db.transaction(fn, { accessMode: "read only" }).catch((error: unknown) => {
      const cause = driverError(error);
      if (cause && typeof cause === "object" && "code" in cause && cause.code === "57014")
        fail(503, "Read timed out", { code: "read_timeout" });
      throw cause;
    });
  async function requireSession(tx: Transaction, id: string, access: ReadAccess) {
    const [row] = await tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.id, id), accessWhere(access)))
      .limit(1);
    if (!row) return fail(404, "Session not found");
    return row.id;
  }
  return {
    close: () => pool.end({ timeout: 2 }),
    sessions: (filters, page, access) =>
      read(async (tx) => {
        const cursor = readCursor(tenantId, "sessions", filters);
        const key = keyOf(cursor.decode(page.cursor), 2, true, true);
        const position = !key
          ? undefined
          : key[0] === null
            ? and(isNull(sessions.createdAt), lt(sessions.id, key[1]!))
            : or(
                lt(sessions.createdAt, key[0]!),
                and(eq(sessions.createdAt, key[0]!), lt(sessions.id, key[1]!)),
                isNull(sessions.createdAt),
              );
        const rows = await tx
          .select(fields)
          .from(sessions)
          .where(
            and(
              accessWhere(access),
              position,
              filters.agentId === undefined ? undefined : eq(sessions.agentId, filters.agentId),
              filters.status === undefined ? undefined : eq(sessions.status, filters.status),
              filters.sandboxId === undefined
                ? undefined
                : eq(sessions.sandboxId, filters.sandboxId),
              filters.ownerUserId === undefined
                ? undefined
                : eq(sessions.ownerUserId, filters.ownerUserId),
            ),
          )
          .orderBy(sql`${sessions.createdAt} desc nulls last`, desc(sessions.id))
          .limit(page.limit + 1);
        const items = rows.slice(0, page.limit).map((r) => ({
          ...r,
          createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
          lastEventAt: r.lastEventAt ? new Date(r.lastEventAt).toISOString() : null,
        })) as SessionListItem[];
        const last = rows.slice(0, page.limit).at(-1);
        return {
          sessions: items,
          nextCursor:
            rows.length > page.limit && last ? cursor.encode([last.createdAt, last.id]) : null,
        };
      }),
    manifest: (id, access) =>
      read(async (tx) => {
        const [row] = await tx
          .select({
            sessionId: sessions.id,
            agentId: sessions.agentId,
            manifestHash: sql<string>`${sessions.body}->>'manifestHash'`,
            implementationVersion: sql<string>`${sessions.body}->>'implementationVersion'`,
            manifest: sql<Record<string, unknown>>`${sessions.body}->'manifest'`,
          })
          .from(sessions)
          .where(and(eq(sessions.id, id), accessWhere(access)))
          .limit(1);
        if (!row) return fail(404, "Session not found");
        return row as SessionManifestView;
      }),
    usage: (id, turnId, access) =>
      read(async (tx) => {
        await requireSession(tx, id, access);
        const sum = (column: SQLWrapper) =>
          sql<number>`coalesce(sum(${column}), 0)`.mapWith(Number);
        const sums = {
          inputTokens: sum(modelUsage.inputTokens),
          outputTokens: sum(modelUsage.outputTokens),
          totalTokens: sum(modelUsage.totalTokens),
          cachedTokens: sum(modelUsage.cachedTokens),
          cacheWriteTokens: sum(modelUsage.cacheWriteTokens),
          reasoningTokens: sum(modelUsage.reasoningTokens),
          costUsd: sum(modelUsage.costUsd),
        };
        const [totals] = await tx
          .select({
            ...sums,
            calls: sql<number>`count(*)`.mapWith(Number),
            duplicates: sql<number>`count(*) filter (where ${modelUsage.duplicate})`.mapWith(
              Number,
            ),
            unpricedCalls:
              sql<number>`count(*) filter (where ${modelUsage.costKnown} = false)`.mapWith(Number),
            unreportedCalls:
              sql<number>`count(*) filter (where ${modelUsage.tokensReported} = false)`.mapWith(
                Number,
              ),
            unknownQualityCalls:
              sql<number>`count(*) filter (where ${modelUsage.tokensReported} is null or ${modelUsage.costKnown} is null)`.mapWith(
                Number,
              ),
          })
          .from(modelUsage)
          .where(
            and(
              eq(modelUsage.sessionId, id),
              turnId === undefined ? undefined : eq(modelUsage.turnId, turnId),
            ),
          );
        return {
          ...totals,
          sessionId: id,
          turnId: turnId ?? null,
          asOf: new Date().toISOString(),
        } as SessionUsageTotals;
      }),
    modelCalls: (id, turnId, page, access) =>
      read(async (tx) => {
        await requireSession(tx, id, access);
        const cursor = readCursor(tenantId, "model-calls", { sessionId: id, turnId });
        const key = keyOf(cursor.decode(page.cursor), 2, true);
        const rows = await tx
          .select()
          .from(modelUsage)
          .where(
            and(
              eq(modelUsage.sessionId, id),
              turnId === undefined ? undefined : eq(modelUsage.turnId, turnId),
              key
                ? sql`(${modelUsage.createdAt}, ${modelUsage.id}) > (${key[0]}, ${key[1]})`
                : undefined,
            ),
          )
          .orderBy(asc(modelUsage.createdAt), asc(modelUsage.id))
          .limit(page.limit + 1);
        const items = rows.slice(0, page.limit);
        const last = items.at(-1);
        return {
          calls: items.map(publicCall),
          nextCursor:
            rows.length > page.limit && last ? cursor.encode([last.createdAt, last.id]) : null,
          asOf: new Date().toISOString(),
        };
      }),
    exportModel: (after, limit) =>
      read(async (tx) => {
        const cursor = readCursor(tenantId, "model-export", {});
        const key = keyOf(cursor.decode(after), 2);
        if (
          key &&
          (key[0] === null || !/^\d+$/.test(key[0]) || BigInt(key[0]) > 18446744073709551615n)
        )
          fail(400, "Invalid export cursor", { code: "cursor_invalid" });
        const rows = await tx
          .select()
          .from(modelUsage)
          .where(
            and(
              sql`${modelUsage.txid} < pg_snapshot_xmin(pg_current_snapshot())`,
              key
                ? sql`(${modelUsage.txid}, ${modelUsage.id}) > (${key[0]}::xid8, ${key[1]})`
                : undefined,
            ),
          )
          .orderBy(asc(modelUsage.txid), asc(modelUsage.id))
          .limit(limit + 1);
        const items = rows.slice(0, limit);
        const last = items.at(-1);
        return {
          calls: items.map(publicCall),
          next: last ? cursor.encode([last.txid, last.id]) : (after ?? null),
          caughtUp: rows.length <= limit,
          asOf: new Date().toISOString(),
        };
      }),
    sandboxes: (labels, page, access, grants) =>
      read(async (tx) => {
        const cursor = readCursor(tenantId, "sandboxes", labels);
        const key = keyOf(cursor.decode(page.cursor), 1);
        const allowed =
          grants === undefined
            ? undefined
            : or(
                ...grants.map((grant) =>
                  grant.endsWith("/*")
                    ? sql`starts_with(${sandboxResources.id}, ${grant.slice(0, -1)})`
                    : eq(sandboxResources.id, grant),
                ),
              );
        const rows = await tx
          .select()
          .from(sandboxResources)
          .where(
            and(
              grants?.length === 0 ? sql`false` : allowed,
              key ? gt(sandboxResources.id, key[0]!) : undefined,
              or(isNull(sandboxResources.desired), ne(sandboxResources.desired, "deleted")),
              ...Object.entries(labels).map(
                ([k, v]) => sql`${sandboxResources.labels}::jsonb->>${k} = ${v}`,
              ),
            ),
          )
          .orderBy(asc(sandboxResources.id))
          .limit(page.limit + 1);
        const items: SandboxView[] = [];
        for (const row of rows.slice(0, page.limit)) {
          const [related] = await tx
            .select({
              items: sql<
                { id: string; activeTurnId: string | null }[]
              >`coalesce(json_agg(json_build_object('id', ${sessions.id}, 'activeTurnId', ${sessions.body}->>'activeTurnId') order by ${sessions.id}), '[]'::json)`,
            })
            .from(sessions)
            .where(and(eq(sessions.sandboxId, row.id), accessWhere(access)));
          const [compute] = await tx
            .select({ body: sandboxes.body })
            .from(sandboxes)
            .where(eq(sandboxes.id, sandboxWorkspaceKey(tenantId, row.id)))
            .limit(1);
          const isPod = row.kind === "pod";
          items.push({
            id: row.id,
            kind: row.kind,
            labels: row.labels as Record<string, string>,
            spec: row.spec as Record<string, unknown>,
            state: isPod
              ? row.observed === "running"
                ? "running"
                : row.observed === "creating"
                  ? "creating"
                  : "stopped"
              : ((compute?.body as { state?: SandboxView["state"] } | undefined)?.state ?? "ready"),
            ...(isPod
              ? {
                  pod: {
                    desired: row.desired,
                    observed: row.observed,
                    volumeGeneration: row.volumeGen,
                    hostEpoch: row.hostEpoch,
                    ...(row.expiresAt ? { expiresAt: new Date(row.expiresAt).toISOString() } : {}),
                    ...(row.reason ? { reason: row.reason } : {}),
                  } as SandboxView["pod"],
                }
              : {}),
            sessions: related!.items,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          });
        }
        const last = items.at(-1);
        return {
          sandboxes: items,
          nextCursor: rows.length > page.limit && last ? cursor.encode([last.id]) : null,
        };
      }),
  };
}
