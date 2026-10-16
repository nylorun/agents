/**
 * Protocol 15: migration `0029_protocol_15` closes each agent session whose pinned `runtime`
 * block holds the artifact tools, which are our harness's own since then (`closedReason:
 * "protocol_15"`), and leaves a workflow session and one closed before as they are. Each test
 * migrates through protocol 15 only: protocol 16's `0032_agents` closes every open session
 * (`protocol-16.test.ts`).
 */
import { expect, it } from "vitest";
import { newTenantId } from "@nylorun/core/compatibility";
import { shippedMigrations } from "../../src/store/postgres/migrate.js";
import { openTenantDatabase } from "../../src/store/postgres/tenant.js";
import { emptyTestDatabase } from "../support/database.js";

/** The migrations through protocol 15: up to `0032_agents` (protocol 16). */
function throughProtocol15() {
  const at = shippedMigrations().findIndex((migration) => migration.tag === "0032_agents");
  expect(at).toBeGreaterThan(0);
  return shippedMigrations().slice(0, at);
}

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

  const current = await openTenantDatabase({ sql: db.sql, create, migrations: throughProtocol15() });
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

it("closes the sessions that still pinned a runtime block, on the root or an agent used as a tool", async () => {
  const db = await emptyTestDatabase();
  const create = { tenantId: newTenantId(), name: "upgrade", principals: () => [] };
  const at = shippedMigrations().findIndex((migration) => migration.tag === "0030_protocol_15_runtime_block");
  expect(at).toBeGreaterThan(0);
  const old = await openTenantDatabase({ sql: db.sql, create, migrations: shippedMigrations().slice(0, at) });
  const manifest = (extra: object) => ({ manifestSchemaVersion: 7, id: "bot", ...extra });
  const session = (body: object) => ({ agentId: "bot", status: "completed", ...body });
  await old.store.tx(async (t) => {
    await t.put("sessions", "root", session({ manifest: manifest({ runtime: { tools: [{ name: "bash" }] } }) }));
    await t.put(
      "sessions",
      "child",
      session({ manifest: manifest({ tools: [{ name: "helper", agent: { id: "helper", runtime: { instructions: ["x"] } } }] }) }),
    );
    await t.put("sessions", "plain", session({ manifest: manifest({ tools: [{ name: "helper", agent: { id: "helper" } }] }) }));
    await t.put("sessions", "flow", session({ manifest: { kind: "workflow", id: "flow" } }));
  });
  await old.store.close();

  const current = await openTenantDatabase({ sql: db.sql, create, migrations: throughProtocol15() });
  try {
    const reasons = await current.store.tx(async (t) =>
      Object.fromEntries(
        await Promise.all(
          ["root", "child", "plain", "flow"].map(async (id) => [
            id,
            (await t.get<{ closedReason?: string }>("sessions", id))?.closedReason ?? null,
          ]),
        ),
      ),
    );
    expect(reasons).toEqual({ root: "protocol_15", child: "protocol_15", plain: null, flow: null });
  } finally {
    await current.store.close();
  }
});

it("closes the sessions that pinned the former MCP snapshot, which named tools for the model", async () => {
  const db = await emptyTestDatabase();
  const create = { tenantId: newTenantId(), name: "upgrade", principals: () => [] };
  const at = shippedMigrations().findIndex((migration) => migration.tag === "0031_protocol_15_mcp_snapshot");
  expect(at).toBeGreaterThan(0);
  const old = await openTenantDatabase({ sql: db.sql, create, migrations: shippedMigrations().slice(0, at) });
  const session = (body: object) => ({
    agentId: "bot",
    status: "completed",
    manifest: { manifestSchemaVersion: 7, id: "bot" },
    ...body,
  });
  await old.store.tx(async (t) => {
    await t.put("sessions", "v1", session({ mcpSnapshot: { snapshotSchemaVersion: 1, manifestHash: "h", mcpTools: [] } }));
    await t.put("sessions", "v2", session({ mcpSnapshot: { snapshotSchemaVersion: 2, manifestHash: "h", servers: [] } }));
    await t.put("sessions", "none", session({}));
    await t.put(
      "sessions",
      "older",
      session({ closedReason: "protocol_13", mcpSnapshot: { snapshotSchemaVersion: 1, manifestHash: "h", mcpTools: [] } }),
    );
  });
  await old.store.close();

  const current = await openTenantDatabase({ sql: db.sql, create, migrations: throughProtocol15() });
  try {
    const reasons = await current.store.tx(async (t) =>
      Object.fromEntries(
        await Promise.all(
          ["v1", "v2", "none", "older"].map(async (id) => [
            id,
            (await t.get<{ closedReason?: string }>("sessions", id))?.closedReason ?? null,
          ]),
        ),
      ),
    );
    expect(reasons).toEqual({ v1: "protocol_15", v2: null, none: null, older: "protocol_13" });
  } finally {
    await current.store.close();
  }
});
