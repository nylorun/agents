import type { Api, CredentialStore, Model } from "@earendil-works/pi-ai";
import type { HostModelCatalog, ModelInput } from "@nylorun/core/contracts";
import { addableInputs, capabilitiesOf } from "./capabilities.js";
import { hostModelDescriptor, type ModelBindingView } from "./descriptor.js";
import { modelsFor } from "./models.js";

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
 * by default), else its catalog's inputs and the operator's additions (`added`), as its
 * descriptor says (`hostModelDescriptor`). Undefined for no model, or one the catalog does not
 * know.
 */
export function inputsOfHostModel(
  view: { readonly configured: false } | ({ readonly configured: true } & ModelBindingView),
  added: Readonly<Record<string, readonly ModelInput[]>> = {},
): ModelInput[] | undefined {
  if (!view.configured) return undefined;
  return hostModelDescriptor(view, added)?.inputs;
}
