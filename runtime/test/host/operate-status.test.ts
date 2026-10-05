/**
 * `nylorun-operate status` (A5, I-D5): whether the Tenant is open and, when it is not, why,
 * from the database and from the running Host's `/ready`. It replaces the Admin API's status.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import { EXIT_TENANT, runOperate, type OperateStatus } from "../../src/host/operate.js";
import { MIGRATIONS_SCHEMA, MIGRATIONS_TABLE } from "../../src/store/postgres/migrate.js";
import { startEphemeralRuntime } from "../../src/tenant/ephemeral.js";
import { RUNTIME_VERSION } from "../../src/version.js";
import { isolatedTestDatabase } from "../support/store.js";
import { freePort } from "./support.js";

const closers: { close(): Promise<void> }[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const c of closers.splice(0)) await c.close().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function status(env: Record<string, string>, json = true) {
  const out: string[] = [];
  const code = await runOperate(json ? ["status", "--json"] : ["status"], {
    env,
    out: (line) => out.push(line),
    err: () => undefined,
  });
  return { code, out, report: json ? (JSON.parse(out[0]!) as OperateStatus) : undefined };
}

async function startHost() {
  const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-operate-status-"));
  roots.push(hostRoot);
  const database = await isolatedTestDatabase();
  const runtime = await startEphemeralRuntime({ hostRoot, retainRoot: true, database: database.sql });
  closers.push(runtime, { close: database.drop });
  const env = { NYLORUN_DATABASE_URL: database.url, NYLORUN_LISTEN_PORT: new URL(runtime.url).port };
  return { ...runtime, database, env };
}

const JOURNAL = `"${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}"`;

describe("nylorun-operate status", () => {
  it("reports an open Tenant, with the Runtime's version and protocol, and exits 0", async () => {
    const host = await startHost();
    const { code, report } = await status(host.env);
    expect(code).toBe(0);
    expect(report).toEqual({
      version: RUNTIME_VERSION,
      protocol: { min: HOST_PROTOCOL.min, max: HOST_PROTOCOL.max, features: [...HOST_PROTOCOL.features] },
      tenant: { id: host.tenantId, name: "ephemeral", state: "open" },
    });
    const human = await status(host.env, false);
    expect(human.code).toBe(0);
    expect(human.out.join("\n")).toContain(`ephemeral (${host.tenantId}): open`);
  });

  it("says the Runtime is not answering when nothing serves /ready, and exits 2", async () => {
    const host = await startHost();
    const { code, report } = await status({ ...host.env, NYLORUN_LISTEN_PORT: String(await freePort()) });
    expect(code).toBe(EXIT_TENANT);
    expect(report!.tenant).toMatchObject({ id: host.tenantId, name: "ephemeral", state: "unavailable" });
    expect(report!.tenant.cause).toBeUndefined();
    expect(report!.tenant.message).toMatch(/not answering/);
  });

  it("reports a running Runtime that has not opened the Tenant", async () => {
    const host = await startHost();
    const out: string[] = [];
    const code = await runOperate(["status", "--json"], {
      env: host.env,
      out: (line) => out.push(line),
      err: () => undefined,
      fetch: async () => Response.json({ status: "not_ready", checks: { listener: true, tenant: false } }, { status: 503 }),
    });
    expect(code).toBe(EXIT_TENANT);
    expect((JSON.parse(out[0]!) as OperateStatus).tenant).toMatchObject({
      id: host.tenantId,
      state: "unavailable",
      message: expect.stringMatching(/has not opened the Tenant/),
    });
  });

  it("reports a database that holds no Tenant yet", async () => {
    const empty = await isolatedTestDatabase();
    closers.push({ close: empty.drop });
    const { code, report } = await status({ NYLORUN_DATABASE_URL: empty.url });
    expect(code).toBe(EXIT_TENANT);
    expect(report!.tenant).toEqual({
      id: null,
      name: null,
      state: "unavailable",
      message: expect.stringMatching(/no Tenant/),
    });
  });

  it("names schema-too-new for a database a newer Runtime migrated", async () => {
    const host = await startHost();
    await host.database.sql.unsafe(`INSERT INTO ${JOURNAL} (hash, created_at) VALUES ('future', 0)`);
    const { code, report } = await status(host.env);
    expect(code).toBe(EXIT_TENANT);
    expect(report!.tenant).toMatchObject({
      id: host.tenantId,
      state: "unavailable",
      cause: "schema-too-new",
      message: expect.stringMatching(/newer Runtime/),
    });
  });

  it("reports a schema older than this Runtime's, which the Runtime migrates when it starts", async () => {
    const host = await startHost();
    await host.database.sql.unsafe(`DELETE FROM ${JOURNAL} WHERE id = (SELECT max(id) FROM ${JOURNAL})`);
    const { code, report } = await status(host.env);
    expect(code).toBe(EXIT_TENANT);
    expect(report!.tenant).toMatchObject({ id: host.tenantId, state: "unavailable" });
    expect(report!.tenant.cause).toBeUndefined();
    expect(report!.tenant.message).toMatch(/migrates it when it starts/);
  });

  it("refuses arguments it does not know", async () => {
    expect(await runOperate(["status", "--yaml"], { env: {}, out: () => undefined, err: () => undefined })).toBe(64);
  });
});
