import {
  parseJsonWithRepair,
  retryAssistantCall,
  type AssistantMessage,
  type AuthContext,
  type Context,
  type Credential,
  type CredentialStore,
  type ImageContent,
  type Message,
  type Model,
  type Api,
  type TextContent,
  type Tool,
  type Usage,
} from "@earendil-works/pi-ai";
import type {
  JsonValue,
  JsonObject,
  PromptContentPart,
  PromptItem,
  RuntimeModelAdapter,
  RuntimeModelCandidate,
} from "../contracts.js";
import type { ModelFailureOutcome } from "@nylorun/core/define";
import type { RuntimeMedia } from "../adapters/media.js";
import { scrub } from "../redact.js";
import type { HostModelSecret } from "../vault/service.js";
import { classifyAssistantError, failure } from "./classify.js";
import { modelsFor } from "./models.js";
import { projectSecrets } from "./settings.js";

export interface ModelPreview {
  readonly invocationId: string;
  readonly text: string;
}

/** Retry, timeout and cache settings for one model call (Model Calls §5, §6). */
export interface ModelCallSettings {
  /** Attempts per call, including the first. Default 3. */
  readonly attempts?: number;
  /** Base delay between attempts; doubles each time, with jitter. Default 2 s. */
  readonly retryBaseDelayMs?: number;
  /** A stream with no event for this long is aborted and retried. Default 300 s. */
  readonly idleTimeoutMs?: number;
  /** Whole-request timeout passed to the provider SDK. Default 600 s. */
  readonly requestTimeoutMs?: number;
}

export interface PiModelOptions {
  readonly root?: string;
  readonly onPreview?: (preview: ModelPreview) => void;
  readonly media?: Pick<RuntimeMedia, "dataUrl">;
  readonly readHostModel?: () =>
    | HostModelSecret
    | undefined
    | Promise<HostModelSecret | undefined>;
  readonly writeHostCredential?: (
    credential: Credential,
  ) => void | Promise<void>;
  readonly settings?: ModelCallSettings;
}

const OPENAI_COMPATIBLE_REASONING = /^reasoning(_content|_text)?$/;

const emptyUsage = (): Usage => ({
  input: 0,
  output: 0,
  totalTokens: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/** Provider auth never reads the process environment or files; credentials come from the vault. */
const noAmbientAuth: AuthContext = {
  async env() {
    return undefined;
  },
  async fileExists() {
    return false;
  },
};

class InvalidRequest extends Error {}

/**
 * Node model adapter. Local provider configuration is read only when invoked.
 * A provider failure is returned as a failure outcome; only an abort is thrown.
 */
export function piModel(options: PiModelOptions = {}): RuntimeModelAdapter {
  const settings = {
    attempts: Math.max(1, options.settings?.attempts ?? 3),
    retryBaseDelayMs: options.settings?.retryBaseDelayMs ?? 2_000,
    idleTimeoutMs: options.settings?.idleTimeoutMs ?? 300_000,
    requestTimeoutMs: options.settings?.requestTimeoutMs ?? 600_000,
  };
  return async (call, context) => {
    context.signal.throwIfAborted();
    const root = options.root ?? "";
    const stored = await options.readHostModel?.();
    if (!stored)
      return failure(
        "auth",
        "Model provider is not configured. Set it in Studio, or run nylo configure (npx @nylorun/cli configure).",
        false,
      );
    const secrets = [
      ...projectSecrets(root),
      ...credentialSecrets(stored.credential),
    ];
    const redacted = (outcome: ModelFailureOutcome): ModelFailureOutcome => ({
      ...outcome,
      message: String(scrub(outcome.message, secrets)),
    });
    const requested = call.model?.id;
    const selection = {
      provider: stored.provider,
      model: requested?.startsWith(`${stored.provider}/`)
        ? requested.slice(stored.provider.length + 1)
        : (requested ?? stored.model),
      ...(stored.baseUrl
        ? { custom: { baseUrl: stored.baseUrl, ...(stored.settings ?? {}) } }
        : {}),
    };
    const registry = modelsFor(
      selection,
      hostCredentialStore(stored, options.writeHostCredential),
      { environment: false, authContext: noAmbientAuth },
    );
    const selected = registry.getModel(selection.provider, selection.model);
    if (!selected)
      return failure(
        "invalid_request",
        "Unknown model. Run nylo configure (npx @nylorun/cli configure).",
        false,
      );
    let request: Context;
    try {
      request = await buildContext(call, selected, options);
    } catch (error) {
      if (error instanceof InvalidRequest)
        return failure("invalid_request", error.message, false);
      throw error;
    }
    // Publish only portable references, never the materialized provider image bytes.
    context.reportPreparedCall?.({
      adapter: "runtime.pi-ai",
      call: scrub(call, secrets) as JsonValue,
    });
    const invocationOptions = {
      temperature: call.model?.controls?.temperature,
      maxTokens: call.model?.controls?.maxOutputTokens,
      ...(call.model?.config
        ? { samplingParams: { ...call.model.config } }
        : {}),
      // The session id keys the provider's prompt cache and session affinity.
      sessionId: call.executionId,
      cacheRetention: "short" as const,
      timeoutMs: settings.requestTimeoutMs,
      maxRetries: 2,
      maxRetryDelayMs: 60_000,
    };
    const attempt = async (): Promise<AssistantMessage> => {
      const idle = new AbortController();
      const signal = AbortSignal.any([context.signal, idle.signal]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => idle.abort(), settings.idleTimeoutMs);
      };
      arm();
      try {
        const stream = registry.streamSimple(selected, request, {
          ...invocationOptions,
          signal,
        });
        for await (const event of stream) {
          arm();
          if (event.type === "text_delta" && options.onPreview) {
            try {
              void Promise.resolve(
                options.onPreview({
                  invocationId: context.invocationId,
                  text: event.delta,
                }),
              ).catch(() => {});
            } catch {
              /* Preview delivery is independent. */
            }
          }
        }
        const response = await stream.result();
        if (idle.signal.aborted && !context.signal.aborted)
          return idleTimeout(selected, settings.idleTimeoutMs);
        return response;
      } catch (error) {
        if (context.signal.aborted) throw error;
        if (idle.signal.aborted)
          return idleTimeout(selected, settings.idleTimeoutMs);
        return {
          ...failedMessage(selected),
          errorMessage: error instanceof Error ? error.message : String(error),
        };
      } finally {
        clearTimeout(timer);
      }
    };
    const response = await retryAssistantCall(
      attempt,
      {
        enabled: settings.attempts > 1,
        maxRetries: settings.attempts - 1,
        baseDelayMs: settings.retryBaseDelayMs,
      },
      context.signal,
    );
    // An abort is never a failure outcome: the host decides what it means.
    context.signal.throwIfAborted();
    if (response.stopReason === "aborted")
      return redacted(failure("transient", "The provider stream was aborted.", true));
    if (response.stopReason === "error") {
      const outcome = classifyAssistantError(response, selected.contextWindow);
      return redacted(
        outcome.code === "auth"
          ? {
              ...outcome,
              message: `${outcome.message} Update the provider credential in Studio's Model Settings, or run nylo configure.`,
            }
          : outcome,
      );
    }
    if (response.stopReason === "deferred")
      return failure(
        "invalid_request",
        "The provider deferred the response, which the Runtime does not request.",
        false,
      );
    const output: RuntimeModelCandidate["output"][number][] = [];
    for (const part of response.content) {
      if (part.type === "text")
        output.push({
          type: "text",
          text: part.text,
          ...metadataFor(selected, part.textSignature),
        });
      else if (part.type === "thinking")
        output.push({
          type: "reasoning",
          text: part.thinking,
          ...metadataFor(selected, part.thinkingSignature, part.redacted),
        });
      else if (part.type === "toolCall")
        output.push({
          type: "tool-call",
          id: part.id,
          name: part.name,
          args: part.arguments,
          ...metadataFor(selected, part.thoughtSignature),
        });
    }
    if (
      call.outputSchema &&
      !output.some((part) => part.type === "tool-call")
    ) {
      const text = output
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      let value: JsonValue;
      try {
        value = parseJsonWithRepair<JsonValue>(withoutCodeFence(text));
      } catch (error) {
        return failure(
          "invalid_output",
          `The model's final answer is not valid JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
          false,
        );
      }
      output.splice(0, output.length, { type: "json", value });
    }
    return {
      output,
      finishReason:
        response.stopReason === "toolUse"
          ? "tool-calls"
          : response.stopReason === "length"
            ? "length"
            : "stop",
      usage: usageOf(response.usage),
      evidence: {
        resolvedModel: response.responseModel ?? selected.id,
        extras: {
          producer: {
            provider: selected.provider,
            api: selected.api,
            model: selected.id,
          },
          // The engine keeps the next prompt inside this window (Model Calls §7).
          contextWindow: selected.contextWindow,
          maxOutputTokens: selected.maxTokens,
        },
      },
    };
  };
}

async function buildContext(
  call: Parameters<RuntimeModelAdapter>[0],
  selected: Model<Api>,
  options: PiModelOptions,
): Promise<Context> {
  const messages: Message[] = [];
  const instructions: string[] = [];
  const content = async (
    parts: readonly PromptContentPart[],
  ): Promise<(TextContent | ImageContent)[]> => {
    const result: (TextContent | ImageContent)[] = [];
    for (const part of parts) {
      if (part.type === "text") result.push({ type: "text", text: part.text });
      else if (part.type === "media") {
        if (!selected.input.includes("image"))
          throw new InvalidRequest("The configured model does not accept images.");
        const ref = part.reference;
        if (
          !ref ||
          typeof ref !== "object" ||
          Array.isArray(ref) ||
          !("agentId" in ref) ||
          !("assetId" in ref) ||
          typeof ref.agentId !== "string" ||
          typeof ref.assetId !== "string"
        )
          throw new InvalidRequest("Expected a local media reference.");
        const asset = await options.media?.dataUrl(
          { agentId: ref.agentId, assetId: ref.assetId },
          "sessionId" in ref && typeof ref.sessionId === "string"
            ? ref.sessionId
            : call.executionId,
        );
        if (!asset)
          throw new InvalidRequest(
            "Media is unavailable; pass the shared media adapter to piModel({ media }).",
          );
        const comma = asset.url.indexOf(",");
        result.push({
          type: "image",
          data: asset.url.slice(comma + 1),
          mimeType: asset.asset.mediaType,
        });
      }
    }
    return result;
  };
  for (const item of call.prompt) {
    if (item.kind === "instructions") {
      instructions.push(
        ...item.content.flatMap((part) =>
          part.type === "text" ? [part.text] : [],
        ),
      );
    } else if (item.kind === "tool-result") {
      messages.push({
        role: "toolResult",
        toolCallId: item.toolCallId,
        toolName: item.toolName,
        isError: item.status !== "completed",
        timestamp: Date.now(),
        content: await content(item.content),
      });
    } else if (item.kind === "message" && item.role === "assistant") {
      messages.push(assistantMessage(item, selected));
    } else
      messages.push({
        role: "user",
        content: await content(item.content),
        timestamp: Date.now(),
      });
  }
  const tools: Tool[] = call.tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    parameters: { ...tool.inputSchema },
  }));
  return {
    systemPrompt: [
      ...instructions,
      ...(call.outputSchema
        ? [
            `Return the final answer as JSON matching this schema: ${JSON.stringify(call.outputSchema)}. Use tools when needed before returning the final JSON.`,
          ]
        : []),
    ].join("\n"),
    messages,
    tools,
  };
}

/**
 * A replayed assistant message keeps the model that produced it, so pi-ai converts
 * history correctly after a model switch (tool-call ids, foreign reasoning). Messages
 * recorded before producers existed are treated as the current model's, as before.
 */
function assistantMessage(
  item: Extract<PromptItem, { kind: "message" }>,
  selected: Model<Api>,
): AssistantMessage {
  const producer = item.producer;
  const sameModel =
    !producer ||
    (producer.provider === selected.provider && producer.model === selected.id);
  return {
    role: "assistant",
    api: sameModel ? selected.api : ((producer.api ?? "unknown") as Api),
    provider: sameModel ? selected.provider : producer.provider,
    model: sameModel ? selected.id : producer.model,
    timestamp: Date.now(),
    usage: emptyUsage(),
    stopReason: item.content.some((p) => p.type === "tool-call")
      ? "toolUse"
      : "stop",
    content: item.content.flatMap<AssistantMessage["content"][number]>(
      (part) => {
        const signature = signatureFor(selected, part);
        if (part.type === "tool-call")
          return [
            {
              type: "toolCall" as const,
              id: part.id,
              name: part.name,
              arguments: { ...part.args },
              ...(signature === undefined ? {} : { thoughtSignature: signature }),
            },
          ];
        if (part.type === "text")
          return [
            {
              type: "text" as const,
              text: part.text,
              ...(signature === undefined ? {} : { textSignature: signature }),
            },
          ];
        if (part.type === "reasoning" && signature !== undefined)
          return [
            {
              type: "thinking" as const,
              thinking: part.text,
              thinkingSignature: signature,
              ...(typeof part.providerMetadata?.pi === "object" &&
              part.providerMetadata.pi !== null &&
              "redacted" in part.providerMetadata.pi &&
              part.providerMetadata.pi.redacted === true
                ? { redacted: true }
                : {}),
            },
          ];
        return [];
      },
    ),
  };
}

/** A signature is replayed only to the provider and model that produced it. */
function signatureFor(
  selected: Model<Api>,
  part: PromptContentPart,
): string | undefined {
  const metadata =
    "providerMetadata" in part ? part.providerMetadata?.pi : undefined;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    return;
  if (
    !("provider" in metadata) ||
    metadata.provider !== selected.provider ||
    !("model" in metadata) ||
    metadata.model !== selected.id ||
    !("signature" in metadata) ||
    typeof metadata.signature !== "string"
  )
    return;
  return metadata.signature;
}

function metadataFor(
  selected: Model<Api>,
  signature: string | undefined,
  redacted?: boolean,
): { providerMetadata?: JsonObject } {
  if (signature === undefined) return {};
  return {
    providerMetadata: {
      pi: {
        provider: selected.provider,
        model: selected.id,
        signature,
        ...(redacted ? { redacted: true } : {}),
      },
      // An OpenAI-compatible reasoning field is needed only inside the turn's tool loop.
      ...(OPENAI_COMPATIBLE_REASONING.test(signature) ? { replay: "turn" } : {}),
    },
  };
}

/** Open-weight models often wrap a JSON answer in a Markdown code fence. */
function withoutCodeFence(text: string): string {
  const fenced = /^\s*```[a-zA-Z]*\s*\n([\s\S]*?)\n?```\s*$/.exec(text);
  return fenced ? fenced[1]! : text;
}

function usageOf(usage: Usage): NonNullable<RuntimeModelCandidate["usage"]> {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.totalTokens,
    ...(usage.cacheRead ? { cachedTokens: usage.cacheRead } : {}),
    ...(usage.cacheWrite ? { cacheWriteTokens: usage.cacheWrite } : {}),
    ...(usage.reasoning ? { reasoningTokens: usage.reasoning } : {}),
    costUsd: usage.cost.total,
  };
}

function failedMessage(selected: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: selected.api,
    provider: selected.provider,
    model: selected.id,
    usage: emptyUsage(),
    stopReason: "error",
    timestamp: Date.now(),
  };
}

/** An idle stream is a retryable timeout, not an abort. */
function idleTimeout(selected: Model<Api>, idleTimeoutMs: number): AssistantMessage {
  return {
    ...failedMessage(selected),
    errorMessage: `The model stream produced nothing for ${Math.round(
      idleTimeoutMs / 1000,
    )} s (idle timeout).`,
  };
}

function hostCredentialStore(
  stored: HostModelSecret,
  write: ((credential: Credential) => void | Promise<void>) | undefined,
): CredentialStore {
  let current: Credential = stored.credential as Credential;
  return {
    async read(providerId) {
      if (providerId !== stored.provider) return undefined;
      return current;
    },
    async list() {
      return [{ providerId: stored.provider, type: current.type }];
    },
    async modify(providerId, fn) {
      if (providerId !== stored.provider) return fn(undefined);
      const next = await fn(current);
      if (next === undefined) return current;
      await write?.(next);
      current = next;
      return next;
    },
    async delete() {
      throw new Error(
        "Replace the model provider in Studio, or with nylo configure.",
      );
    },
  };
}

function credentialSecrets(credential: HostModelSecret["credential"]): string[] {
  const values = [credential.key, credential.access, credential.refresh];
  if (credential.env)
    values.push(...Object.values(credential.env));
  return values.filter((value): value is string => Boolean(value));
}
