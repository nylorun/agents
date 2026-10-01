import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { lockOrder } from "../../src/store/postgres/locking.js";
import {
  MIGRATIONS,
  POSTGRES_SCHEMA_VERSION,
  assertMigrations,
} from "../../src/store/postgres/migrations/index.js";
import {
  MAX_IDENTIFIER_BYTES,
  quoteIdentifier,
  tenantIdFromSchema,
  tenantSchemaName,
} from "../../src/store/postgres/names.js";

describe("Postgres Tenant schema names", () => {
  it("maps a Tenant id to a quoted-safe schema name and back", () => {
    const id = newTenantId();
    const schema = tenantSchemaName(id);
    expect(schema).toBe(`tenant_${id}`);
    expect(Buffer.byteLength(schema)).toBeLessThanOrEqual(MAX_IDENTIFIER_BYTES);
    expect(tenantIdFromSchema(schema)).toBe(id);
    expect(quoteIdentifier(schema)).toBe(`"${schema}"`);
  });

  it("rejects ids that are not Tenant ids", () => {
    for (const bad of ["", "tn_", "TN_01K8Z3AAAAAAAAAAAAAAAAAAAA", "tn_x\";drop", "tn_01k8z3aaaaaaaaaaaaaaaaaaaaa"])
      expect(() => tenantSchemaName(bad)).toThrow("Invalid tenant id");
    expect(tenantIdFromSchema("public")).toBeUndefined();
    expect(tenantIdFromSchema("tenant_not_an_id")).toBeUndefined();
    expect(() => quoteIdentifier(`a"b`)).toThrow();
    expect(() => quoteIdentifier("x".repeat(64))).toThrow();
  });
});

describe("Postgres lock order", () => {
  it("locks unique ids in ascending order", () => {
    expect(lockOrder(["c", "a", "b", "a"])).toEqual(["a", "b", "c"]);
    expect(lockOrder(["wf-b", "wf", "wf-a"])).toEqual(["wf", "wf-a", "wf-b"]);
    expect(lockOrder([])).toEqual([]);
  });
});

describe("Postgres migrations", () => {
  it("are numbered 1, 2, 3, … and end at the schema version", () => {
    expect(() => assertMigrations(MIGRATIONS)).not.toThrow();
    expect(POSTGRES_SCHEMA_VERSION).toBe(MIGRATIONS.length);
    expect(() =>
      assertMigrations([...MIGRATIONS, { version: 9, name: "gap", up: () => "" }]),
    ).toThrow("expected");
  });
});

describe("Postgres driver boundary", () => {
  it("is imported only under src/store/postgres/ and, for replication, adapters/replication/", () => {
    const src = fileURLToPath(new URL("../../src/", import.meta.url));
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? files(join(dir, entry.name))
          : entry.name.endsWith(".ts")
            ? [join(dir, entry.name)]
            : [],
      );
    const offenders = files(src)
      .filter((path) => /(?:from\s*|import\s*\()["'](?:postgres|pg)(?:\/[^"']*)?["']/.test(readFileSync(path, "utf8")))
      .map((path) => relative(src, path).split(sep).join("/"))
      .filter(
        (path) =>
          !path.startsWith("store/postgres/") &&
          // The stream relay's replication connection (`pg`, needed by pg-logical-replication).
          path !== "adapters/replication/pgoutput.ts",
      );
    expect(offenders).toEqual([]);
  });
});
