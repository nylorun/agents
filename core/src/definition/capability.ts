import { HarnessError } from "../errors.js";
import type { StepMiddleware, CapabilityDeclaration } from "../types/middleware.js";
import type { ToolDefinition } from "../types/tool.js";
import type { AgentTool } from "../types/agent.js";
import type {
  AfterHook,
  AfterHooks,
  BeforeHook,
  BeforeHooks,
} from "../types/dynamics.js";
import type { ModelDirective } from "../types/model.js";
import { delegateTool, isAgentItem } from "./delegate.js";
import { deprecate } from "../utils/deprecate.js";

const CAPABILITY = Symbol.for("nylorun.capability");

export interface CapabilityIdentity {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
}

/** The options form of `capability()`. Deprecated: use the builder methods. */
export interface CapabilityOptions<Info = unknown> extends CapabilityIdentity {
  readonly tools?: readonly (ToolDefinition<any, Info, any> | AgentTool)[];
  readonly instructions?: string | readonly string[];
  /** Run before each turn or before every model call (step). */
  readonly before?: BeforeHooks<Info>;
  /** Run after every model call (step) or after the turn's final answer. */
  readonly after?: AfterHooks<Info>;
  /** @deprecated Prefer before / after hooks. */
  readonly middleware?: StepMiddleware<Info>;
  /** @deprecated Model resolution is Runtime-owned; not projected into the manifest. */
  readonly model?: ModelDirective;
}

type Parts<Info> = {
  readonly instructions?: readonly string[];
  readonly tools?: readonly (ToolDefinition<any, Info, any> | AgentTool)[];
  readonly before?: BeforeHooks<Info>;
  readonly after?: AfterHooks<Info>;
};

/**
 * A reusable bundle of instructions, tools and hooks, attached with `.capability()`.
 * It has the same methods as a ReAct agent.
 */
export class CapabilityBuilder<Info = unknown> {
  readonly #identity: CapabilityIdentity;
  readonly #parts: Parts<Info>;

  constructor(identity: CapabilityIdentity, parts: Parts<Info> = {}) {
    if (!identity || typeof identity.id !== "string" || identity.id.length === 0)
      throw new HarnessError("configuration.invalid", "capability() requires a non-empty id");
    this.#identity = Object.freeze({ ...identity });
    this.#parts = Object.freeze({ ...parts });
    Object.defineProperty(this, CAPABILITY, { value: true });
  }

  get id(): string {
    return this.#identity.id;
  }

  instructions(...text: readonly string[]): CapabilityBuilder<Info> {
    return this.with({ instructions: [...(this.#parts.instructions ?? []), ...text] });
  }

  tools(...tools: readonly ToolDefinition<any, Info, any>[]): CapabilityBuilder<Info> {
    return this.with({ tools: [...(this.#parts.tools ?? []), ...tools] });
  }

  subagents(...agents: readonly AgentTool[]): CapabilityBuilder<Info> {
    for (const agent of agents)
      if (!isAgentItem(agent))
        throw new HarnessError("configuration.invalid", ".subagents() takes agents; tools belong in .tools()");
    return this.with({ tools: [...(this.#parts.tools ?? []), ...agents] });
  }

  beforeTurn(fn: BeforeHook<"turn", Info>): CapabilityBuilder<Info> {
    return this.hook("before", "turn", fn);
  }

  beforeModel(fn: BeforeHook<"step", Info>): CapabilityBuilder<Info> {
    return this.hook("before", "step", fn);
  }

  afterModel(fn: AfterHook<"step", Info>): CapabilityBuilder<Info> {
    return this.hook("after", "step", fn);
  }

  afterTurn(fn: AfterHook<"turn", Info>): CapabilityBuilder<Info> {
    return this.hook("after", "turn", fn);
  }

  /** @internal The declaration `.capability()` attaches. */
  toDeclaration(): CapabilityDeclaration<Info> {
    return declarationOf<Info>({ ...this.#identity, ...this.#parts });
  }

  private with(parts: Partial<Parts<Info>>): CapabilityBuilder<Info> {
    return new CapabilityBuilder(this.#identity, { ...this.#parts, ...parts });
  }

  private hook(at: "before" | "after", scope: "turn" | "step", fn: unknown): CapabilityBuilder<Info> {
    if (typeof fn !== "function")
      throw new HarnessError("configuration.invalid", `${at}${scope === "turn" ? "Turn" : "Model"}() requires a function`);
    const current = (this.#parts[at] ?? {}) as Record<string, unknown>;
    if (current[scope] !== undefined)
      throw new HarnessError(
        "configuration.invalid",
        `Capability '${this.#identity.id}' already has a ${at}${scope === "turn" ? "Turn" : "Model"}() hook`
      );
    return this.with({ [at]: Object.freeze({ ...current, [scope]: fn }) } as Partial<Parts<Info>>);
  }
}

export function isCapabilityBuilder(value: unknown): value is CapabilityBuilder<any> {
  return !!value && typeof value === "object" && (value as Record<symbol, unknown>)[CAPABILITY] === true;
}

const LEGACY_FIELDS = ["tools", "instructions", "before", "after", "middleware", "model"] as const;

/** Compose a reusable capability bundle: `capability({ id }).instructions(…).tools(…)`. */
export function capability<Info = unknown>(identity: CapabilityIdentity): CapabilityBuilder<Info>;
/** @deprecated Use `capability({ id }).instructions(…).tools(…).beforeTurn(…)`. */
export function capability<Info = unknown>(declaration: CapabilityOptions<Info>): CapabilityDeclaration<Info>;
export function capability<Info = unknown>(
  declaration: CapabilityOptions<Info>
): CapabilityBuilder<Info> | CapabilityDeclaration<Info> {
  const legacy = LEGACY_FIELDS.some((key) => (declaration as unknown as Record<string, unknown>)[key] !== undefined);
  if (!legacy)
    return new CapabilityBuilder<Info>({
      id: declaration.id,
      ...(declaration.name === undefined ? {} : { name: declaration.name }),
      ...(declaration.description === undefined ? {} : { description: declaration.description }),
    });
  deprecate(
    "NYLORUN_DEP_CAPABILITY_OPTIONS",
    "capability({ tools, instructions, before, after }) is deprecated. Use capability({ id }).instructions(…).tools(…).beforeTurn(…)."
  );
  return declarationOf(declaration);
}

function declarationOf<Info>(declaration: CapabilityOptions<Info>): CapabilityDeclaration<Info> {
  const instructions =
    declaration.instructions === undefined
      ? undefined
      : typeof declaration.instructions === "string"
      ? [declaration.instructions]
      : declaration.instructions;
  return {
    id: declaration.id,
    ...(declaration.name === undefined ? {} : { name: declaration.name }),
    ...(declaration.description === undefined
      ? {}
      : { description: declaration.description }),
    ...(declaration.tools === undefined
      ? {}
      : {
          tools: declaration.tools.map((item) =>
            isAgentItem(item)
              ? delegateTool(item)
              : (item as ToolDefinition<any, Info, any>)
          ),
        }),
    ...(instructions === undefined ? {} : { instructions }),
    ...(declaration.before === undefined ? {} : { before: declaration.before }),
    ...(declaration.after === undefined ? {} : { after: declaration.after }),
    ...(declaration.middleware === undefined
      ? {}
      : { middleware: declaration.middleware }),
    ...(declaration.model === undefined ? {} : { model: declaration.model }),
  };
}
