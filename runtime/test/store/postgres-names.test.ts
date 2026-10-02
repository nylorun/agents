import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lockOrder } from "../../src/store/postgres/locking.js";
import {
  MIGRATIONS,
  POSTGRES_SCHEMA_VERSION,
  assertMigrations,
} from "../../src/store/postgres/migrations/index.js";
import {
  MAX_IDENTIFIER_BYTES,
  TENANT_SCHEMA,
  quoteIdentifier,
} from "../../src/store/postgres/names.js";
import { STREAMS_SCHEMA } from "../../src/store/postgres/migrations/shared/index.js";

describe("Postgres schema names", () => {
  it("are fixed: one Tenant per database", () => {
    expect(TENANT_SCHEMA).toBe("nylorun");
    expect(STREAMS_SCHEMA).toBe("nylorun_streams");
    expect(quoteIdentifier(TENANT_SCHEMA)).toBe(`"nylorun"`);
  });

  it("quotes only safe identifiers Postgres would not truncate", () => {
    expect(() => quoteIdentifier(`a"b`)).toThrow();
    expect(() => quoteIdentifier("")).toThrow();
    expect(() => quoteIdentifier("x".repeat(MAX_IDENTIFIER_BYTES + 1))).toThrow();
    expect(quoteIdentifier("x".repeat(MAX_IDENTIFIER_BYTES))).toBe(`"${"x".repeat(MAX_IDENTIFIER_BYTES)}"`);
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
      assertMigrations([...MIGRATIONS, { version: MIGRATIONS.length + 2, name: "gap", up: () => "" }]),
    ).toThrow("expected");
  });
});

describe("Postgres driver boundary", () => {
  it("is imported only under src/store/postgres/, record/postgres.ts and, for replication, adapters/replication/", () => {
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
          path !== "adapters/replication/pgoutput.ts" &&
          // The record module's insert into the shared record (blueprint D27), in the caller's
          // transaction (driver types only).
          path !== "record/postgres.ts",
      );
    expect(offenders).toEqual([]);
  });
});
