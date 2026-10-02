/**
 * A database of its own for a test file's Runtime (`startEphemeralRuntime` keeps its Tenant
 * in Postgres), on the runtime test stack: `npm run test:stack:up -w @nylorun/runtime` from
 * the repository root. `NYLORUN_TEST_POSTGRES_PORT` moves it, as for the runtime tests.
 */
import { randomBytes } from "node:crypto";
import postgres from "postgres";

const port = Number(process.env.NYLORUN_TEST_POSTGRES_PORT ?? 55432);
const server = `postgres://nylorun:nylorun@127.0.0.1:${port}`;

async function onServer(statement: string): Promise<void> {
  const sql = postgres(`${server}/nylorun`, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(statement);
  } catch (error) {
    if ((error as { code?: string }).code === "ECONNREFUSED")
      throw new Error(
        `The test stack's Postgres does not answer on 127.0.0.1:${port}: run npm run test:stack:up -w @nylorun/runtime`,
        { cause: error },
      );
    throw error;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Creates an empty database; `drop` removes it once the Runtime on it has closed. */
export async function testDatabase(): Promise<{ url: string; drop(): Promise<void> }> {
  const name = `nylorun_examples_${randomBytes(8).toString("hex")}`;
  await onServer(`CREATE DATABASE ${name}`);
  return {
    url: `${server}/${name}`,
    drop: () => onServer(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
  };
}
