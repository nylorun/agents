/**
 * Global setup of both vitest configs (session-store.md §5). Every Session Store test runs on
 * the test stack's Postgres (`test/stack/compose.yaml`), so `npm test` needs Docker:
 *
 * 1. When Postgres does not answer, starts the test stack (`test/stack/up.mjs`), unless
 *    `NYLORUN_TEST_STACK_EXTERNAL=1` says someone else runs it.
 * 2. Creates this run's template database with what every Tenant database needs before its
 *    first Tenant (the shared `nylorun_streams` schema), and hands its name to the workers.
 *    Each test file clones it (`setup-database.ts`).
 * 3. Drops the template at teardown, and any database of this run a crashed file left. A
 *    stack it started keeps running for the next run (`npm run test:stack:down -w
 *    @nylorun/runtime` stops it).
 *
 * Other runs may share the stack: every database of a run has the run's own prefix.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";
import { createPostgresClient } from "../src/store/postgres/connect.js";
import { migrateStreamsSchema } from "../src/store/postgres/migrations/shared/index.js";
import { stackEndpoints } from "./stack/endpoints.js";
import {
  dropTestDatabase,
  onTestServer,
  testDatabasePool,
} from "./support/database.js";

async function postgresAnswers(): Promise<boolean> {
  const sql = createPostgresClient(stackEndpoints().postgres.url, {
    max: 1,
    connectTimeoutSeconds: 2,
  });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => undefined);
  }
}

function startStack(): void {
  const up = fileURLToPath(new URL("./stack/up.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [up, "up"], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      "Could not start the test stack (Docker with Compose v2 is required): " +
        "run `npm run test:stack:up -w @nylorun/runtime` to see why",
    );
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  if (!(await postgresAnswers())) {
    const { port } = stackEndpoints().postgres;
    if (process.env.NYLORUN_TEST_STACK_EXTERNAL === "1")
      throw new Error(
        `The test stack's Postgres does not answer on 127.0.0.1:${port} (NYLORUN_TEST_STACK_EXTERNAL=1)`,
      );
    startStack();
  }

  const run = randomBytes(6).toString("hex");
  const template = `nylorun_tpl_${run}`;
  const prefix = `nylorun_t_${run}`;
  await onTestServer((sql) => sql.unsafe(`CREATE DATABASE ${template}`));
  // Clones need a template nobody is connected to: this pool ends before any test starts.
  const sql = testDatabasePool(template, 1);
  try {
    await migrateStreamsSchema(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
  project.provide("templateDatabase", template);
  project.provide("testDatabasePrefix", prefix);
  return async () => {
    const left = await onTestServer(
      (sql) => sql<{ datname: string }[]>`
        SELECT datname FROM pg_database WHERE starts_with(datname, ${`${prefix}_`})`,
    );
    for (const { datname } of left) await dropTestDatabase(datname);
    await dropTestDatabase(template);
  };
}
