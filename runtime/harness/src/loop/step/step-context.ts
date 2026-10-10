import type { BoundToolDefinition } from "@nylorun/core/define";
import type { StepInput } from "./runtime.js";
import type { InternalModelConfigurationSnapshot } from "./describe.js";
import type {
  ContextMutationOptions,
  ContextSnapshot,
  ModelCandidate,
  ModelDirective,
  ModelConfigurationMutationOptions,
} from "@nylorun/core/define";
import type { StepRequest, StepResponse } from "@nylorun/core/define";
import type { ContextItem, Tripwire } from "@nylorun/core/define";
import type { ObserveEmit } from "../observe.js";
import type { Interaction, ToolDefinition } from "@nylorun/core/define";
import { HarnessError, isHarnessError } from "@nylorun/core/define";
import { freezeGraph } from "@nylorun/core/define";
import {
  callsFromCanonical,
  candidateFromCanonical,
  canonicalizeOutput,
  identityKey,
  type CanonicalCall,
} from "./canonicalize.js";
import { normalizeCandidate } from "../model/normalize.js";
import { ContextDraft } from "./context-draft.js";
import { ModelConfigurationDraft } from "./model-configuration.js";

const branded = new WeakSet<object>();

export function isBrandedResponse(value: unknown): value is StepResponse {
  return typeof value === "object" && value !== null && branded.has(value);
}

/** Mutable Step state. Middleware receives leased request views and one branded response. */
export class StepContext {
  readonly input: Readonly<StepInput>;
  readonly #observe: ObserveEmit;
  readonly #context: ContextDraft;
  readonly #configuration: ModelConfigurationDraft;
  readonly #denials = new Map<string, string>();
  readonly #interactions = new Map<string, Interaction>();
  readonly #identities = new Map<string, string>();
  #canonical: readonly CanonicalCall[] = Object.freeze([]);
  #candidate?: ModelCandidate;
  #tripwire?: Tripwire;
  #response?: StepResponse;
  #sealed = false;
  #configurationSnapshot?: InternalModelConfigurationSnapshot;
  #contextSnapshot?: ContextSnapshot;

  constructor(
    input: Readonly<StepInput>,
    observe: ObserveEmit,
    configuration: ModelConfigurationDraft,
    context: ContextDraft,
  ) {
    this.input = input;
    this.#observe = observe;
    this.#configuration = configuration;
    this.#context = context;
  }

  get currentTripwire(): Tripwire | undefined {
    return this.#tripwire;
  }
  get currentCandidate(): Readonly<ModelCandidate> | undefined {
    return this.#candidate;
  }
  get selectedDirective(): ModelDirective | undefined {
    return this.configurationSnapshot().model;
  }
  get instructions(): readonly string[] {
    return Object.freeze(this.configurationSnapshot().instructions.map((item) => item.text));
  }
  contextSnapshot(): ContextSnapshot {
    return this.#contextSnapshot ?? this.#context.snapshot();
  }
  get offeredTools(): readonly BoundToolDefinition[] {
    return this.configurationSnapshot().tools;
  }
  get catalogByName(): ReadonlyMap<string, BoundToolDefinition> {
    return new Map(this.offeredTools.map((tool) => [tool.name, tool] as const));
  }
  configurationSnapshot(): InternalModelConfigurationSnapshot {
    return this.#configurationSnapshot ?? this.#configuration.snapshot();
  }
  sealConfiguration(snapshot: InternalModelConfigurationSnapshot): void {
    this.#configurationSnapshot = snapshot;
  }
  sealContext(snapshot: ContextSnapshot): void {
    this.#contextSnapshot = snapshot;
  }
  denialFor(callId: string): string | undefined {
    return this.#denials.get(callId);
  }
  interactionFor(callId: string): Interaction | undefined {
    return this.#interactions.get(callId);
  }
  canonicalCalls(): readonly CanonicalCall[] {
    return this.#canonical;
  }

  mintFromModel(candidate: Readonly<ModelCandidate>): StepResponse {
    const { output, calls } = canonicalizeOutput(candidate.output);
    this.#canonical = calls;
    this.#candidate = candidateFromCanonical(candidate, output);
    this.#identities.clear();
    for (const call of calls) this.#identities.set(call.id, identityKey(call.name, call.args));
    return this.#ensureResponse();
  }

  tripwire(error: Tripwire): StepResponse {
    this.#tripwire ??= Object.freeze({ ...error });
    return this.#ensureResponse();
  }

  seal(): void {
    this.#sealed = true;
  }

  requestFacade(
    middlewareId: string,
    middlewareOrder: number,
  ): {
    readonly value: StepRequest;
    revokeMutators(): void;
  } {
    let mutatorsActive = true;
    const mutate = (action: () => void): void => {
      if (!mutatorsActive || this.#sealed) {
        this.#observe({
          type: "middleware.lease-violation",
          turnId: this.input.turnId,
          stepId: this.input.stepId,
          middlewareId,
          reason: this.#sealed ? "step-sealed" : "mutators-revoked",
        });
        throw new HarnessError(
          "middleware.request-mutators-revoked",
          "Middleware request mutators are no longer active",
          { details: { middlewareId } },
        );
      }
      action();
    };
    const mutateConfiguration = (
      kind: "instructions" | "tools" | "model",
      action: () => void,
    ): void =>
      mutate(() => {
        try {
          action();
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          const code = isHarnessError(cause)
            ? cause.code
            : kind === "tools"
              ? "tool.invalid-schema"
              : kind === "model"
                ? "model.invalid-directive"
                : "configuration.invalid-instructions";
          this.#tripwire ??= Object.freeze({ code, message });
        }
      });
    const mutateContext = (action: () => void): void =>
      mutate(() => {
        try {
          action();
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          this.#tripwire ??= Object.freeze({
            code: isHarnessError(cause) ? cause.code : "context.invalid-item",
            message,
          });
        }
      });
    const request: Record<string, unknown> = {
      executionId: this.input.executionId,
      turnId: this.input.turnId,
      stepId: this.input.stepId,
      info: this.input.info,
      turnNumber: this.input.turnNumber,
      stepNumber: this.input.stepNumber,
      arrivals: this.input.arrivals,
      toolResults: this.input.toolResults,
      transcript: this.input.transcript,
      context: Object.freeze({
        set: (slot: string, items: readonly ContextItem[], options?: ContextMutationOptions) =>
          mutateContext(() =>
            this.#context.set(middlewareId, middlewareOrder, slot, items, options),
          ),
      }),
      configuration: Object.freeze({
        instructions: Object.freeze({
          set: (
            slot: string,
            items: readonly string[],
            options?: ModelConfigurationMutationOptions,
          ) =>
            mutateConfiguration("instructions", () =>
              this.#configuration.setInstructions(
                middlewareId,
                middlewareOrder,
                slot,
                items,
                options,
              ),
            ),
        }),
        tools: Object.freeze({
          set: (
            slot: string,
            tools: readonly ToolDefinition[],
            options?: ModelConfigurationMutationOptions,
          ) =>
            mutateConfiguration("tools", () =>
              this.#configuration.setTools(middlewareId, middlewareOrder, slot, tools, options),
            ),
        }),
        model: Object.freeze({
          select: (
            directive: ModelDirective,
            options?: Omit<ModelConfigurationMutationOptions, "order">,
          ) =>
            mutateConfiguration("model", () =>
              this.#configuration.select(middlewareId, middlewareOrder, directive, options),
            ),
          replace: (
            directive: ModelDirective,
            options?: Omit<ModelConfigurationMutationOptions, "order">,
          ) =>
            mutateConfiguration("model", () =>
              this.#configuration.replace(middlewareId, middlewareOrder, directive, options),
            ),
          clear: (options?: Omit<ModelConfigurationMutationOptions, "order">) =>
            mutateConfiguration("model", () => this.#configuration.clear(options)),
        }),
      }),
      tripwire: (error: Tripwire) => {
        let minted!: StepResponse;
        mutate(() => {
          minted = this.tripwire(error);
        });
        return minted;
      },
    };
    const value = Object.freeze(request) as unknown as StepRequest;
    return Object.freeze({
      value,
      revokeMutators: () => {
        mutatorsActive = false;
      },
    });
  }

  #ensureResponse(): StepResponse {
    if (this.#response) return this.#response;
    const value: StepResponse = Object.freeze({
      candidate: () => this.currentCandidate,
      toolCalls: () => callsFromCanonical(this.#canonical),
      replace: (candidate: ModelCandidate) => this.#replace(candidate),
      deny: (callId: string, reason: string) => {
        if (!this.#denials.has(callId)) this.#denials.set(callId, reason);
      },
      requireInteraction: (callId: string, interaction: Interaction) => {
        if (!this.#interactions.has(callId))
          this.#interactions.set(callId, freezeGraph({ ...interaction }));
      },
      tripwire: (error: Tripwire) => {
        this.#tripwire ??= Object.freeze({ ...error });
        return value;
      },
    });
    branded.add(value);
    this.#response = value;
    return value;
  }

  #replace(candidate: ModelCandidate): void {
    let normalized: ModelCandidate;
    try {
      normalized = normalizeCandidate(candidate);
    } catch (error) {
      this.#tripwire ??= Object.freeze({
        code: isHarnessError(error) ? error.code : "response.invalid-replacement",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const { output, calls: next } = canonicalizeOutput(normalized.output);
    for (const call of next) {
      const original = this.#identities.get(call.id);
      if (original === undefined) {
        this.#tripwire ??= Object.freeze({
          code: "response.invalid-replacement",
          message: `replace() cannot add Tool call '${call.id}'`,
        });
        return;
      }
      if (original !== identityKey(call.name, call.args)) {
        this.#tripwire ??= Object.freeze({
          code: "response.invalid-replacement",
          message: `replace() cannot change identity of Tool call '${call.id}'`,
        });
        return;
      }
    }
    const current = this.#candidate;
    this.#canonical = next;
    this.#candidate = Object.freeze({
      output,
      ...pickSidecar("finishReason", candidate, normalized, current),
      ...pickSidecar("usage", candidate, normalized, current),
      ...pickSidecar("evidence", candidate, normalized, current),
    });
  }
}

function pickSidecar(
  key: "finishReason" | "usage" | "evidence",
  replacement: ModelCandidate,
  normalized: ModelCandidate,
  current: ModelCandidate | undefined,
): Partial<Pick<ModelCandidate, "finishReason" | "usage" | "evidence">> {
  const source = Object.hasOwn(replacement, key) ? normalized : current;
  const value = source?.[key];
  return value === undefined ? {} : { [key]: value };
}
