import { createHash } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import {
  TENANT_SCHEMA_VERSION,
  migrateTenantDatabase,
  openTenantDatabase,
  schemaVersionOf,
} from "../src/tenant/schema.js";
import {
  bootstrapPrincipal,
  bootstrapPrincipalMatches,
} from "../src/tenant/principals.js";
import { createSqliteSessionStore } from "../src/store/sqlite.js";
import { createTenantLogger } from "../src/tenant/logger.js";
import { hashToken } from "../src/core/executors.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tenant-schema-"));
  roots.push(root);
  return root;
}

it("migrateTenantDatabase creates principals and sets user_version", () => {
  const db = openTenantDatabase(":memory:");
  expect(schemaVersionOf(db)).toBe(0);
  const result = migrateTenantDatabase(db);
  expect(result).toEqual({ from: 0, to: TENANT_SCHEMA_VERSION });
  expect(schemaVersionOf(db)).toBe(TENANT_SCHEMA_VERSION);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((row) => String((row as { name: string }).name));
  expect(tables).toContain("principals");
  expect(tables).toContain("executors");
  expect(tables).toContain("tenant_settings");
  const columns = db.prepare("PRAGMA table_info(executors)").all() as {
    name: string;
  }[];
  expect(columns.some((column) => column.name === "principal_id")).toBe(true);
});

it("bootstrapPrincipal writes the application principal in one transaction", async () => {
  const store = createSqliteSessionStore({ path: ":memory:", tenantId: newTenantId() });
  const credentialHash = createHash("sha256").update("app-key").digest("hex");
  const bootstrap = {
    principalId: "principal_test",
    credentialHash,
    idempotencyKey: "idem-1",
  };
  await store.tx((t) => bootstrapPrincipal(t, bootstrap));
  const found = await store.tx((t) => t.principalByTokenHash(credentialHash));
  expect(found).toMatchObject({
    id: "principal_test",
    role: "application",
    tokenHash: credentialHash,
    idempotencyKey: "idem-1",
  });
  expect(await store.tx((t) => t.applicationTokenHashes())).toEqual([credentialHash]);
  expect(await store.tx((t) => bootstrapPrincipalMatches(t, bootstrap))).toBe(true);
  expect(
    await store.tx((t) =>
      bootstrapPrincipalMatches(t, { ...bootstrap, idempotencyKey: "other" })
    )
  ).toBe(false);
  await store.close();
});

it("Tenant logger writes JSON lines with tenantId on every record", async () => {
  const root = await tempRoot();
  const tenantId = newTenantId();
  const logPath = join(root, "logs", "tenant.log");
  const logger = createTenantLogger({ tenantId, logPath });
  logger.info("opened", { check: "sqlite" });
  logger.warn("credential rejected");
  const lines = (await readFile(logPath, "utf8")).trim().split("\n");
  expect(lines).toHaveLength(2);
  const records = lines.map((line) => JSON.parse(line));
  expect(records[0]).toMatchObject({
    level: "info",
    tenantId,
    message: "opened",
    check: "sqlite",
  });
  expect(records[1]).toMatchObject({
    level: "warn",
    tenantId,
    message: "credential rejected",
  });
  expect(hashToken("x")).toHaveLength(64);
});
