/**
 * Protocol 10: migration `0016_mcp_oauth_removed` drops `oauth_pending` and deletes the vault's
 * `oauth` credentials, each with an audit row, and the Host names each one in a boot warning.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { shippedMigrations } from "../../src/store/postgres/migrate.js";
import { openTenantDatabase } from "../../src/store/postgres/tenant.js";
import { createPostgresTenantOpener } from "../../src/tenant/store-pg.js";
import type { Logger } from "../../src/tenant/types.js";
import { emptyTestDatabase } from "../support/database.js";
import { configForRoot } from "../tenant/support.js";

it("deletes oauth credentials with an audit row each, and warns once naming each", async () => {
  const db = await emptyTestDatabase();
  const tenantId = newTenantId();
  const create = { tenantId, name: "upgrade", principals: () => [] };
  const old = await openTenantDatabase({
    sql: db.sql,
    create,
    // The database as protocol 9 left it.
    migrations: shippedMigrations().slice(
      0,
      shippedMigrations().findIndex((migration) => migration.tag === "0016_mcp_oauth_removed"),
    ),
  });
  await old.store.close();
  await db.sql`insert into nylorun.vaults (id, name, owner_user_id, created_at, scope)
    values ('v1', 'mcp', 'installation', '2030-01-01T00:00:00.000Z', 'installation')`;
  const credential = (id: string, type: string, url: string) => db.sql`
    insert into nylorun.vault_credentials
      (id, vault_id, name, type, binding_json, created_at, kek_id, nonce, ciphertext, wrapped_dek)
    values (${id}, 'v1', ${id}, ${type}, ${JSON.stringify({ url })}, '2030-01-01T00:00:00.000Z',
      'kek', ${Buffer.from([1])}, ${Buffer.from([2])}, ${Buffer.from([3])})`;
  await credential("c-bearer", "bearer", "https://keyed.example.com/mcp");
  await credential("c-oauth", "oauth", "https://oauth.example.com/mcp");

  const root = await mkdtemp(join(tmpdir(), "nylorun-oauth-removed-"));
  const warnings: [string, Record<string, unknown> | undefined][] = [];
  const logger: Logger = {
    info: () => {},
    warn: (message, fields) => warnings.push([message, fields]),
    error: () => {},
  };
  const open = createPostgresTenantOpener({
    hostRoot: root,
    sql: db.sql,
    create,
    configFor: configForRoot(root),
    logger,
    openRuntime: async (_config, opened) => {
      await opened.reads?.close();
      await opened.store.close();
      return {} as never;
    },
  });
  try {
    await open();
    expect(warnings).toEqual([
      [
        "oauth_credential_removed",
        expect.objectContaining({
          tenantId,
          vaultId: "v1",
          credentialId: "c-oauth",
          url: "https://oauth.example.com/mcp",
        }),
      ],
    ]);
    expect((await db.sql`select id from nylorun.vault_credentials`).map((row) => row.id)).toEqual([
      "c-bearer",
    ]);
    expect(
      await db.sql`select actor, action, vault_id, credential_id, target, outcome from nylorun.vault_audit`,
    ).toEqual([
      {
        actor: "migration",
        action: "delete",
        vault_id: "v1",
        credential_id: "c-oauth",
        target: "https://oauth.example.com/mcp",
        outcome: "deleted",
      },
    ]);
    expect((await db.sql`select to_regclass('nylorun.oauth_pending') as t`)[0]!.t).toBeNull();

    // The migration ran once: a later boot warns no more.
    warnings.length = 0;
    await open();
    expect(warnings).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
