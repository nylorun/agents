import type {
  AssistantMessage,
  Context,
  Credential,
  CredentialStore,
  ImageContent,
  Message,
  TextContent,
  Tool,
  Usage,
} from "@earendil-works/pi-ai";
import type {
  JsonValue,
  JsonObject,
  PromptContentPart,
  RuntimeModelAdapter,
  RuntimeModelCandidate,
} from "../contracts.js";
import type { RuntimeMedia } from "../adapters/media.js";
import { scrub } from "../redact.js";
import type { HostModelSecret } from "../vault/service.js";
import { modelsFor } from "./models.js";
import { projectSecrets } from "./settings.js";

export interface ModelPreview {
  readonly invocationId: string;
  readonly text: string;
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
}
const emptyUsage = (): Usage => ({
  input: 0,
  output: 0,
  totalTokens: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/** Node model adapter. Local provider configuration is read only when invoked. */
export function piModel(options: PiModelOptions = {}): RuntimeModelAdapter {
  return async (call, context) => {
    context.signal.throwIfAborted();
    const root = options.root ?? "";
    const stored = await options.readHostModel?.();
    if (!stored)
      throw new Error(
        "Model provider is not configured. Start nylorun dev in a terminal, or set it in Studio.",
      );
    const requested = call.model?.id;
    const selection = {
      provider: stored.provider,
      model: requested?.startsWith(`${stored.provider}/`)
        ? requested.slice(stored.provider.length + 1)
        : (requested ?? stored.model),
      ...(stored.baseUrl ? { custom: { baseUrl: stored.baseUrl } } : {}),
    };
    const registry = modelsFor(
      selection,
      hostCredentialStore(stored, options.writeHostCredential),
      { environment: false },
    );
    const selected = registry.getModel(selection.provider, selection.model);
    if (!selected) throw new Error("Unknown model. Run nylorun configure.");
    const signatureFor = (part: PromptContentPart): string | undefined => {
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
    };
    const metadataFor = (
      signature: string | undefined,
      redacted?: boolean,
    ): { providerMetadata?: JsonObject } =>
      signature === undefined
        ? {}
        : {
            providerMetadata: {
              pi: {
                provider: selected.provider,
                model: selected.id,
                signature,
                ...(redacted ? { redacted: true } : {}),
              },
            },
          };
    const messages: Message[] = [];
    const instructions: string[] = [];
    const content = async (
      parts: readonly PromptContentPart[],
    ): Promise<(TextContent | ImageContent)[]> => {
      const result: (TextContent | ImageContent)[] = [];
      for (const part of parts) {
        if (part.type === "text")
          result.push({ type: "text", text: part.text });
        else if (part.type === "media") {
          if (!selected.input.includes("image"))
            throw new Error("The configured model does not accept images.");
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
            throw new Error("Expected a local media reference.");
          const asset = await options.media?.dataUrl(
            { agentId: ref.agentId, assetId: ref.assetId },
            "sessionId" in ref && typeof ref.sessionId === "string"
              ? ref.sessionId
              : call.executionId,
          );
          if (!asset)
            throw new Error(
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
      } else if (item.role === "assistant") {
        messages.push({
          role: "assistant",
          api: selected.api,
          provider: selected.provider,
          model: selected.id,
          timestamp: Date.now(),
          usage: emptyUsage(),
          stopReason: item.content.some((p) => p.type === "tool-call")
            ? "toolUse"
            : "stop",
          content: item.content.flatMap<AssistantMessage["content"][number]>(
            (part) =>
              part.type === "tool-call"
                ? [
                    {
                      type: "toolCall" as const,
                      id: part.id,
                      name: part.name,
                      arguments: { ...part.args },
                      ...(signatureFor(part) === undefined
                        ? {}
                        : { thoughtSignature: signatureFor(part) }),
                    },
                  ]
                : part.type === "text"
                  ? [
                      {
                        type: "text" as const,
                        text: part.text,
                        ...(signatureFor(part) === undefined
                          ? {}
                          : { textSignature: signatureFor(part) }),
                      },
                    ]
                  : part.type === "reasoning" &&
                      signatureFor(part) !== undefined
                    ? [
                        {
                          type: "thinking" as const,
                          thinking: part.text,
                          thinkingSignature: signatureFor(part),
                          ...(typeof part.providerMetadata?.pi === "object" &&
                          part.providerMetadata.pi !== null &&
                          "redacted" in part.providerMetadata.pi &&
                          part.providerMetadata.pi.redacted === true
                            ? { redacted: true }
                            : {}),
                        },
                      ]
                    : [],
          ),
        });
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
    const request: Context = {
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
    const secrets = [
      ...projectSecrets(root),
      ...credentialSecrets(stored.credential),
    ];
    // Publish only portable references, never the materialized provider image bytes.
    context.reportPreparedCall?.({
      adapter: "runtime.pi-ai",
      call: scrub(call, secrets) as JsonValue,
    });
    try {
      const invocationOptions = {
        signal: context.signal,
        temperature: call.model?.controls?.temperature,
        maxTokens: call.model?.controls?.maxOutputTokens,
        ...(call.model?.config
          ? { samplingParams: { ...call.model.config } }
          : {}),
      };
      let response: AssistantMessage;
      if (options.onPreview) {
        const stream = registry.streamSimple(
          selected,
          request,
          invocationOptions,
        );
        for await (const event of stream) {
          if (event.type === "text_delta") {
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
        response = await stream.result();
      } else
        response = await registry.complete(
          selected,
          request,
          invocationOptions,
        );
      context.signal.throwIfAborted();
      if (
        response.stopReason === "error" ||
        response.stopReason === "aborted" ||
        response.stopReason === "deferred"
      )
        throw new Error(
          response.errorMessage ?? `Provider stopped: ${response.stopReason}`,
        );
      const output: RuntimeModelCandidate["output"][number][] = [];
      for (const part of response.content) {
        if (part.type === "text")
          output.push({
            type: "text",
            text: part.text,
            ...metadataFor(part.textSignature),
          });
        else if (part.type === "thinking")
          output.push({
            type: "reasoning",
            text: part.thinking,
            ...metadataFor(part.thinkingSignature, part.redacted),
          });
        else if (part.type === "toolCall")
          output.push({
            type: "tool-call",
            id: part.id,
            name: part.name,
            args: part.arguments,
            ...metadataFor(part.thoughtSignature),
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
        const value = JSON.parse(text);
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
        usage: {
          inputTokens: response.usage.input,
          outputTokens: response.usage.output,
          totalTokens: response.usage.totalTokens,
          costUsd: response.usage.cost.total,
        },
        evidence: { resolvedModel: response.responseModel ?? selected.id },
      };
    } catch (error) {
      throw new Error(
        String(
          scrub(
            error instanceof Error ? error.message : String(error),
            secrets,
          ),
        ),
      );
    }
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
        "Replace the model provider through nylorun dev or Studio.",
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
