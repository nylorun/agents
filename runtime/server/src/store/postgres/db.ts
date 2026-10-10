/**
 * Drizzle on the Tenant database's pool (session-store.md §3): `drizzle-orm/postgres-js` over
 * the postgres.js pool `connect.ts` opens, with the snake_case column names `schema.ts`
 * defines. One Drizzle instance per pool.
 *
 * Drizzle hands timestamps to its own column types: on the pool it is given, postgres.js stops
 * parsing date and time values, so a raw query on that pool reads a `timestamptz` as text.
 */
import { DrizzleQueryError } from "drizzle-orm";
import {
  drizzle,
  type PostgresJsDatabase,
  type PostgresJsQueryResultHKT,
} from "drizzle-orm/postgres-js";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { Sql } from "postgres";

export type Database = PostgresJsDatabase<Record<string, never>>;

/** A database or one of its transactions: anything a query can run on. */
export type Queryable = PgDatabase<PostgresJsQueryResultHKT, Record<string, never>>;

/** A transaction of `Database` (`db.transaction`). */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const databases = new WeakMap<Sql, Database>();

/** The Drizzle database on `sql`. */
export function database(sql: Sql): Database {
  let db = databases.get(sql);
  if (!db) {
    db = drizzle({ client: sql, casing: "snake_case" });
    databases.set(sql, db);
  }
  return db;
}

/**
 * The driver's error behind a Drizzle query error. Drizzle wraps every failed query in a
 * `DrizzleQueryError` whose message holds the query and its parameters (secrets among them);
 * the store surfaces the postgres.js error with its SQLSTATE `code`, as callers expect.
 */
export function driverError(error: unknown): unknown {
  return error instanceof DrizzleQueryError && error.cause !== undefined ? error.cause : error;
}
