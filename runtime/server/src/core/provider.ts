import type { HostEffect } from "@nylorun/harness/run";
import type { RuntimeModelCall } from "../contracts.js";
import { fixtureAnswer } from "../gates/fixture-model.js";
/** Providers are runtime-owned; neither credentials nor model selection enter manifests. */
export type ModelProvider = (
  effect: HostEffect,
  signal: AbortSignal,
) => Promise<unknown>;
export function scriptedModel(
  output = "Scripted development response",
): ModelProvider {
  return async () => ({ output: [{ type: "text", text: output }] });
}
/** A configured gateway receives the complete harness model call, including history and schemas. */
export function gatewayModel(options: {
  url: string;
  token: string;
  model: string;
}): ModelProvider {
  return async (effect, signal) => {
    const response = await fetch(options.url, {
      method: "POST",
      signal,
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: options.model,
        call: effect.input,
        context: effect.context,
      }),
    });
    if (!response.ok)
      throw new Error(`Model gateway returned ${response.status}`);
    return response.json();
  };
}

/**
 * The fixture model as a provider (`model: {kind: "fixture"}` in the Runtime's config). The Tenant
 * setting `model.fixture` is answered by the Model Gate instead (R4.3); both answer the same way
 * (`gates/fixture-model.ts`).
 */
export function toolFixtureModel(): ModelProvider {
  return async (effect, signal) => fixtureAnswer(effect.input as RuntimeModelCall, signal);
}
