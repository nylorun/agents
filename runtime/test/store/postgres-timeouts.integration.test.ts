/**
 * The Host's Postgres pool bounds statements and idle transactions, so one that hangs cannot
 * hold a shared connection forever; migrations under `lockMigrations` are not bounded.
 */
import { afterAll, describe, expect, it } from "vitest";
import { createPostgresClient, type PostgresClient } from "../../src/store/postgres/connect.js";
import { sql as fragment } from "drizzle-orm";
import { database } from "../../src/store/postgres/db.js";
import { lockMigrations } from "../../src/store/postgres/migrate.js";
import { STACK_ENABLED, stackEndpoints } from "../stack/endpoints.js";

describe.skipIf(!STACK_ENABLED)("Postgres pool timeouts", () => {
  const clients: PostgresClient[] = [];
  const client = (options: { statementTimeoutMs?: number; idleInTransactionTimeoutMs?: number }) => {
    const sql = createPostgresClient(stackEndpoints().postgres.url, { max: 1, ...options });
    clients.push(sql);
    return sql;
  };

  afterAll(async () => {
    for (const sql of clients) await sql.end();
  });

  it("applies 60 s defaults to every connection", async () => {
    const sql = client({});
    const [row] = await sql<{ statement: string; idle: string }[]>`
      SELECT current_setting('statement_timeout') AS statement,
             current_setting('idle_in_transaction_session_timeout') AS idle`;
    expect(row).toEqual({ statement: "1min", idle: "1min" });
  });

  it("cancels a statement that runs past the statement timeout", async () => {
    const sql = client({ statementTimeoutMs: 100 });
    await expect(sql`SELECT pg_sleep(1)`).rejects.toMatchObject({ code: "57014" });
    // The connection is usable again.
    expect(await sql`SELECT 1 AS ok`).toEqual([{ ok: 1 }]);
  });

  it("ends a transaction left idle past the idle timeout", async () => {
    const sql = client({ idleInTransactionTimeoutMs: 100 });
    await expect(
      sql.begin(async (tx) => {
        await tx`SELECT 1`;
        await new Promise((resolve) => setTimeout(resolve, 400));
        await tx`SELECT 1`;
      }),
    ).rejects.toThrow();
    expect(await sql`SELECT 1 AS ok`).toEqual([{ ok: 1 }]);
  });

  it("lifts the statement timeout for a transaction under the migration lock", async () => {
    const sql = client({ statementTimeoutMs: 100 });
    await database(sql).transaction(async (tx) => {
      await lockMigrations(tx);
      await tx.execute(fragment`SELECT pg_sleep(0.3)`);
    });
    // Only for that transaction.
    await expect(sql`SELECT pg_sleep(1)`).rejects.toMatchObject({ code: "57014" });
  });
});
