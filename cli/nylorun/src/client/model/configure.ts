import type { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AuthInteraction,
  Credential,
  CredentialStore,
  Model,
} from "@earendil-works/pi-ai";
import type { ManagementClient } from "@nylorun/admin";
import { nylorunHome } from "@nylorun/core/project";
import { CliError } from "../../errors.js";
import { loadPiAi, type PiAi } from "./pi-ai.js";

/** Exit 130 on SIGINT, 143 on SIGTERM. */
export class ConfigurationCancelled extends CliError {
  constructor(readonly signal: "SIGINT" | "SIGTERM") {
    super(`Provider configuration cancelled (${signal}).`, signal === "SIGINT" ? 130 : 143);
    this.name = "ConfigurationCancelled";
  }
}

export type PromptedModel = {
  provider: string;
  model: string;
  baseUrl?: string;
  /** A custom endpoint's context window and output limit, when given. */
  settings?: { contextWindow?: number; maxTokens?: number };
  auth: Credential;
};

export type ModelCatalog = {
  providers: {
    id: string;
    name: string;
    models: { id: string; name: string }[];
    auth?: { apiKey?: unknown; oauth?: unknown };
  }[];
};

export type Selection = Readonly<{
  provider: string;
  model: string;
  custom?: Readonly<{ baseUrl: string }>;
}>;

/**
 * Build a pi-ai registry for interactive login. Catalog listing prefers the
 * Tenant API payload when provided (F2-4).
 */
function modelsFor(
  { builtinModels, createProvider, stream, streamSimple }: PiAi,
  selection: Selection,
  credentials: CredentialStore,
  catalog?: ModelCatalog,
) {
  const models = builtinModels({ credentials });
  if (selection.custom) {
    const model: Model<"openai-completions"> = {
      id: selection.model,
      name: selection.model,
      api: "openai-completions",
      provider: "custom",
      baseUrl: selection.custom.baseUrl,
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    };
    models.setProvider(
      createProvider({
        id: "custom",
        name: "Custom OpenAI-compatible",
        baseUrl: selection.custom.baseUrl,
        auth: {
          apiKey: {
            name: "Custom API key",
            async login(interaction) {
              const key = await interaction.prompt({
                type: "secret",
                message: "API key",
              });
              return { type: "api_key", key: key.trim() };
            },
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
  }
  return {
    models,
    listProviders(): { id: string; name: string; auth: { apiKey?: unknown; oauth?: unknown } }[] {
      if (catalog?.providers.length) {
        return catalog.providers.map((provider) => {
          const live = models.getProvider(provider.id);
          return {
            id: provider.id,
            name: provider.name,
            auth: {
              ...(live?.auth?.apiKey || provider.auth?.apiKey
                ? { apiKey: live?.auth?.apiKey ?? {} }
                : {}),
              ...(live?.auth?.oauth || provider.auth?.oauth
                ? { oauth: live?.auth?.oauth ?? {} }
                : {}),
              ...(!live?.auth?.apiKey &&
              !live?.auth?.oauth &&
              !provider.auth?.apiKey &&
              !provider.auth?.oauth
                ? { apiKey: {} }
                : {}),
            },
          };
        });
      }
      return models.getProviders().map((provider) => ({
        id: provider.id,
        name: provider.name,
        auth: {
          ...(provider.auth?.apiKey ? { apiKey: provider.auth.apiKey } : {}),
          ...(provider.auth?.oauth ? { oauth: provider.auth.oauth } : {}),
        },
      }));
    },
    listModels(providerId: string): { id: string; name: string }[] {
      const fromCatalog = catalog?.providers.find((p) => p.id === providerId);
      if (fromCatalog?.models.length) return fromCatalog.models;
      return models.getModels(providerId).map((model) => ({
        id: model.id,
        name: model.name,
      }));
    },
  };
}

/** The Tenant's model catalog (`GET /v1/tenant/models`, Management API). */
export async function fetchModelCatalog(admin: ManagementClient): Promise<ModelCatalog> {
  return await admin.models.catalog();
}

// Internal options also allow isolated prompt tests without changing process globals.
export async function configureProvider(
  options: {
    signal?: AbortSignal;
    root?: string;
    input?: Readable;
    output?: Writable;
    /** Tenant API catalog from GET /v1/tenant/models. */
    catalog?: ModelCatalog;
    /** This installation's stable id, for OAuth flows that need one (OpenAI). */
    deviceId?: () => string;
  } = {},
): Promise<PromptedModel> {
  const login = { getDeviceId: options.deviceId ?? installationId };
  const output = options.output ?? process.stdout;
  const controller = new AbortController();
  const signal = controller.signal;
  const forwardAbort = () => controller.abort(options.signal!.reason);
  options.signal?.throwIfAborted();
  const ai = await loadPiAi();
  options.signal?.throwIfAborted();
  let captured: Credential | undefined;
  const store: CredentialStore = {
    async read() {
      return undefined;
    },
    async list() {
      return [];
    },
    async delete() {},
    async modify(_id, fn) {
      const next = await fn(captured);
      if (next?.type === "api_key" && !(next as { key?: string }).key)
        throw new Error("An API key is required.");
      if (next) captured = next;
      return next ?? captured;
    },
  };
  const registry = modelsFor(ai, { provider: "", model: "" }, store, options.catalog);
  const providers = registry.listProviders();
  const prompt = createInterface({
    input: options.input ?? process.stdin,
    output,
  });

  const onInt = () => controller.abort(new ConfigurationCancelled("SIGINT"));
  const onClose = () =>
    controller.abort(
      new Error("Configuration input closed before setup completed."),
    );
  const closeOnAbort = () => prompt.close();
  prompt.on("SIGINT", onInt);
  prompt.on("close", onClose);
  signal.addEventListener("abort", closeOnAbort, { once: true });
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  if (options.signal?.aborted) forwardAbort();

  async function question(message: string): Promise<string> {
    signal.throwIfAborted();
    return prompt.question(message, { signal });
  }

  /** A positive whole number of tokens, or undefined for the default. */
  async function tokens(message: string): Promise<number | undefined> {
    const answer = (await question(message)).trim();
    if (!answer) return undefined;
    const value = Number(answer);
    if (!Number.isInteger(value) || value < 1)
      throw new Error(`${message.split(" (")[0]} must be a whole number of tokens.`);
    return value;
  }

  try {
    signal.throwIfAborted();
    output.write("0. Custom OpenAI-compatible provider\n");
    providers.forEach((provider, index) =>
      output.write(`${index + 1}. ${provider.name} (${provider.id})\n`),
    );
    const choice = Number(await question("Choose a provider: "));
    if (choice === 0) {
      const baseUrl = (await question("OpenAI-compatible base URL: "))
        .trim()
        .replace(/\/$/, "");
      const model = (await question("Model id: ")).trim();
      if (!baseUrl || !model)
        throw new Error("A base URL and model id are required.");
      const contextWindow = await tokens(
        "Context window in tokens (Enter for 32768): ",
      );
      const maxTokens = await tokens("Max output tokens (Enter for 8192): ");
      const settings = {
        ...(contextWindow ? { contextWindow } : {}),
        ...(maxTokens ? { maxTokens } : {}),
      };
      const selection: Selection = {
        provider: "custom",
        model,
        custom: { baseUrl },
      };
      const custom = modelsFor(ai, selection, store, options.catalog);
      if (!(await custom.models.checkAuth("custom", { signal })))
        await custom.models.login("custom", "api_key", interaction(), login);
      return {
        ...prompted(selection),
        ...(Object.keys(settings).length ? { settings } : {}),
      };
    } else {
      const chosen = providers[choice - 1];
      if (!chosen) throw new Error("Choose a listed provider.");
      const available = registry.listModels(chosen.id);
      available.forEach((model, index) =>
        output.write(`${index + 1}. ${model.name} (${model.id})\n`),
      );
      const model = available[Number(await question("Choose a model: ")) - 1];
      if (!model) throw new Error("Choose a listed model.");
      if (!(await registry.models.checkAuth(chosen.id, { signal }))) {
        let method: "api_key" | "oauth" = chosen.auth.apiKey
          ? "api_key"
          : "oauth";
        if (chosen.auth.apiKey && chosen.auth.oauth) {
          const answer = (
            await question(
              "Choose authentication: 1. API key (default), 2. OAuth: ",
            )
          ).trim();
          if (answer && !["1", "2"].includes(answer))
            throw new Error("Choose authentication 1 or 2.");
          if (answer === "2") method = "oauth";
        }
        await registry.models.login(chosen.id, method, interaction(), login);
      }
      return prompted({ provider: chosen.id, model: model.id });
    }
  } catch (error) {
    throw signal.aborted ? signal.reason : error;
  } finally {
    options.signal?.removeEventListener("abort", forwardAbort);
    signal.removeEventListener("abort", closeOnAbort);
    prompt.removeListener("SIGINT", onInt);
    prompt.removeListener("close", onClose);
    prompt.close();
  }

  function interaction(): AuthInteraction {
    return {
      signal,
      prompt: async (item) => {
        if (item.type !== "select") return question(item.message + ": ");
        item.options.forEach((option, index) =>
          output.write(`${index + 1}. ${option.label}\n`),
        );
        const answer = (await question(item.message + " ")).trim();
        const option =
          item.options.find((option) => option.id === answer) ??
          item.options[Number(answer) - 1];
        if (!option) throw new Error("Choose a listed authentication option.");
        return option.id;
      },
      notify: (event) => {
        output.write(
          ("url" in event
            ? event.url
            : "verificationUri" in event
              ? event.verificationUri
              : event.message) + "\n",
        );
      },
    };
  }

  function prompted(selection: Selection): PromptedModel {
    signal.throwIfAborted();
    if (!captured)
      throw new Error("An API key or OAuth credential is required.");
    output.write("Provider configuration saved.\n");
    return {
      provider: selection.provider,
      model: selection.model,
      ...(selection.custom?.baseUrl
        ? { baseUrl: selection.custom.baseUrl }
        : {}),
      auth: captured,
    };
  }
}

/**
 * A stable id for this CLI installation, created on first use under the Host root.
 * OpenAI's "Sign in with ChatGPT" sends it as the agent host id.
 */
export function installationId(home: string = nylorunHome()): string {
  const file = join(home, "cli-installation-id");
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    /* Created below on first use. */
  }
  const id = randomUUID();
  mkdirSync(home, { recursive: true });
  writeFileSync(file, `${id}\n`, { mode: 0o600 });
  return id;
}
