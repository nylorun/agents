/**
 * The model descriptor (protocol 15): the Tenant's model as a harness learns it in
 * `turn.start.model` — its provider and id, what it reads, its context window and output limit.
 * One resolution serves the descriptor, the catalog's inputs and the Model Gate: the binding
 * becomes a pi-ai `Selection` (`selectionOf`), the registry finds the model, and
 * `describeModel` reads it with the operator's additions. So what a harness is told and what the
 * gate takes cannot disagree.
 */
import type { Api, CredentialStore, Model } from "@earendil-works/pi-ai";
import {
  MODEL_INPUTS,
  type CustomModelSettings,
  type HostModelView,
  type ModelInput,
} from "@nylorun/core/contracts";
import type { ModelDescriptor } from "@nylorun/core/harness-api";
import type { SessionStore } from "../store/types.js";
import { readAddedInputs, usesFixtureModel } from "../tenant/model-setting.js";
import { capabilitiesOf } from "./capabilities.js";
import { CUSTOM_CONTEXT_WINDOW, CUSTOM_MAX_TOKENS, modelsFor, type Selection } from "./models.js";

/** A configured model: its provider and model, and a custom endpoint's address and settings. */
export interface ModelBindingView {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly settings?: CustomModelSettings;
}

/**
 * The pi-ai selection for `binding`. A call may name another model of the same provider
 * (`requested`, as `<model>` or `<provider>/<model>`); a custom endpoint carries its settings.
 */
export function selectionOf(binding: ModelBindingView, requested?: string): Selection {
  return {
    provider: binding.provider,
    model: requested?.startsWith(`${binding.provider}/`)
      ? requested.slice(binding.provider.length + 1)
      : (requested ?? binding.model),
    ...(binding.baseUrl ? { custom: { baseUrl: binding.baseUrl, ...(binding.settings ?? {}) } } : {}),
  };
}

/** The inputs the operator added that apply to `selection`: a custom endpoint's own, or the Tenant's. */
export function addedInputsOf(
  selection: Selection,
  binding: Pick<ModelBindingView, "settings">,
  added: Readonly<Record<string, readonly ModelInput[]>>,
): readonly ModelInput[] | undefined {
  return selection.custom ? binding.settings?.inputs : added[`${selection.provider}/${selection.model}`];
}

/** A pi-ai model as a descriptor, with the inputs the operator added (`capabilitiesOf`). */
export function describeModel(found: Model<Api>, added?: readonly ModelInput[]): ModelDescriptor {
  return {
    provider: found.provider,
    id: found.id,
    inputs: capabilitiesOf(found, added).inputs,
    contextWindow: found.contextWindow,
    maxOutputTokens: found.maxTokens,
    ...(found.reasoning === undefined ? {} : { reasoning: found.reasoning }),
  };
}

/** The fixture model (`model.fixture`): it reads every input, since it ignores files. */
export const FIXTURE_DESCRIPTOR: ModelDescriptor = Object.freeze({
  provider: "fixture",
  id: "fixture",
  inputs: [...MODEL_INPUTS],
  contextWindow: CUSTOM_CONTEXT_WINDOW,
  maxOutputTokens: CUSTOM_MAX_TOKENS,
});

const emptyStore: CredentialStore = {
  async read() {
    return undefined;
  },
  async list() {
    return [];
  },
  async modify(_providerId, fn) {
    return fn(undefined);
  },
  async delete() {},
};

/**
 * The descriptor of a configured model (`binding`), with the Tenant's added inputs; undefined
 * for a model the catalog does not know. No credential is read.
 */
export function hostModelDescriptor(
  binding: ModelBindingView,
  added: Readonly<Record<string, readonly ModelInput[]>> = {},
): ModelDescriptor | undefined {
  const selection = selectionOf(binding);
  const found = modelsFor(selection, emptyStore, { environment: false }).getModel(
    selection.provider,
    selection.model,
  );
  return found && describeModel(found, addedInputsOf(selection, binding, added));
}

/**
 * The model the Tenant's turns use now: the fixture model's descriptor when the Tenant uses it,
 * else its active model's; undefined when none is configured (a test's scripted provider, say).
 */
export async function currentModelDescriptor(ctx: {
  readonly store: SessionStore;
  readonly vault: { getHostModel(): Promise<HostModelView> };
}): Promise<ModelDescriptor | undefined> {
  const { fixture, added } = await ctx.store.tx(async (t) => ({
    fixture: await usesFixtureModel(t),
    added: await readAddedInputs(t),
  }));
  if (fixture) return FIXTURE_DESCRIPTOR;
  const view = await ctx.vault.getHostModel();
  return view.configured ? hostModelDescriptor(view, added) : undefined;
}

/**
 * The context window, in tokens, of the Tenant's model now; without one, or one the catalog does
 * not know, it is assumed small (`CUSTOM_CONTEXT_WINDOW`), as for a custom endpoint.
 */
export async function currentContextWindow(
  ctx: Parameters<typeof currentModelDescriptor>[0],
): Promise<number> {
  return (await currentModelDescriptor(ctx))?.contextWindow ?? CUSTOM_CONTEXT_WINDOW;
}
