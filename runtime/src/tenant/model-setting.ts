/**
 * The Tenant-level fixture model: Tenant setting `model.fixture`, seeded with
 * `fixtureModel: true` (`PUT /v1/tenant/config/seed`, Host feature `tenant-fixture-model`).
 * A Tenant with it answers every model call with the Runtime's deterministic fixture model
 * (`core/provider.ts` `toolFixtureModel`) instead of its configured model, whatever the Host
 * uses for other Tenants. `nylorun dev --ephemeral` seeds it on its temporary Tenant.
 *
 * The setting is read once per advance, in a transaction the advance makes anyway, so a Tenant
 * seeded on another node takes it at its next advance.
 */
import type { Tx } from "../store/types.js";

export const FIXTURE_MODEL_SETTING = "model.fixture";

/** Whether the Tenant uses the fixture model. */
export async function usesFixtureModel(t: Tx): Promise<boolean> {
  return (await t.getSetting(FIXTURE_MODEL_SETTING)) === "true";
}

/** Seeds the setting if absent. Returns whether it was inserted. */
export async function seedFixtureModel(t: Tx): Promise<boolean> {
  if ((await t.getSetting(FIXTURE_MODEL_SETTING)) !== undefined) return false;
  await t.putSetting(FIXTURE_MODEL_SETTING, "true");
  return true;
}
