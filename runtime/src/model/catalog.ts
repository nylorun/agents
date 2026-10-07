import type { CredentialStore } from "@earendil-works/pi-ai";
import type { HostModelCatalog } from "@nylorun/core/contracts";
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

/** Public provider and model names. No credentials. */
export function hostModelCatalog(): HostModelCatalog {
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
      })),
    })),
  };
}
