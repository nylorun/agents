import { randomUUID } from "node:crypto";
import type { ManagementClient } from "@nylorun/admin";
import type { PromptedModel } from "./configure.js";

/** Set the installation's Tenant model provider (`PUT /v1/tenant/model`, Management API). */
export async function putHostModel(
  admin: ManagementClient,
  model: PromptedModel,
): ReturnType<ManagementClient["models"]["put"]> {
  return await admin.models.put({
    idempotencyKey: randomUUID(),
    provider: model.provider,
    model: model.model,
    ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
    ...(model.settings ? { settings: model.settings } : {}),
    // A prompted credential is complete: pi-ai's type leaves its fields optional.
    auth: model.auth as Parameters<ManagementClient["models"]["put"]>[0]["auth"],
  });
}
