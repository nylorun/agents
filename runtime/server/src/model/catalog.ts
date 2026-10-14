import type { Api, CredentialStore, Model } from "@earendil-works/pi-ai";
import type { HostModelCatalog, HostModelView, ModelInput } from "@nylorun/core/contracts";
import type { SessionStore } from "../store/types.js";
import { readAddedInputs } from "../tenant/model-setting.js";
import { addableInputs, capabilitiesOf } from "./capabilities.js";
import { CUSTOM_CONTEXT_WINDOW, modelsFor } from "./models.js";

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

export type { HostModelCatalog };

/**
 * The context window, in tokens, of the Tenant's model (`GET /v1/tenant/model`'s view): the
 * custom endpoint's setting, else the provider catalog's. A model the catalog does not know, or
 * none configured, is assumed small (`CUSTOM_CONTEXT_WINDOW`), as for a custom endpoint.
 */
export function contextWindowOf(
  view: { configured: boolean; provider?: string; model?: string; baseUrl?: string; settings?: { contextWindow?: number } },
): number {
  if (!view.configured || !view.provider || !view.model) return CUSTOM_CONTEXT_WINDOW;
  if (view.baseUrl) return view.settings?.contextWindow ?? CUSTOM_CONTEXT_WINDOW;
  const models = modelsFor({ provider: "", model: "" }, emptyStore, { environment: false });
  return models.getModel(view.provider, view.model)?.contextWindow ?? CUSTOM_CONTEXT_WINDOW;
}

/**
 * Public provider and model names, and what each model reads with the operator's additions
 * (`added`, by `<provider>/<model>`) and what may be added (protocol 12). No credentials.
 */
export function hostModelCatalog(
  added: Readonly<Record<string, readonly ModelInput[]>> = {},
): HostModelCatalog {
  const models = modelsFor({ provider: "", model: "" }, emptyStore, {
    environment: false,
  });
  return {
    providers: models.getProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
      models: models.getModels(provider.id).map((model) => ({
        id: model.id,
        name: model.name,
        inputs: capabilitiesOf(model, added[`${provider.id}/${model.id}`]).inputs,
        addableInputs: addableInputs(model),
      })),
    })),
  };
}

/** A catalog model, by provider and id; undefined for one the catalog does not know. */
export function catalogModel(provider: string, model: string): Model<Api> | undefined {
  return modelsFor({ provider: "", model: "" }, emptyStore, { environment: false }).getModel(
    provider,
    model,
  );
}

/**
 * What a configured model reads (protocol 12): a custom endpoint's `settings.inputs` (text only
 * by default), else its catalog's inputs and the operator's additions (`added`). Undefined for no
 * model, or one the catalog does not know.
 */
export function inputsOfHostModel(
  view: {
    configured: boolean;
    provider?: string;
    model?: string;
    baseUrl?: string;
    settings?: { inputs?: readonly ModelInput[] };
  },
  added: Readonly<Record<string, readonly ModelInput[]>> = {},
): ModelInput[] | undefined {
  if (!view.configured || !view.provider || !view.model) return undefined;
  if (view.baseUrl) {
    const inputs = view.settings?.inputs ?? [];
    return capabilitiesOf(
      { api: "openai-completions", input: inputs.includes("image") ? ["text", "image"] : ["text"] },
      inputs,
    ).inputs;
  }
  const model = catalogModel(view.provider, view.model);
  return model && capabilitiesOf(model, added[`${view.provider}/${view.model}`]).inputs;
}

/**
 * What the Tenant's model reads now, for the accept check and `read_artifact`: undefined when no
 * model is in the vault (a test's fake provider, say), and the check is skipped.
 */
export async function currentModelInputs(ctx: {
  readonly store: SessionStore;
  readonly vault: { getHostModel(): Promise<HostModelView> };
}): Promise<ModelInput[] | undefined> {
  const view = await ctx.vault.getHostModel();
  if (!view.configured) return undefined;
  return inputsOfHostModel(view, await ctx.store.tx((t) => readAddedInputs(t)));
}
