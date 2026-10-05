import type { z } from "zod";
import type { DeferredOutcome, JsonObject, JsonValue } from "./shared.js";
import type { ModelAdapter } from "./model.js";

/**
 * Zod classic schemas accepted as tool contracts.
 * Use core `$ZodType` so concrete schemas (e.g. ZodObject) stay assignable on
 * zod 4.6+, where ZodType gained validate/validateAsync methods that break
 * ZodObject → ZodType assignability in some TypeScript configurations.
 */
type ZodToolSchema<T = unknown> = z.core.$ZodType<T, unknown>;

export interface SchemaIssue {
  readonly path: readonly (string | number)[];
  readonly code: string;
  readonly message: string;
}

export type SchemaValidation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly SchemaIssue[] };

/** The portable, locally-enforced schema contract accepted by a Harness tool. */
export interface ToolSchema<T> {
  readonly jsonSchema: JsonObject;
  validate(value: unknown): SchemaValidation<T>;
}

/** The synchronous Standard Schema subset required to project and validate a tool contract. */
export interface StandardToolSchema<Input = unknown, Output = unknown> {
  readonly "~standard": {
    readonly validate: (
      value: Input
    ) =>
      | { readonly value: Output; readonly issues?: undefined }
      | {
          readonly issues: readonly StandardSchemaIssue[];
          readonly value?: undefined;
        }
      | Promise<unknown>;
    readonly jsonSchema: {
      readonly input: () => unknown;
      readonly output: () => unknown;
    };
  };
}

export interface StandardSchemaIssue {
  readonly message?: string;
  readonly path?: readonly (string | number | symbol)[];
  readonly code?: string;
}

export type ToolSchemaSource<T = unknown> =
  | ZodToolSchema<T>
  | StandardToolSchema<any, T>
  | ToolSchema<T>;

export type SchemaOutput<Schema> = Schema extends z.core.$ZodType<
  infer Value,
  any
>
  ? Value
  : Schema extends StandardToolSchema<any, infer Value>
  ? Value
  : Schema extends ToolSchema<infer Value>
  ? Value
  : never;

export type ToolInputSchema = ToolSchemaSource;
export type ToolOutputSchema = ToolSchemaSource;

type OutputFor<Schema> = Schema extends ToolSchemaSource
  ? SchemaOutput<Schema>
  : ToolContent;

/** Side-effect class for crash / redelivery semantics (code-only; never in the manifest). */
export type ToolEffects = "read" | "idempotent" | "write";

/**
 * Declarative approval gate. Return a prompt string (or `true`) to pause;
 * return `false` / `undefined` / empty string to proceed.
 */
export type ToolApproval<InputSchema extends ToolInputSchema> = (
  args: SchemaOutput<InputSchema>
) => string | boolean | undefined | Promise<string | boolean | undefined>;

export interface SessionStateBag {
  get(key: string): JsonValue | undefined;
  set(key: string, value: JsonValue): void;
  entries(): Readonly<Record<string, JsonValue>>;
}

export interface ToolDefinition<
  InputSchema extends ToolInputSchema = ToolInputSchema,
  Info = unknown,
  OutputSchema extends ToolOutputSchema | undefined = undefined
> {
  readonly name: string;
  readonly description?: string;
  /** Preferred alias for `inputSchema`. */
  readonly input?: InputSchema;
  readonly inputSchema?: InputSchema;
  /** Preferred alias for `outputSchema`. */
  readonly output?: OutputSchema;
  readonly outputSchema?: OutputSchema;
  /** Preferred alias for `execute`. */
  run?(
    args: SchemaOutput<InputSchema>,
    context: ToolExecutionContext<Info>
  ): Promise<ToolRunResult<OutputFor<OutputSchema>>>;
  execute?(
    args: SchemaOutput<InputSchema>,
    context: ToolExecutionContext<Info>
  ): Promise<ToolRunResult<OutputFor<OutputSchema>>>;
  /** Code-only metadata — never serialized into the manifest. */
  readonly approval?: ToolApproval<InputSchema>;
  /** Code-only metadata — never serialized into the manifest. */
  readonly effects?: ToolEffects;
}

/** A plain return value is treated as `{ kind: "completed", output }`. Legacy tagged outcomes remain valid. */
export type ToolRunResult<Output = ToolContent> = Output | ToolOutcome<Output>;

export interface ToolOwner {
  readonly middlewareId: string;
  readonly slot: string;
}

export interface Interaction {
  readonly id?: string;
  readonly kind: "approval" | "response";
  readonly prompt: string;
  readonly metadata?: JsonObject;
}

export interface RequiredInteraction extends Interaction {
  readonly id: string;
}

export interface ToolExecutionResume {
  readonly interactionId: string;
  readonly kind: "approval" | "response";
  readonly approved?: boolean;
  readonly value?: JsonValue;
  readonly token?: JsonValue;
}

/**
 * The agent a call belongs to. `path` is `"<root>"` or `"<root>/<child>"`; `delegationId`
 * identifies one run of an agent used as a tool and is absent for the root agent.
 */
export interface AgentRef {
  readonly id: string;
  readonly path: string;
  readonly delegationId?: string;
}

interface ToolExecutionContextBase {
  readonly executionId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly callId: string;
  readonly invocationId: string;
  readonly signal: AbortSignal;
  /** The invocation's model callable, for tools that explicitly run a child agent. */
  readonly onModelCall?: ModelAdapter;
  readonly resume?: ToolExecutionResume;
  /** Stable per invocation across crash and replay. */
  readonly idempotencyKey: string;
  /** True when this invocation is being offered again after an interrupted active call. */
  readonly redelivery?: boolean;
  /** Durable session memory (tools write; hooks read). */
  readonly state: SessionStateBag;
  /** Session identity stub — Runtime fills this later. */
  readonly session: { readonly id: string };
  /** The agent this call belongs to: the root agent, or an agent used as a tool. */
  readonly agent?: AgentRef;
  /** Live progress stub — emits an observation when a listener is present. */
  progress(message: string, data?: JsonObject): void;
  /** Durable wait: park for a human/app response. */
  ask(prompt: string, opts?: JsonObject): Promise<JsonValue>;
  /** Durable wait: park for approval. */
  approve(prompt: string): Promise<boolean>;
  /** Durable wait: park until a timer fires (host settles). */
  sleep(duration: string | number): Promise<void>;
  /** Durable wait: park until a named event arrives. */
  waitFor(
    event: string,
    opts?: { readonly match?: JsonValue; readonly timeout?: string | number }
  ): Promise<JsonValue>;
  /** Memoized sub-step so effects before a wait are not re-run on resume. */
  step<T>(name: string, fn: () => Promise<T> | T): Promise<T>;
}

export type ToolExecutionContext<Info = unknown> = ToolExecutionContextBase & {
  readonly info?: Info;
};

export type ToolContent = JsonValue;
export type ToolOutcome<Output = ToolContent> =
  | { readonly kind: "completed"; readonly output: Output }
  | { readonly kind: "denied"; readonly reason: string }
  | { readonly kind: "failed"; readonly code: string; readonly message: string }
  | {
      readonly kind: "interaction-required";
      readonly interaction: Interaction;
      readonly token?: JsonValue;
    }
  | DeferredOutcome;

export interface ToolValidationFailureDetails {
  readonly phase: "input" | "output";
  readonly issues: readonly SchemaIssue[];
}

export type ToolResult =
  | {
      readonly callId: string;
      readonly toolName: string;
      readonly kind: "completed";
      readonly output: ToolContent;
    }
  | {
      readonly callId: string;
      readonly toolName: string;
      readonly kind: "denied";
      readonly reason: string;
    }
  | {
      readonly callId: string;
      readonly toolName: string;
      readonly kind: "failed";
      readonly code: string;
      readonly message: string;
      readonly details?: ToolValidationFailureDetails;
    };

/** Immutable tool metadata supplied to model adapters and observers. */
export interface ToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly owner: ToolOwner;
  readonly inputSchema: { readonly jsonSchema: JsonObject };
  readonly outputSchema?: { readonly jsonSchema: JsonObject };
}
