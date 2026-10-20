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
import { CUSTOM_MODEL_SETTING_DEFAULTS, type ModelCallHeaderSource } from "@nylorun/core/contracts";

export type Selection = Readonly<{
  provider: string;
  model: string;
  custom?: Readonly<{
    baseUrl: string;
    /** Model Settings for the endpoint (Model Calls §7); defaults are deliberately small. */
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
    /** What the endpoint reads (protocol 12); text only unless it says so. */
    inputs?: readonly string[];
    compat?: Readonly<Record<string, unknown>>;
    /** Sent on every call (#493). */
    headers?: Readonly<Record<string, string>>;
    /** Resolved per call from the calling Agent (`call-headers.ts`, #493). */
    callHeaders?: Readonly<Record<string, ModelCallHeaderSource>>;
  }>;
}>;


/**
 * Build the pi-ai model registry from explicit credentials only.
 * Ambient process environment / provider env auth is never consulted (A7, A10).
 */
export function modelsFor(
  selection: Selection,
  credentials: CredentialStore,
  options: {
    environment?: boolean;
    authContext?: AuthContext;
    /** A custom endpoint's bearer read at each request instead of a stored key: the workload token (#496). */
    bearer?: () => Promise<string>;
  } = {},
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
    input: selection.custom.inputs?.includes("image") ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: selection.custom.contextWindow ?? CUSTOM_MODEL_SETTING_DEFAULTS.contextWindow,
    maxTokens: selection.custom.maxTokens ?? CUSTOM_MODEL_SETTING_DEFAULTS.maxTokens,
    ...(selection.custom.compat
      ? { compat: { ...selection.custom.compat } as Model<"openai-completions">["compat"] }
      : {}),
    ...(selection.custom.headers ? { headers: { ...selection.custom.headers } } : {}),
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
            if (options.bearer) return { type: "api_key" as const, auth: { apiKey: await options.bearer() } };
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
