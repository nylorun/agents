/**
 * The Tenant's model settings: the fixture model, and the inputs the operator added to catalog
 * models (`model.inputs`, below).
 *
 * The Tenant-level fixture model: Tenant setting `model.fixture`, seeded with
 * `fixtureModel: true` (`PUT /v1/tenant/config/seed`, Host feature `tenant-fixture-model`).
 * A Tenant with it answers every model call with the Runtime's deterministic fixture model
 * (`core/provider.ts` `toolFixtureModel`) instead of its configured model. Smoke checks seed
 * it (scripts/lib/stack-tenant.mjs).
 *
 * The setting is read once per advance, in a transaction the advance makes anyway, so a Tenant
 * seeded on another node takes it at its next advance.
 */
import { ModelInputSchema, type ModelInput } from "@nylorun/core/contracts";
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

/**
 * The inputs the operator added to catalog models (protocol 12, `PUT /v1/tenant/models/inputs`):
 * Tenant setting `model.inputs`, JSON `{ "<provider>/<model>": ModelInput[] }`. A custom
 * endpoint keeps its own in its `settings.inputs` instead.
 */
export const MODEL_INPUTS_SETTING = "model.inputs";

/** The added inputs by `<provider>/<model>`. Bad JSON, keys and inputs are left out: never throws. */
export async function readAddedInputs(
  t: Pick<Tx, "getSetting">,
): Promise<Record<string, ModelInput[]>> {
  const raw = await t.getSetting(MODEL_INPUTS_SETTING);
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const added: Record<string, ModelInput[]> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!key.includes("/") || !Array.isArray(value)) continue;
    added[key] = value.filter((input): input is ModelInput => ModelInputSchema.safeParse(input).success);
  }
  return added;
}

/** Sets the inputs added to `<provider>/<model>`; an empty list removes its entry. */
export async function writeAddedInputs(
  t: Pick<Tx, "getSetting" | "putSetting">,
  key: string,
  inputs: readonly ModelInput[],
): Promise<void> {
  const added = await readAddedInputs(t);
  if (inputs.length === 0) delete added[key];
  else added[key] = [...inputs];
  await t.putSetting(MODEL_INPUTS_SETTING, JSON.stringify(added));
}
