/**
 * Protocol 15: migration `0029_protocol_15` closes each agent session whose pinned `runtime`
 * block holds the artifact tools, which are our harness's own since then (`closedReason:
 * "protocol_15"`), and leaves a workflow session and one closed before as they are.
 */
import { expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { shippedMigrations } from "../../src/store/postgres/migrate.js";
import { openTenantDatabase } from "../../src/store/postgres/tenant.js";
import { emptyTestDatabase } from "../support/database.js";

it("closes the sessions that pinned the artifact tools, and only those", async () => {
  const db = await emptyTestDatabase();
  const create = { tenantId: newTenantId(), name: "upgrade", principals: () => [] };
  const at = shippedMigrations().findIndex((migration) => migration.tag === "0029_protocol_15");
  expect(at).toBeGreaterThan(0);
  // The database as protocol 14 left it.
  const old = await openTenantDatabase({ sql: db.sql, create, migrations: shippedMigrations().slice(0, at) });
  const tool = (name: string) => ({ name, inputSchema: { type: "object" } });
  const agent = (tools: string[]) => ({
    agentId: "bot",
    status: "completed",
    manifest: { manifestSchemaVersion: 7, id: "bot", runtime: { tools: tools.map(tool) } },
  });
  await old.store.tx(async (t) => {
    await t.put("sessions", "pinned", agent(["read_artifact"]));
    await t.put("sessions", "sandboxed", agent(["bash", "save_artifact", "read_artifact"]));
    await t.put("sessions", "flow", { agentId: "flow", status: "completed", manifest: { kind: "workflow", id: "flow" } });
    await t.put("sessions", "older", { ...agent(["read_artifact"]), closedReason: "protocol_13" });
  });
  await old.store.close();

  const current = await openTenantDatabase({ sql: db.sql, create });
  try {
    const reasons = await current.store.tx(async (t) =>
      Object.fromEntries(
        await Promise.all(
          ["pinned", "sandboxed", "flow", "older"].map(async (id) => [
            id,
            (await t.get<{ closedReason?: string }>("sessions", id))?.closedReason ?? null,
          ]),
        ),
      ),
    );
    expect(reasons).toEqual({ pinned: "protocol_15", sandboxed: "protocol_15", flow: null, older: "protocol_13" });
  } finally {
    await current.store.close();
  }
});
