import type { CredentialStore } from "@earendil-works/pi-ai";
import type { HostModelCatalog } from "@nylorun/core/contracts";
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
