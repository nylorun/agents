/**
 * The control bus on Postgres (`store/postgres/control.ts`) where the contract cannot reach:
 * a follower whose LISTEN connection is killed listens again and catches up on what was
 * signalled meanwhile, and a signal crosses stores on the same database (two processes).
 */
import { afterEach, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { expectedSchemaVersion } from "../../src/store/postgres/migrate.js";
import { TENANT_SCHEMA } from "../../src/store/postgres/schema.js";
import { createPostgresSessionStore } from "../../src/store/postgres/store.js";
import type { ControlSignal, SessionStore, SignalFollower } from "../../src/store/types.js";
import { isolatedTestDatabase } from "../support/store.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until<T>(read: () => T | undefined, what: string, ms = 10_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) {
    const value = read();
    if (value !== undefined) return value;
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A database with its Tenant row, and `count` stores on it (as many processes). */
async function stores(count: number) {
  const database = await isolatedTestDatabase();
  const { sql } = database;
  const tenantId = newTenantId();
  const now = new Date().toISOString();
  await sql`
    INSERT INTO ${sql(`${TENANT_SCHEMA}.tenant`)} (id, name, created_at, updated_at, schema_version)
    VALUES (${tenantId}, 'Test', ${now}, ${now}, ${expectedSchemaVersion()})`;
  cleanups.push(() => database.drop());
  const opened: SessionStore[] = [];
  for (let i = 0; i < count; i += 1) {
    const store = createPostgresSessionStore({ tenantId, sql });
    cleanups.push(() => store.close());
    opened.push(store);
  }
  return { sql, stores: opened };
}

async function follow(store: SessionStore, pollMs: number) {
  const seen: ControlSignal[] = [];
  const errors: unknown[] = [];
  const follower: SignalFollower = await store.followSignals((signal) => seen.push(signal), {
    pollMs,
    onError: (error) => errors.push(error),
  });
  cleanups.push(() => follower.close());
  return { seen, errors };
}

it("crosses stores on one database: a signal one writes, every follower gets", async () => {
  const { stores: [a, b] } = await stores(2);
  const onA = await follow(a!, 60_000);
  const onB = await follow(b!, 60_000);
  // A poll this slow never runs in the test: delivery is the notification's.
  await a!.tx((t) => t.signal({ type: "session.cancel", sessionId: "s1", turnId: "t1" }));
  await until(() => (onA.seen.length && onB.seen.length ? true : undefined), "both stores");
  expect(onB.seen).toEqual([{ type: "session.cancel", sessionId: "s1", turnId: "t1" }]);
  expect(onA.seen).toEqual(onB.seen);
});

it("listens again after its connection is killed and catches up on what it missed", async () => {
  const { sql, stores: [store] } = await stores(1);
  // No poll in the test's time: what was missed comes back with the next LISTEN.
  const { seen, errors } = await follow(store!, 60_000);
  const killed = await sql<{ killed: boolean }[]>`
    SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity
    WHERE application_name = 'nylorun-control' AND datname = current_database()`;
  expect(killed.map((row) => row.killed)).toEqual([true]);
  // Written while the follower has no LISTEN: its notification reaches no one.
  await store!.tx((t) => t.signal({ type: "sessions.reset", generation: 2 }));
  await until(() => (seen.length ? true : undefined), "the missed signal");
  expect(seen).toEqual([{ type: "sessions.reset", generation: 2 }]);
  // Listening again: a new signal arrives by notification.
  await store!.tx((t) => t.signal({ type: "session.cancel", sessionId: "s1" }));
  await until(() => (seen.length === 2 ? true : undefined), "the next signal");
  expect(seen[1]).toEqual({ type: "session.cancel", sessionId: "s1" });
  expect(errors).toEqual([]);
});
