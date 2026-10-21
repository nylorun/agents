import {
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
import { RUNTIME_LIMIT_DEFAULTS, type ModelInput, type RuntimeLimits } from "@nylorun/core/contracts";
import { mediaReferenceOf, type ModelFailureOutcome } from "@nylorun/core/define";
import {
  FileUnavailableError,
  type FileResolver,
  type ResolvedFile,
} from "../artifacts/files.js";
import { essence, inputLabel, isModelImage, modelInputOf } from "@nylorun/core/contracts";
import { scrub } from "../redact.js";
import type { HostModelSecret } from "../vault/service.js";
import { classifyAssistantError, failure } from "./classify.js";
import { addedInputsOf, describeModel, selectionOf } from "./descriptor.js";
import { modelsFor } from "./models.js";
import { callHeaders, type ModelCaller } from "./call-headers.js";
import { hostIdentityRefused, VERTEX_ADC_MARKER } from "../vault/host-identity.js";
import { workloadToken, WorkloadTokenUnavailable } from "../vault/workload-token.js";
import { NativeBlocks, nativeKindsOf, type NativeFileKind } from "./native-blocks.js";
import { projectSecrets } from "./settings.js";

export interface ModelPreview {
  readonly invocationId: string;
  readonly text: string;
}

/**
 * Retry and timeout settings for one model call (Model Calls §5, §6): the Tenant's Runtime limits
 * `model*` (`modelCallSettingsOf`), which the gates read for each call. Each left out is that
 * limit's default.
 */
export interface ModelCallSettings {
  /** Attempts per call, including the first (`modelAttempts`). */
  readonly attempts?: number;
  /** Base delay between attempts; doubles each time, with jitter (`modelRetryDelayMs`). */
  readonly retryBaseDelayMs?: number;
  /** A stream with no event for this long is aborted and retried (`modelIdleMs`). */
  readonly idleTimeoutMs?: number;
  /** Whole-request timeout passed to the provider SDK (`modelRequestMs`). */
  readonly requestTimeoutMs?: number;
  /** Retries the provider SDK makes within one attempt (`modelProviderRetries`). */
  readonly providerRetries?: number;
  /** The longest delay the provider SDK waits before one of them (`modelRetryDelayMaxMs`). */
  readonly maxRetryDelayMs?: number;
}

/** The model call settings the Runtime limits `limits` set. */
export function modelCallSettingsOf(limits: RuntimeLimits): Required<ModelCallSettings> {
  return {
    attempts: limits.modelAttempts,
    retryBaseDelayMs: limits.modelRetryDelayMs,
    idleTimeoutMs: limits.modelIdleMs,
    requestTimeoutMs: limits.modelRequestMs,
    providerRetries: limits.modelProviderRetries,
    maxRetryDelayMs: limits.modelRetryDelayMaxMs,
  };
}

export interface PiModelOptions {
  readonly root?: string;
  readonly onPreview?: (preview: ModelPreview) => void;
  /**
   * Resolves the files a prompt names (media parts whose reference is an artifact version) to
   * their bytes. Model-gate passes one over the Tenant's artifacts (`artifactFiles`).
   */
  readonly files?: FileResolver;
  readonly readHostModel?: () =>
    | HostModelSecret
    | undefined
    | Promise<HostModelSecret | undefined>;
  readonly writeHostCredential?: (
    credential: Credential,
  ) => void | Promise<void>;
  readonly settings?: ModelCallSettings;
  /**
   * Who makes the call: read only when the custom endpoint has `callHeaders` (#493), whose values
   * come from it. Without it, a call sends none of them.
   */
  readonly caller?: () => Promise<ModelCaller | undefined>;
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

/**
 * Node model adapter. Local provider configuration is read only when invoked.
 * A provider failure is returned as a failure outcome; only an abort is thrown.
 */
export function piModel(options: PiModelOptions = {}): RuntimeModelAdapter {
  const settings = { ...modelCallSettingsOf(RUNTIME_LIMIT_DEFAULTS), ...options.settings };
  return async (call, context) => {
    context.signal.throwIfAborted();
    // The first stream event's time, from here (R7.1): the meter keeps it on the usage row.
    const calledAt = Date.now();
    let firstEventAt: number | undefined;
    const root = options.root ?? "";
    const stored = await options.readHostModel?.();
    if (!stored)
      return failure(
        "auth",
        "Model provider is not configured. Set it in Studio, or run nylorun tenant models set.",
        false,
      );
    // The workload token (#496): read from its file now and at each request, never stored.
    let workload: string | undefined;
    if (stored.authType === "workload") {
      try {
        workload = await workloadToken();
      } catch (error) {
        if (error instanceof WorkloadTokenUnavailable) return failure("auth", error.message, false);
        throw error;
      }
    }
    // The Host's identity (ADR-71): only while its operator still lends it.
    if (stored.authType === "host_identity") {
      const refused = hostIdentityRefused(stored.provider);
      if (refused) return failure("auth", refused, false);
    }
    const secrets = [
      ...projectSecrets(root),
      ...credentialSecrets(stored.credential),
      ...(workload === undefined ? [] : [workload]),
    ];
    const redacted = (outcome: ModelFailureOutcome): ModelFailureOutcome => ({
      ...outcome,
      message: String(scrub(outcome.message, secrets)),
    });
    const selection = selectionOf(stored, call.model?.id);
    // A custom endpoint's per-call headers (#493), from the calling Agent; static ones are the model's.
    const sources = selection.custom?.callHeaders;
    const caller = sources && options.caller ? await options.caller() : undefined;
    const perCall = sources && caller ? callHeaders(sources, caller) : {};
    const registry = modelsFor(
      selection,
      hostCredentialStore(stored, options.writeHostCredential),
      {
        environment: false,
        authContext: noAmbientAuth,
        ...(workload === undefined ? {} : { bearer: workloadToken }),
      },
    );
    const found = registry.getModel(selection.provider, selection.model);
    if (!found)
      return failure(
        "invalid_request",
        "Unknown model. Run nylorun tenant models set.",
        false,
      );
    // What the model reads (protocol 12), as `turn.start.model` says: its catalog's inputs and
    // the operator's additions. pi-ai drops an image the model's `input` lacks, so the call's
    // model carries an added one.
    const { inputs } = describeModel(
      found,
      addedInputsOf(selection, stored, stored.addedInputs ?? {}),
    );
    const selected: Model<Api> = {
      ...found,
      input: inputs.includes("image") ? ["text", "image"] : ["text"],
    };
    // PDFs, Office documents, audio and video go in the API's own blocks: pi-ai builds the
    // request with a marker in each one's place and `onPayload` swaps it for the bytes.
    const natives = new NativeBlocks();
    // A part the provider cannot take fails the call before anything is sent: never retried.
    const request = await buildContext(call, selected, inputs, options, natives);
    if ("failed" in request) return redacted(request.failed);
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
      ...(Object.keys(perCall).length > 0 ? { headers: perCall } : {}),
      // With the Host's identity: where Agent Platform runs the call (ADR-71).
      ...(stored.authType === "host_identity" && stored.credential.env ? { env: stored.credential.env } : {}),
      timeoutMs: settings.requestTimeoutMs,
      maxRetries: settings.providerRetries,
      maxRetryDelayMs: settings.maxRetryDelayMs,
      ...(natives.size > 0
        ? {
            // A file that cannot be carried stops the request before it is sent.
            onPayload: (payload: unknown) => {
              const rewritten = natives.rewrite(payload, selected.api);
              if (natives.error) throw new Error(natives.error);
              return rewritten;
            },
          }
        : {}),
    };
    // A file the request could not carry fails the call at once: no message, so never retried.
    const nativeFailure = (): AssistantMessage => failedMessage(selected);
    const attempt = async (): Promise<AssistantMessage> => {
      const idle = new AbortController();
      const signal = AbortSignal.any([context.signal, idle.signal]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => idle.abort(), settings.idleTimeoutMs);
      };
      arm();
      // Only the answer's own attempt counts: a retried attempt's first event is not its.
      firstEventAt = undefined;
      try {
        const stream = registry.streamSimple(selected, request, {
          ...invocationOptions,
          signal,
        });
        for await (const event of stream) {
          arm();
          firstEventAt ??= Date.now();
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
        if (natives.error) return nativeFailure();
        if (idle.signal.aborted && !context.signal.aborted)
          return idleTimeout(selected, settings.idleTimeoutMs);
        return response;
      } catch (error) {
        if (context.signal.aborted) throw error;
        if (natives.error) return nativeFailure();
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
    if (natives.error) return redacted(failure("invalid_request", natives.error, false));
    if (response.stopReason === "aborted")
      return redacted(failure("transient", "The provider stream was aborted.", true));
    if (response.stopReason === "error") {
      const outcome = classifyAssistantError(response, selected.contextWindow);
      return redacted(
        outcome.code === "auth"
          ? {
              ...outcome,
              message: `${outcome.message} Update the provider credential in Studio's Model Settings, or run nylorun tenant models set.`,
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
          // pi-ai initializes missing counters to zero; reporting provenance is unknown.
          tokensReported: null,
          costKnown: !selection.custom,
          // The cost by token kind, at the catalog's prices: the usage ledger keeps it.
          costSplit: {
            input: response.usage.cost.input,
            cacheRead: response.usage.cost.cacheRead,
            cacheWrite: response.usage.cost.cacheWrite,
            output: response.usage.cost.output,
          },
          producer: {
            provider: selected.provider,
            api: selected.api,
            model: selected.id,
          },
          // The engine keeps the next prompt inside this window (Model Calls §7).
          contextWindow: selected.contextWindow,
          maxOutputTokens: selected.maxTokens,
          // From the call to the provider's first stream event (R7.1); absent when none came.
          ...(firstEventAt !== undefined ? { firstTokenMs: firstEventAt - calledAt } : {}),
        },
      },
    };
  };
}

/** A part the call cannot carry: the call fails with it, before anything is sent. */
class Unsendable extends Error {
  constructor(readonly outcome: ModelFailureOutcome) {
    super(outcome.message);
  }
}

/**
 * The provider context for `call`. The gate decides nothing about files (protocol 15): a media
 * part names an artifact version the session may read, which it fetches (`options.files`) and
 * translates, an image to an image block and a PDF, Office document, audio or video to a marker
 * for its native block (`natives`). A part the model or its API cannot take is refused
 * (`unsupported_input`): a text file (the harness inlines text), a kind the model does not read.
 * A file it cannot fetch is `invalid_request`. Bytes go only into the provider request built
 * here, never into the transcript or the journal.
 */
async function buildContext(
  call: Parameters<RuntimeModelAdapter>[0],
  selected: Model<Api>,
  inputs: readonly ModelInput[],
  options: PiModelOptions,
  natives: NativeBlocks,
): Promise<Context | { failed: ModelFailureOutcome }> {
  try {
    return await translate(call, selected, inputs, options, natives);
  } catch (error) {
    if (error instanceof Unsendable) return { failed: error.outcome };
    throw error;
  }
}

async function translate(
  call: Parameters<RuntimeModelAdapter>[0],
  selected: Model<Api>,
  inputs: readonly ModelInput[],
  options: PiModelOptions,
  natives: NativeBlocks,
): Promise<Context> {
  const messages: Message[] = [];
  const instructions: string[] = [];
  const unsupported = (message: string) =>
    new Unsendable(failure("unsupported_input", message, false));
  /** Why the model cannot take a file of `type`, or undefined when it can. */
  const refusal = (name: string, type: string): Unsendable | undefined => {
    const kind = modelInputOf(type);
    const file = `File ${JSON.stringify(name)} (${essence(type)})`;
    if (kind === "text")
      return unsupported(`${file} is text: send its contents as a text part.`);
    if (
      kind === undefined ||
      !inputs.includes(kind) ||
      (kind === "image" && !isModelImage(type)) ||
      (kind !== "image" && !(isNativeKind(kind) && nativeKindsOf(selected.api).includes(kind)))
    )
      return unsupported(
        `This model (${selected.provider}/${selected.id}) does not read ${
          kind === "image" && inputs.includes("image") ? "this image format" : inputLabel(kind)
        }: ${file}.`,
      );
    return undefined;
  };
  const toProvider = async (
    part: Extract<PromptContentPart, { type: "media" }>,
  ): Promise<TextContent | ImageContent> => {
    const declared = refusal(mediaReferenceOf(part.reference)?.name ?? "file", part.mediaType);
    if (declared) throw declared;
    if (!options.files)
      throw new Unsendable(
        failure("invalid_request", "This gate cannot fetch files: no artifact store.", false),
      );
    let file: ResolvedFile;
    try {
      file = await options.files(part.reference);
    } catch (error) {
      if (!(error instanceof FileUnavailableError)) throw error;
      throw new Unsendable(failure("invalid_request", error.message, false));
    }
    const stored = refusal(file.name, file.mediaType);
    if (stored) throw stored;
    const type = essence(file.mediaType);
    const data = Buffer.from(file.bytes).toString("base64");
    if (isModelImage(file.mediaType)) return { type: "image", data, mimeType: type };
    return natives.add({
      kind: modelInputOf(file.mediaType) as NativeFileKind,
      mediaType: type,
      name: file.name,
      data,
    });
  };
  const content = async (
    parts: readonly PromptContentPart[],
  ): Promise<(TextContent | ImageContent)[]> => {
    const result: (TextContent | ImageContent)[] = [];
    for (const part of parts) {
      if (part.type === "text") result.push({ type: "text", text: part.text });
      else if (part.type === "media") result.push(await toProvider(part));
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
  return { systemPrompt: instructions.join("\n"), messages, tools };
}

const isNativeKind = (input: ModelInput | undefined): input is NativeFileKind =>
  input === "pdf" || input === "office" || input === "audio" || input === "video";

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
  // The Host's identity (ADR-71): pi-ai's Vertex AI client uses Application Default Credentials
  // for this marker in place of a key.
  let current: Credential =
    stored.authType === "host_identity"
      ? ({ type: "api_key", key: VERTEX_ADC_MARKER } as Credential)
      : (stored.credential as Credential);
  // A workload model stores no credential: pi-ai then asks the provider's `resolve` (`modelsFor`).
  const stores = stored.authType !== "workload";
  return {
    async read(providerId) {
      if (providerId !== stored.provider || !stores) return undefined;
      return current;
    },
    async list() {
      return stores ? [{ providerId: stored.provider, type: current.type }] : [];
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
        "Replace the model provider in Studio, or with nylorun tenant models set.",
      );
    },
  };
}

function credentialSecrets(credential: HostModelSecret["credential"]): string[] {
  // The Host's identity keeps no secret: its project and location stay readable in messages.
  if (credential.type === "host_identity") return [];
  const values = [credential.key, credential.access, credential.refresh];
  if (credential.env)
    values.push(...Object.values(credential.env));
  return values.filter((value): value is string => Boolean(value));
}
