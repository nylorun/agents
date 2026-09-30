import {
  createProvider,
  type AuthContext,
  type CredentialStore,
  type Model,
} from "@earendil-works/pi-ai";
import {
  stream,
  streamSimple,
} from "@earendil-works/pi-ai/api/openai-completions";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

export type Selection = Readonly<{
  provider: string;
  model: string;
  custom?: Readonly<{
    baseUrl: string;
    /** Model Settings for the endpoint (Model Calls §7); defaults are deliberately small. */
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
    compat?: Readonly<Record<string, unknown>>;
  }>;
}>;

/** A custom endpoint whose window is unknown is assumed small: an early compaction beats a failed call. */
export const CUSTOM_CONTEXT_WINDOW = 32_768;
export const CUSTOM_MAX_TOKENS = 8_192;

/**
 * Build the pi-ai model registry from explicit credentials only.
 * Ambient process environment / provider env auth is never consulted (A7, A10).
 */
export function modelsFor(
  selection: Selection,
  credentials: CredentialStore,
  options: { environment?: boolean; authContext?: AuthContext } = {},
) {
  if (options.environment) {
    throw new Error(
      "Ambient model environment is not supported; pass credentials explicitly",
    );
  }
  const models = builtinModels({
    credentials,
    ...(options.authContext ? { authContext: options.authContext } : {}),
  });
  if (!selection.custom) return models;
  const model: Model<"openai-completions"> = {
    id: selection.model,
    name: selection.model,
    api: "openai-completions",
    provider: "custom",
    baseUrl: selection.custom.baseUrl,
    reasoning: selection.custom.reasoning ?? false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: selection.custom.contextWindow ?? CUSTOM_CONTEXT_WINDOW,
    maxTokens: selection.custom.maxTokens ?? CUSTOM_MAX_TOKENS,
    ...(selection.custom.compat
      ? { compat: { ...selection.custom.compat } as Model<"openai-completions">["compat"] }
      : {}),
  };
  models.setProvider(
    createProvider({
      id: "custom",
      name: "Custom OpenAI-compatible",
      baseUrl: selection.custom.baseUrl,
      auth: {
        apiKey: {
          name: "Custom API key",
          async resolve() {
            const credential = await credentials.read("custom");
            if (!credential || credential.type !== "api_key") return undefined;
            const key = (credential as { key?: string }).key;
            if (!key) return undefined;
            return { type: "api_key" as const, auth: { apiKey: key } };
          },
        },
      },
      models: [model],
      api: { stream, streamSimple },
    }),
  );
  return models;
}
