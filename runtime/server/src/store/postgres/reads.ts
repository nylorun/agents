import { z } from "zod";
/** Drizzle read projections on a separate, read-only Tenant pool. */
import {
  and,
  asc,
  desc,
  eq,
  exists,
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
  CostSplit,
  LiveEvent,
  ModelCall,
  AgentView,
  ToolCall,
  SessionListItem,
  SessionManifestView,
  SessionUsageTotals,
} from "@nylorun/core/contracts";
import { isArtifactId } from "@nylorun/core/compatibility";
import type { ReadAccess, ReadStore } from "../../reads/types.js";
import { readCursor } from "../../reads/cursor.js";
import { fail } from "../../tenant/http.js";
import { limitsInForce, readTenantLimits } from "../../tenant/limits.js";
import { artifactView } from "../../artifacts/service.js";
import { sandboxWorkspaceKey } from "../../sandbox/records.js";
import { database, driverError, type Transaction } from "./db.js";
import { createPostgresReadClient, type PostgresClient } from "./connect.js";
import { hostTuning } from "../../tuning.js";
import { toolCallDuration, toolCallStatus } from "../../harness-api/tool-status.js";
import {
  effects,
  artifacts,
  modelUsage,
  sandboxes,
  sessions,
  sessionEvents,
  tenantSettings,
  turns,
  type ModelUsageRow,
} from "./schema.js";

const sessionFields = {
  id: sessions.id,
  agentId: sessions.agentId,
  ownerUserId: sessions.ownerUserId,
  status: sessions.status,
  activeTurnId: sql<string | null>`${sessions.body}->>'activeTurnId'`,
  lastTurnId: sql<string | null>`${sessions.body}->>'lastTurnId'`,
  createdAt: sessions.createdAt,
};
/** Rows whose Agent id an Agent grant (`*`, an id, or a `p/*` prefix) reaches; none reach nothing. */
function grantsWhere(column: typeof sessions.agentId | typeof turns.agentId, grants: readonly string[]): SQL {
  if (grants.includes("*")) return sql`true`;
  if (grants.length === 0) return sql`false`;
  return or(
    ...grants.map((grant) =>
      grant.endsWith("/*") ? sql`starts_with(${column}, ${grant.slice(0, -1)})` : eq(column, grant),
    ),
  )!;
}
function accessWhere(access: ReadAccess): SQL | undefined {
  return and(
    access.owner === undefined ? undefined : eq(sessions.ownerUserId, access.owner),
    access.agents === undefined ? undefined : grantsWhere(sessions.agentId, access.agents),
  );
}
/** A row's cost by token kind, when the adapter kept it (migration 0037). */
function costSplitOf(row: ModelUsageRow): CostSplit | null {
  const { costInputUsd, costCacheReadUsd, costCacheWriteUsd, costOutputUsd } = row;
  if (costInputUsd === null || costCacheReadUsd === null || costCacheWriteUsd === null || costOutputUsd === null)
    return null;
  return {
    input: costInputUsd,
    cacheRead: costCacheReadUsd,
    cacheWrite: costCacheWriteUsd,
    output: costOutputUsd,
  };
}

function publicCall(row: ModelUsageRow): ModelCall {
  return {
    id: row.id,
    effectId: row.effectKey,
    sessionId: row.sessionId,
    turnId: row.turnId,
    manifestName: row.manifestName,
    provider: row.provider,
    model: row.model,
    at: row.createdAt,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
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
      costSplit: costSplitOf(row),
    },
  };
}
/** A tool row's body, as the effect journal writes it (`harness-api/tool-journal.ts`). */
interface ToolRowBody {
  readonly request: {
    readonly effectId: string;
    readonly turnId: string;
    readonly toolName?: string;
    readonly input?: unknown;
    readonly context?: { readonly callId?: unknown };
  };
  readonly status: string;
  readonly outcome?: { readonly value: unknown };
  readonly error?: string;
  readonly toolKind?: ToolCall["kind"];
  readonly server?: string;
  readonly tool?: string;
  readonly skill?: string;
  readonly plugin?: ToolCall["plugin"];
  readonly attempts?: number;
  readonly startedAt?: string;
  readonly settledAt?: string;
}
function publicToolCall(body: ToolRowBody): ToolCall {
  const { request } = body;
  const status = toolCallStatus(body);
  const value = body.outcome?.value as { kind?: unknown; code?: unknown; message?: unknown } | null | undefined;
  const error =
    value?.kind === "failed"
      ? { code: String(value.code ?? "tool.failed"), message: String(value.message ?? "") }
      : status === "uncertain"
        ? { code: "uncertain", message: body.error ?? "" }
        : null;
  return {
    effectId: request.effectId,
    turnId: request.turnId,
    callId: typeof request.context?.callId === "string" ? request.context.callId : null,
    toolName: request.toolName ?? null,
    kind: body.toolKind ?? null,
    server: body.server ?? null,
    tool: body.tool ?? null,
    skill: body.skill ?? null,
    plugin: body.plugin ?? null,
    status,
    // A row written before R5 counted no sends: it was sent once.
    attempts: body.attempts ?? 1,
    input: request.input ?? null,
    error,
    startedAt: body.startedAt ?? null,
    settledAt: body.settledAt ?? null,
    durationMs: toolCallDuration(body) ?? null,
  };
}
/** The change feed's cursor key: the last row's `[txid, sessionId, turnId]`. */
function turnChangeKey(key: (string | null)[] | undefined): [string, string, string] | undefined {
  if (key === undefined) return undefined;
  const [txid, sessionId, turnId] = key;
  if (
    key.length !== 3 ||
    typeof txid !== "string" ||
    typeof sessionId !== "string" ||
    typeof turnId !== "string" ||
    !/^\d{1,20}$/.test(txid) ||
    BigInt(txid) > 18446744073709551615n
  )
    return fail(400, "Invalid cursor key", { code: "cursor_invalid" });
  return [txid, sessionId, turnId];
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
    close: () => pool.end({ timeout: hostTuning().postgres.readCloseTimeoutSeconds }),
    artifacts: (filters, page, access) =>
      read(async (tx) => {
        if (filters.sessionId !== undefined) await requireSession(tx, filters.sessionId, access);
        const cursor = readCursor(tenantId, "artifacts", {
          sessionId: filters.sessionId ?? null,
          kind: filters.kind ?? null,
          labels: Object.entries(filters.labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        });
        const key = keyOf(cursor.decode(page.cursor), 2, true);
        if (key && !isArtifactId(key[1]))
          fail(400, "Invalid artifact cursor key", { code: "cursor_invalid" });
        const rows = await tx
          .select()
          .from(artifacts)
          .where(
            and(
              access.owner === undefined && access.agents === undefined
                ? undefined
                : exists(
                    tx.select({ id: sessions.id })
                      .from(sessions)
                      .where(and(eq(sessions.id, artifacts.sessionId), accessWhere(access))),
                  ),
              filters.sessionId === undefined
                ? undefined
                : eq(artifacts.sessionId, filters.sessionId),
              filters.kind === undefined ? undefined : eq(artifacts.kind, filters.kind),
              // Labels are a flat string map serialized by JSON.stringify. Match its exact
              // key/value pair: jsonb rejects NUL/unpaired surrogate escapes labels may hold.
              ...Object.entries(filters.labels).map(
                ([k, v]) =>
                  sql`strpos(${artifacts.labelsJson}, ${JSON.stringify(k) + ":" + JSON.stringify(v)}) > 0`,
              ),
              key ? sql`(${artifacts.createdAt}, ${artifacts.id}) < (${key[0]}, ${key[1]})` : undefined,
            ),
          )
          .orderBy(desc(artifacts.createdAt), desc(artifacts.id))
          .limit(page.limit + 1);
        const items = rows.slice(0, page.limit);
        const last = items.at(-1);
        return {
          artifacts: items.map((row) => artifactView(row)),
          nextCursor:
            rows.length > page.limit && last ? cursor.encode([last.createdAt, last.id]) : null,
        };
      }),
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
              filters.manifest === undefined ? undefined : eq(sessions.manifestName, filters.manifest),
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
            definition: sql<{ name: string; version: number } | null>`${sessions.body}->'definition'`,
            manifestHash: sql<string>`${sessions.body}->>'manifestHash'`,
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
            costInput: sum(modelUsage.costInputUsd),
            costCacheRead: sum(modelUsage.costCacheReadUsd),
            costCacheWrite: sum(modelUsage.costCacheWriteUsd),
            costOutput: sum(modelUsage.costOutputUsd),
            splitCalls: sql<number>`count(${modelUsage.costInputUsd})`.mapWith(Number),
            // The gate's timing is ISO text; a row timed before migration 0022 has none.
            modelTimeMs: sql<number>`coalesce(round(sum(extract(epoch from (${modelUsage.endedAt}::timestamptz - ${modelUsage.startedAt}::timestamptz)) * 1000)), 0)`.mapWith(
              Number,
            ),
            timedCalls:
              sql<number>`count(*) filter (where ${modelUsage.startedAt} is not null and ${modelUsage.endedAt} is not null)`.mapWith(
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
        const { costInput, costCacheRead, costCacheWrite, costOutput, ...rest } = totals!;
        return {
          ...rest,
          costSplit: {
            input: costInput,
            cacheRead: costCacheRead,
            cacheWrite: costCacheWrite,
            output: costOutput,
          },
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
    toolCalls: (id, turnId, page, access) =>
      read(async (tx) => {
        await requireSession(tx, id, access);
        const cursor = readCursor(tenantId, "tool-calls", { sessionId: id, turnId });
        const key = keyOf(cursor.decode(page.cursor), 2);
        // In the order of their first send; a row written before R5 has no `startedAt`.
        const startedAt = sql<string>`coalesce(${effects.body}->>'startedAt', '')`;
        const rows = await tx
          .select({ id: effects.id, body: effects.body, startedAt })
          .from(effects)
          .where(
            and(
              eq(effects.sessionId, id),
              eq(effects.kind, "tool"),
              turnId === undefined ? undefined : eq(effects.turnId, turnId),
              key ? sql`(${startedAt}, ${effects.id}) > (${key[0]}, ${key[1]})` : undefined,
            ),
          )
          .orderBy(asc(startedAt), asc(effects.id))
          .limit(page.limit + 1);
        const items = rows.slice(0, page.limit);
        const last = items.at(-1);
        return {
          calls: items.map((row) => publicToolCall(row.body as ToolRowBody)),
          nextCursor:
            rows.length > page.limit && last ? cursor.encode([last.startedAt, last.id]) : null,
          asOf: new Date().toISOString(),
        };
      }),
    turnEvents: (id, turnId, access) =>
      read(async (tx) => {
        await requireSession(tx, id, access);
        // The record has no turn column: one session's rows, on the turn id in the event (no
        // index yet, R8).
        const rows = await tx
          .select({ body: sessionEvents.body })
          .from(sessionEvents)
          .where(and(eq(sessionEvents.sessionId, id), sql`${sessionEvents.body}->>'turnId' = ${turnId}`))
          .orderBy(asc(sessionEvents.seq));
        return rows.map((row) => row.body as LiveEvent);
      }),
    turnChanges: (filters, page, access) =>
      read(async (tx) => {
        if (filters.sessionId !== undefined) await requireSession(tx, filters.sessionId, access);
        const cursor = readCursor(tenantId, "turns", { sessionId: filters.sessionId ?? null });
        const key = turnChangeKey(cursor.decode(page.changedAfter));
        const rows = await tx
          .select()
          .from(turns)
          .where(
            and(
              // Below every transaction still running: one that commits later sorts after.
              sql`${turns.txid} < pg_snapshot_xmin(pg_current_snapshot())`,
              key
                ? sql`(${turns.txid}, ${turns.sessionId}, ${turns.turnId}) > (${key[0]}::xid8, ${key[1]}, ${key[2]})`
                : undefined,
              filters.sessionId === undefined ? undefined : eq(turns.sessionId, filters.sessionId),
              access.owner === undefined ? undefined : eq(turns.ownerUserId, access.owner),
              access.agents === undefined ? undefined : grantsWhere(turns.agentId, access.agents),
            ),
          )
          .orderBy(asc(turns.txid), asc(turns.sessionId), asc(turns.turnId))
          .limit(page.limit + 1);
        const items = rows.slice(0, page.limit);
        const last = items.at(-1);
        return {
          turns: items,
          // Echoed when nothing changed; a first read starts before every row.
          cursor: last
            ? cursor.encode([last.txid, last.sessionId, last.turnId])
            : (page.changedAfter ?? cursor.encode(["0", "", ""])),
          hasMore: rows.length > page.limit,
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
  };
}
