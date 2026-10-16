import type { BoundToolDefinition } from "@nylorun/core/define";
import type { StepInput } from "./runtime.js";
import type { InternalModelConfigurationSnapshot } from "./describe.js";
import type { ContextSnapshot, ModelCandidate } from "@nylorun/core/define";
import type { Tripwire } from "@nylorun/core/define";
import { candidateFromCanonical, canonicalizeOutput, type CanonicalCall } from "./canonicalize.js";
import { ModelConfigurationDraft } from "./model-configuration.js";

/** The model-visible context of a call. Nothing adds items since step middleware was removed. */
const EMPTY_CONTEXT: ContextSnapshot = Object.freeze({
  items: Object.freeze([]),
  contributors: Object.freeze([]),
});

/** Mutable Step state: the configuration the definition's parts set, and the model's answer. */
export class StepContext {
  readonly input: Readonly<StepInput>;
  readonly #configuration: ModelConfigurationDraft;
  #canonical: readonly CanonicalCall[] = Object.freeze([]);
  #candidate?: ModelCandidate;
  #tripwire?: Tripwire;
  #configurationSnapshot?: InternalModelConfigurationSnapshot;

  constructor(input: Readonly<StepInput>, configuration: ModelConfigurationDraft) {
    this.input = input;
    this.#configuration = configuration;
  }

  get currentTripwire(): Tripwire | undefined {
    return this.#tripwire;
  }
  get currentCandidate(): Readonly<ModelCandidate> | undefined {
    return this.#candidate;
  }
  get instructions(): readonly string[] {
    return Object.freeze(this.configurationSnapshot().instructions.map((item) => item.text));
  }
  contextSnapshot(): ContextSnapshot {
    return EMPTY_CONTEXT;
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
  canonicalCalls(): readonly CanonicalCall[] {
    return this.#canonical;
  }

  mintFromModel(candidate: Readonly<ModelCandidate>): void {
    const { output, calls } = canonicalizeOutput(
      candidate.output,
      new Set(this.offeredTools.map((tool) => tool.name)),
    );
    this.#canonical = calls;
    this.#candidate = candidateFromCanonical(candidate, output);
  }

  tripwire(error: Tripwire): void {
    this.#tripwire ??= Object.freeze({ ...error });
  }
}
