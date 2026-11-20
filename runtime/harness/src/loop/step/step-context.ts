import type { BoundToolDefinition } from "@nylorun/core/define";
import type { StepInput } from "./runtime.js";
import type { InternalModelConfigurationSnapshot } from "./describe.js";
import type {
  ContextItem,
  ContextSnapshot,
  InputEvent,
  JsonValue,
  ModelCandidate,
} from "@nylorun/core/define";
import type { Tripwire } from "@nylorun/core/define";
import { candidateFromCanonical, canonicalizeOutput, type CanonicalCall } from "./canonicalize.js";
import { ModelConfigurationDraft } from "./model-configuration.js";

/** The model-visible context of a call. Nothing adds items since step middleware was removed. */
const EMPTY_CONTEXT: ContextSnapshot = Object.freeze({
  items: Object.freeze([]),
  contributors: Object.freeze([]),
});

/**
 * A message's context (ADR-157, Host feature `message-context`): the items of the turn's latest
 * input that carries `metadata.context`, for every model call of that turn. A later turn's calls
 * never see them: the block is rendered after the history, not kept in it.
 */
export function messageContextOf(
  input: Pick<StepInput, "turnId" | "transcript" | "arrivals">,
): ContextSnapshot | undefined {
  const events: InputEvent[] = [];
  for (const entry of input.transcript)
    if (entry.kind === "input" && entry.turnId === input.turnId) events.push(entry.event);
  events.push(...input.arrivals);
  for (let index = events.length - 1; index >= 0; index--) {
    const items = contextItemsOf(events[index]!);
    if (items)
      return Object.freeze({
        items,
        contributors: Object.freeze([
          Object.freeze({ partId: "message-context", slot: "message-context", order: 0 }),
        ]),
      });
  }
  return undefined;
}

function contextItemsOf(event: InputEvent): readonly ContextItem[] | undefined {
  if (event.kind !== "user-message" && event.kind !== "interrupt") return undefined;
  const context = (event.metadata as { context?: unknown } | undefined)?.context;
  if (!Array.isArray(context) || context.length === 0) return undefined;
  const items = context.flatMap((item): ContextItem[] => {
    if (!item || typeof item !== "object" || !("value" in item)) return [];
    const { type, value } = item as { type?: unknown; value: JsonValue };
    return [Object.freeze(typeof type === "string" ? { type, value } : { value })];
  });
  return items.length ? Object.freeze(items) : undefined;
}

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
    return messageContextOf(this.input) ?? EMPTY_CONTEXT;
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
