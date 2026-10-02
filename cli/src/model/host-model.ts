import { randomUUID } from "node:crypto";
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from "@nylorun/agents";
import type { PromptedModel } from "./configure.js";

/** Wire shape of GET/PUT `/v1/tenant/model` — local copy so CLI stays off `@nylorun/core`. */
type HostModelView =
  | { readonly configured: false }
  | {
      readonly configured: true;
      readonly provider: string;
      readonly model: string;
      readonly authType: "api_key" | "oauth";
      readonly baseUrl?: string;
      readonly settings?: { contextWindow?: number; maxTokens?: number };
    };

/** Set the installation's Tenant model provider (`PUT /v1/tenant/model`). */
export async function putHostModel(
  runtimeUrl: string,
  serverKey: string,
  model: PromptedModel,
  fetchImpl: typeof fetch = fetch,
): Promise<HostModelView> {
  const response = await fetchImpl(`${runtimeUrl}/v1/tenant/model`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${serverKey}`,
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      provider: model.provider,
      model: model.model,
      ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
      ...(model.settings ? { settings: model.settings } : {}),
      auth: model.auth,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    message?: string;
  };
  if (!response.ok)
    throw new Error(
      body.message ?? `Runtime rejected the model provider (${response.status})`,
    );
  return body as HostModelView;
}
