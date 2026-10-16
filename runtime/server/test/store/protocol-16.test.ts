/**
 * Protocol 16: migration `0032_agents` is a fresh start for Agents (track T2). It closes every
 * open session (`closedReason: "protocol_16"`) and leaves one closed before as it is, drops
 * agent definitions and environment manifests, deletes the Environments with their vaults (the
 * host's stays), workspaces, disks and streams, and renames `environments` to `agents`; the usage
 * ledger names the manifest, and a budget of scope `agent` becomes scope `manifest`.
 */
import { expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { shippedMigrations } from "../../src/store/postgres/migrate.js";
import { openTenantDatabase } from "../../src/store/postgres/tenant.js";
import { emptyTestDatabase } from "../support/database.js";

const AT = "2030-01-01T00:00:00.000Z";

it("closes every open session, drops definitions and environment manifests, and renames environments to agents", async () => {
  const db = await emptyTestDatabase();
  const create = { tenantId: newTenantId(), name: "upgrade", principals: () => [] };
  const at = shippedMigrations().findIndex((migration) => migration.tag === "0032_agents");
  expect(at).toBeGreaterThan(0);
  // The database as protocol 15 left it.
  const old = await openTenantDatabase({ sql: db.sql, create, migrations: shippedMigrations().slice(0, at) });
  const session = (body: object) => ({
    agentId: "bot",
    ownerUserId: "ada",
    manifest: { manifestSchemaVersion: 7, id: "bot" },
    ...body,
  });
  await old.store.tx(async (t) => {
    await t.put("sessions", "idle", session({ status: "idle", environmentId: "e1" }));
    await t.put("sessions", "waiting", session({ status: "waiting" }));
    await t.put("sessions", "completed", session({ status: "completed" }));
    await t.put("sessions", "flow", session({ status: "completed", agentId: "flow", manifest: { kind: "workflow", id: "flow" } }));
    await t.put("sessions", "older", session({ status: "completed", closedReason: "protocol_15" }));
  });
  await old.store.close();
  const sql = db.sql;
  await sql`insert into nylorun.definitions (id, body) values ('bot', ${JSON.stringify({ manifest: { id: "bot" } })}::json)`;
  await sql`insert into nylorun.environment_manifests (name, version, body, hash, saved_by, created_at)
    values ('box', 1, ${JSON.stringify({ kind: "virtual" })}::json, 'sha256:box', ${JSON.stringify({ actor: "application" })}::json, ${AT})`;
  await sql`insert into nylorun.environments (id, kind, labels, recipe, applied, created_at, updated_at)
    values ('e1', 'virtual', ${JSON.stringify({})}::json, ${JSON.stringify({})}::json, ${JSON.stringify({})}::json, ${AT}, ${AT})`;
  await sql`insert into nylorun_streams.environment_events (environment_id, seq, type, body)
    values ('e1', 0, 'environment.created', ${JSON.stringify({})}::json)`;
  await sql`insert into nylorun.vaults (id, name, created_at, environment_id) values
    ('host', 'Host', ${AT}, null), ('v1', 'e1', ${AT}, 'e1')`;
  await sql`insert into nylorun.sandbox_signals (id, sandbox_id, kind) values ('sig-1', 'e1', 'reconcile')`;
  await sql`insert into nylorun.artifacts (id, kind, name, content_type, latest_version, created_at, updated_at, environment_id, session_id)
    values ('af-disk', 'folder', 'disk', 'application/x-directory', 1, ${AT}, ${AT}, 'e1', null),
           ('af-session', 'file', 'a.txt', 'text/plain', 1, ${AT}, ${AT}, null, 'completed')`;
  await sql`insert into nylorun.model_usage (id, effect_key, session_id, turn_id, agent_id, input_tokens,
    output_tokens, total_tokens, cached_tokens, cache_write_tokens, reasoning_tokens, cost_usd, duplicate, created_at)
    values ('u1', 'u1', 'completed', 't1', 'bot', 1, 1, 2, 0, 0, 0, 0.5, false, ${AT})`;
  await sql`insert into nylorun.model_budgets (scope, scope_id, period, limit_usd, updated_at) values
    ('agent', 'bot', 'day', 2.5, ${AT}), ('tenant', '*', 'month', 100, ${AT})`;

  const current = await openTenantDatabase({ sql, create });
  try {
    expect(current.migrated.to).toBe(shippedMigrations().length);
    const reasons = await current.store.tx(async (t) =>
      Object.fromEntries(
        await Promise.all(
          ["idle", "waiting", "completed", "flow", "older"].map(async (id) => [
            id,
            (await t.get<{ closedReason?: string }>("sessions", id))?.closedReason ?? null,
          ]),
        ),
      ),
    );
    // Every session not closed before is closed, whatever its status: its history stays.
    expect(reasons).toEqual({
      idle: "protocol_16",
      waiting: "protocol_16",
      completed: "protocol_16",
      flow: "protocol_16",
      older: "protocol_15",
    });
    const table = async (name: string) => (await sql`select to_regclass(${name}) as t`)[0]!.t as string | null;
    for (const gone of [
      "nylorun.definitions",
      "nylorun.environment_manifests",
      "nylorun.environments",
      "nylorun_streams.environment_events",
    ])
      expect(await table(gone), gone).toBeNull();
    for (const made of ["nylorun.agents", "nylorun.agent_manifests", "nylorun_streams.agent_events"])
      expect(await table(made), made).not.toBeNull();
    // The Environments went with their vaults, workspaces, disks and signals; the host's vault
    // and a session's artifact stay.
    expect(await sql`select id from nylorun.agents`).toEqual([]);
    expect(await sql`select id from nylorun.vaults`).toEqual([{ id: "host" }]);
    expect(await sql`select id from nylorun.sandbox_signals`).toEqual([]);
    expect(await sql`select id from nylorun.artifacts order by id`).toEqual([{ id: "af-session" }]);
    // The ledger names the manifest, and a budget of an agent is one of its manifest.
    expect(await sql`select id, manifest_name from nylorun.model_usage`).toEqual([{ id: "u1", manifest_name: "bot" }]);
    expect(await sql`select scope, scope_id from nylorun.model_budgets order by scope`).toEqual([
      { scope: "manifest", scope_id: "bot" },
      { scope: "tenant", scope_id: "*" },
    ]);
    await current.store.tx(async (t) => {
      expect(await t.modelUsageTotals({ scope: "manifest", id: "bot" })).toEqual({ calls: 1, tokens: 2, costUsd: 0.5 });
      expect(await t.listEnvironments()).toEqual([]);
      expect(await t.listAgentManifests()).toEqual([]);
      expect(await t.counts()).toMatchObject({ sessions: 5, runningSessions: 0, agentManifests: 0 });
    });
  } finally {
    await current.store.close();
  }
});
