/**
 * The Tenant database's schema as Drizzle defines it (`store/postgres/schema.ts`), the
 * migrations it ships (`store/postgres/drizzle/`), the custom column types, the lock order and
 * the driver boundary.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql as fragment } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";
import { database } from "../../src/store/postgres/db.js";
import { lockOrder } from "../../src/store/postgres/locking.js";
import {
  MIGRATIONS_FOLDER,
  expectedSchemaVersion,
  readSchemaVersion,
  shippedMigrations,
} from "../../src/store/postgres/migrate.js";
import {
  STREAMS_SCHEMA,
  TENANT_SCHEMA,
  definitions,
  sessions,
  signingKeys,
} from "../../src/store/postgres/schema.js";
import { testPool } from "../support/database.js";

const NUL = String.fromCharCode(0);
const LONE = String.fromCharCode(0xd800);
const REPLACEMENT = String.fromCharCode(0xfffd);
const BACKSLASH = String.fromCharCode(0x5c);

describe("Postgres schema names", () => {
  it("are fixed: one Tenant per database", () => {
    expect(TENANT_SCHEMA).toBe("nylorun");
    expect(STREAMS_SCHEMA).toBe("nylorun_streams");
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
  it("are the journal's SQL files, hashed as Drizzle hashes them", () => {
    const journal = JSON.parse(
      readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
    ) as { entries: { idx: number; tag: string; when: number }[] };
    const shipped = shippedMigrations();
    expect(shipped.map((m) => m.tag)).toEqual(journal.entries.map((e) => e.tag));
    expect(journal.entries.map((e) => e.idx)).toEqual(shipped.map((_, i) => i));
    expect(shipped.map((m) => m.hash)).toEqual(
      readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER }).map((m) => m.hash),
    );
    // Applied in journal order: `when` only grows.
    expect([...shipped].sort((a, b) => a.when - b.when)).toEqual(shipped);
    // Every SQL file is in the journal.
    const files = readdirSync(MIGRATIONS_FOLDER).filter((name) => name.endsWith(".sql"));
    expect(files.sort()).toEqual(journal.entries.map((e) => `${e.tag}.sql`).sort());
    expect(expectedSchemaVersion()).toBe(shipped.length);
  });

  it("are generated from schema.ts: drizzle-kit has nothing left to generate", async () => {
    const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
    const schema = await import("../../src/store/postgres/schema.js");
    const last = shippedMigrations().at(-1)!.tag.slice(0, 4);
    const snapshot = JSON.parse(
      readFileSync(join(MIGRATIONS_FOLDER, "meta", `${last}_snapshot.json`), "utf8"),
    );
    const current = generateDrizzleJson(
      schema,
      snapshot.id,
      [TENANT_SCHEMA, STREAMS_SCHEMA],
      "snake_case",
    );
    expect(await generateMigration(snapshot, current)).toEqual([]);
  });

  it("have migrated the test database", async () => {
    expect(await readSchemaVersion(database(testPool()))).toBe(expectedSchemaVersion());
  });
});

describe("Postgres column types", () => {
  it("jsonText keeps the exact text JSON.stringify wrote, and reads it back parsed", async () => {
    const db = database(testPool());
    const body = {
      id: "d1",
      // Strings jsonb would reject, a backslash-u that is not an escape, key order, astral text.
      status: `idle${NUL}`,
      lone: `x${LONE}y`,
      text: `${BACKSLASH}u0000 is six characters`,
      order: { b: 1, a: 2 },
      emoji: String.fromCodePoint(0x1f600),
      empty: [],
    };
    await db.insert(definitions).values({ id: "d1", body });
    const [raw] = await db.execute<{ text: string }>(
      fragment`SELECT body::text AS text FROM ${definitions} WHERE ${definitions.id} = 'd1'`,
    );
    expect(raw!.text).toBe(JSON.stringify(body));
    const [row] = await db.select().from(definitions).where(eq(definitions.id, "d1"));
    expect(JSON.stringify(row!.body)).toBe(JSON.stringify(body));
    expect(row!.body).toEqual(body);
  });

  it("generated columns read the body through doc(), which those escapes cannot break", async () => {
    const db = database(testPool());
    await db.insert(sessions).values({
      id: "s1",
      body: { id: "s1", status: `idle${NUL}`, agentId: `a${LONE}`, ownerUserId: "u1" },
    });
    const [row] = await db
      .select({ status: sessions.status, agentId: sessions.agentId, owner: sessions.ownerUserId })
      .from(sessions)
      .where(eq(sessions.id, "s1"));
    expect(row).toEqual({ status: `idle${REPLACEMENT}`, agentId: `a${REPLACEMENT}`, owner: "u1" });
  });

  it("bytes stores Uint8Array as bytea and reads a Uint8Array copy", async () => {
    const db = database(testPool());
    const nonce = new Uint8Array([0, 1, 2, 255]);
    // A view into a larger buffer: only its bytes are stored.
    const ciphertext = new Uint8Array(new Uint8Array([9, 9, 7, 8, 9, 9]).buffer, 2, 2);
    await db.insert(signingKeys).values({
      id: "k1",
      state: "standby",
      alg: "ES256",
      publicJwk: "{}",
      kekId: "kek",
      nonce,
      ciphertext,
      wrappedDek: new Uint8Array(),
      createdAt: "2030-01-01T00:00:00.000Z",
      activatedAt: null,
      retiredAt: null,
      revokedAt: null,
    });
    const [raw] = await db.execute<{ nonce: string; ciphertext: string }>(
      fragment`SELECT encode(nonce, 'hex') AS nonce, encode(ciphertext, 'hex') AS ciphertext
               FROM ${signingKeys}`,
    );
    expect(raw).toEqual({ nonce: "000102ff", ciphertext: "0708" });
    const [row] = await db.select().from(signingKeys);
    expect(row!.nonce).toBeInstanceOf(Uint8Array);
    expect(Buffer.isBuffer(row!.nonce)).toBe(false);
    expect([...row!.nonce]).toEqual([0, 1, 2, 255]);
    expect([...row!.ciphertext]).toEqual([7, 8]);
    expect([...row!.wrappedDek]).toEqual([]);
  });

  it('orders ids by code point (COLLATE "C"), whatever the database collation', async () => {
    const db = database(testPool());
    for (const id of ["b", "B", "a", "_", "A"])
      await db.insert(definitions).values({ id: `order-${id}`, body: {} });
    const rows = await db
      .select({ id: definitions.id })
      .from(definitions)
      .where(fragment`${definitions.id} LIKE 'order-%'`)
      .orderBy(definitions.id);
    expect(rows.map((row) => row.id)).toEqual([
      "order-A",
      "order-B",
      "order-_",
      "order-a",
      "order-b",
    ]);
  });
});

describe("Postgres driver boundary", () => {
  it("postgres and drizzle-orm are imported only under src/store/postgres/; pg only by the replication adapter", () => {
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
      .filter((path) =>
        /(?:from\s*|import\s*\()["'](?:postgres|pg|drizzle-orm|drizzle-kit)(?:\/[^"']*)?["']/.test(
          readFileSync(path, "utf8"),
        ),
      )
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
