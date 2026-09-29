import type { BoundMiddleware } from "./bound.js";
import type {
  CapabilityInput,
  StepMiddleware,
} from "../types/middleware.js";
import type { BuildDiagnostic, JsonObject } from "../types/shared.js";
import { HarnessError } from "../errors.js";
import type {
  ToolDefinition,
  ToolSchemaSource,
  SchemaOutput,
} from "../types/tool.js";
import type { AgentTool, BuiltAgent } from "../types/agent.js";
import type { AgentManifest, McpServerManifest, SandboxManifest } from "../types/manifest.js";
import type { WorkflowBinding, WorkflowManifest } from "../types/workflow.js";
import type {
  AfterHook,
  BeforeHook,
  HookAt,
  HookScope,
} from "../types/dynamics.js";
import type { Implementations } from "./implementations.js";
import { assembleAgent, type CapabilityDynamics } from "./assemble.js";
import { compileDeclaration } from "./declaration.js";
import { agentFrom } from "./from.js";
import { hooksFrom } from "./hooks.js";
import { isAgentItem } from "./delegate.js";
import { sandbox as sandboxCapability } from "./sandbox.js";
import { normalizeMcpServers, type McpServerSpec } from "./mcp.js";
import { deprecate } from "../utils/deprecate.js";
import { WorkflowBuildError } from "./workflow/diagnostics.js";
import { flowFrom, type FlowImplementations } from "./flow/from.js";
import { isBuiltWorkflow, type BuiltWorkflow } from "./workflow/types.js";
import { compileAgentFlow } from "./flow/compile.js";
import {
  loopStage,
  mapStage,
  named,
  parallelStage,
  stepStage,
  switchStage,
  type FlowStage,
} from "./flow/spec.js";
import type {
  AddResult,
  BranchesOut,
  CaseKey,
  CasesOut,
  FlowAgentBuilder,
  FlowOut,
  IdOf,
  LoopChoice,
  LoopDecideArgs,
  LoopVerifyFn,
  Named,
  StageArgs,
} from "./flow/types.js";
import { isCapabilityBuilder } from "./capability.js";

export interface AgentOptions<
  Schema extends ToolSchemaSource | undefined = undefined
> {
  /** @deprecated Use `.output(schema)`. */
  readonly outputSchema?: Schema;
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly metadata?: JsonObject;
  /** @deprecated Use `.instructions(...)`. */
  readonly instructions?: string | readonly string[];
  /** @deprecated Use `.tools(...)` and `.subagents(...)`. */
  readonly tools?: readonly (ToolDefinition<any, any, any> | AgentTool)[];
  // model is intentionally absent — Runtime owns model resolution via onModelCall.
}

type Body = "none" | "react" | "flow";

interface BuilderSnapshot {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly metadata?: JsonObject;
  readonly outputSchema?: ToolSchemaSource;
  readonly inputSchema?: ToolSchemaSource;
  readonly entries: readonly BoundMiddleware[];
  readonly dynamics: ReadonlyMap<string, CapabilityDynamics>;
  /** Builder-level problems, reported with the assembly diagnostics. */
  readonly diagnostics?: readonly BuildDiagnostic[];
  readonly body: Body;
  /** Raw items of the `"agent"` capability, so later calls can add to it. */
  readonly agentPart?: {
    readonly instructions?: readonly string[];
    readonly tools?: readonly (ToolDefinition<any, any, any> | AgentTool)[];
  };
  readonly mcpServers?: Readonly<Record<string, McpServerManifest>>;
  readonly sandbox?: SandboxManifest;
  readonly stages: readonly FlowStage[];
}

export class AgentBuildError extends HarnessError {
  constructor(readonly diagnostics: readonly BuildDiagnostic[]) {
    super(
      "agent.build-failed",
      diagnostics.map((item) => item.message).join("; ") || "Agent build failed"
    );
    this.name = "AgentBuildError";
  }
}

export class AgentLifecycleError extends HarnessError {
  constructor(message: string) {
    super("agent.lifecycle-sealed", message);
    this.name = "AgentLifecycleError";
  }
}

export function Agent<
  Info = unknown,
  Schema extends ToolSchemaSource | undefined = undefined,
  const Id extends string = string,
>(options: AgentOptions<Schema> & { readonly id: Id }): AgentBuilder<Info, Schema, Id> {
  return AgentBuilder.create(options);
}

export namespace Agent {
  /** Rebuild a flow agent from its workflow manifest v2 and the code its stage keys name. */
  export function from(
    json: import("../types/workflow.js").WorkflowManifestV2,
    implementations?: FlowImplementations
  ): BuiltWorkflow;
  /** Rebuild an agent from its manifest and the code its capabilities name. */
  export function from<Info = unknown>(
    json: AgentManifest | import("../types/shared.js").JsonObject,
    implementations: Implementations<Info>
  ): BuiltAgent<Info>;
  export function from(
    json: unknown,
    implementations: Implementations<any> | FlowImplementations = {}
  ): BuiltAgent<any> | BuiltWorkflow {
    if ((json as { kind?: unknown }).kind === "workflow")
      return flowFrom(json, implementations as FlowImplementations);
    return agentFrom(json as AgentManifest, implementations as Implementations);
  }
}

const SNAPSHOT = Symbol("AgentBuilder.snapshot");

type SchemaOut<Schema> = Schema extends ToolSchemaSource ? SchemaOutput<Schema> : never;
type ReactOutput<Schema> = Schema extends ToolSchemaSource ? SchemaOutput<Schema> : string;
type StartFlow<Info, Schema, Id extends string, Cur, Results> = FlowAgentBuilder<
  Info,
  any,
  Cur,
  Results,
  SchemaOut<Schema>,
  Id
>;

export class AgentBuilder<
  Info = unknown,
  Schema extends ToolSchemaSource | undefined = undefined,
  Id extends string = string,
> {
  /** Phantom carriers for flow typing (never set at runtime). */
  declare readonly __output?: ReactOutput<Schema>;
  declare readonly __id?: Id;

  readonly #snapshot: BuilderSnapshot;
  #agent?: BuiltAgent<Info, ReactOutput<Schema>>;
  #workflow?: BuiltWorkflow;
  #error?: AgentBuildError;

  getBinding() {
    return this.build().getBinding();
  }

  constructor(options: AgentOptions<Schema>);
  /** @internal */
  constructor(snapshot: BuilderSnapshot, brand: typeof SNAPSHOT);
  constructor(
    optionsOrSnapshot: AgentOptions<Schema> | BuilderSnapshot,
    brand?: typeof SNAPSHOT
  ) {
    this.#snapshot =
      brand === SNAPSHOT
        ? (optionsOrSnapshot as BuilderSnapshot)
        : createSnapshot(optionsOrSnapshot as AgentOptions<Schema>);
  }

  static create<Info, Schema extends ToolSchemaSource | undefined, Id extends string = string>(
    options: AgentOptions<Schema>
  ): AgentBuilder<Info, Schema, Id> {
    return new AgentBuilder(options) as AgentBuilder<Info, Schema, Id>;
  }

  /** @internal True for an agent whose body is a flow. */
  static isFlowAgent(value: unknown): boolean {
    return value instanceof AgentBuilder && value.#snapshot.body === "flow";
  }

  /** A new builder of the same class (subclasses survive chaining). */
  protected spawn(snapshot: BuilderSnapshot): this {
    const Ctor = this.constructor as new (s: BuilderSnapshot, b: typeof SNAPSHOT) => this;
    return new Ctor(snapshot, SNAPSHOT);
  }

  /** Compose-time identity — available before `.build()`. */
  get id(): Id {
    return this.#snapshot.id as Id;
  }

  get name(): string | undefined {
    return this.#snapshot.name;
  }

  get manifest(): AgentManifest {
    return this.ensure().manifest as AgentManifest;
  }

  /** A flow agent's input and output schemas (local; not on the v1 wire). */
  get inputSchema(): ToolSchemaSource | undefined {
    return this.#snapshot.body === "flow" ? this.#snapshot.inputSchema : undefined;
  }

  get outputSchema(): ToolSchemaSource | undefined {
    return this.#snapshot.body === "flow" ? this.#snapshot.outputSchema : undefined;
  }

  toJSON(): AgentManifest {
    return this.ensure().toJSON() as AgentManifest;
  }

  // ── ReAct: the model decides ───────────────────────────────────────────────

  /** Add instructions. Repeated calls add more. */
  instructions(...text: readonly string[]): this {
    for (const item of text)
      if (typeof item !== "string")
        throw new HarnessError("configuration.invalid", ".instructions() takes strings");
    return this.withAgentItems("instructions()", { instructions: text });
  }

  /** Add tools. Repeated calls add more. Agents belong in `.subagents()`. */
  tools(...tools: readonly (ToolDefinition<any, any, any> | AgentTool)[]): this {
    return this.withAgentItems("tools()", { tools });
  }

  /** Add agents the model may delegate a self-contained task to. */
  subagents(...agents: readonly AgentTool[]): this {
    for (const agent of agents)
      if (!isAgentItem(agent))
        throw new HarnessError("configuration.invalid", ".subagents() takes agents; tools belong in .tools()");
    return this.withAgentItems("subagents()", { tools: agents });
  }

  /** Declare MCP servers. A server's `name` defaults to its key; calls merge. */
  mcp(servers: Readonly<Record<string, McpServerSpec>>): this {
    const snapshot = this.#snapshot;
    const body = this.bodyFor("react", "mcp()");
    const added = normalizeMcpServers(servers, ".mcp()");
    const merged: Record<string, McpServerManifest> = { ...(snapshot.mcpServers ?? {}) };
    const diagnostics: BuildDiagnostic[] = [];
    for (const [key, server] of Object.entries(added)) {
      if (merged[key] !== undefined)
        diagnostics.push(
          Object.freeze({
            code: "mcp.duplicate-server",
            message: `MCP server '${key}' is declared twice on '${snapshot.id}'`,
          })
        );
      merged[key] = server;
    }
    const compiled = compileDeclaration({ id: "mcp", mcpServers: Object.freeze(merged) });
    return this.spawn({
      ...snapshot,
      ...body,
      mcpServers: Object.freeze(merged),
      entries: replaceOrAppend(snapshot.entries, compiled.bound),
      dynamics: withDynamics(snapshot.dynamics, "mcp", {}),
      diagnostics: addDiagnostics(body.diagnostics ?? snapshot.diagnostics, diagnostics),
    });
  }

  /** Attach a reusable bundle made with `capability({ id })`. */
  capability(bundle: CapabilityInput<Info> | { toDeclaration(): CapabilityInput<Info> }): this {
    const declaration = isCapabilityBuilder(bundle)
      ? (bundle.toDeclaration() as CapabilityInput<Info>)
      : (bundle as CapabilityInput<Info>);
    return this.addDeclaration(declaration, "capability()");
  }

  /**
   * Give the agent a Runtime-owned sandbox. On a flow agent, declares the one sandbox
   * every agent in the flow shares.
   */
  sandbox(spec: SandboxManifest = {}): this {
    const snapshot = this.#snapshot;
    const capability = sandboxCapability(spec);
    if (snapshot.sandbox !== undefined)
      return this.spawn({
        ...snapshot,
        diagnostics: addDiagnostics(snapshot.diagnostics, [singleValue(snapshot.id, "sandbox")]),
      });
    if (snapshot.body === "flow")
      return this.spawn({ ...snapshot, sandbox: capability.sandbox });
    const compiled = compileDeclaration(capability);
    return this.spawn({
      ...snapshot,
      sandbox: capability.sandbox,
      entries: Object.freeze([...snapshot.entries, compiled.bound]),
      dynamics: withDynamics(snapshot.dynamics, compiled.bound.id, {}),
    });
  }

  /** Run `fn` before each turn. */
  beforeTurn(fn: BeforeHook<"turn", Info>): this {
    return this.addAgentHook("before", "turn", fn);
  }

  /** Run `fn` before every model call. */
  beforeModel(fn: BeforeHook<"step", Info>): this {
    return this.addAgentHook("before", "step", fn);
  }

  /** Run `fn` after every model call. */
  afterModel(fn: AfterHook<"step", Info>): this {
    return this.addAgentHook("after", "step", fn);
  }

  /** Run `fn` after the turn's final answer. */
  afterTurn(fn: AfterHook<"turn", Info>): this {
    return this.addAgentHook("after", "turn", fn);
  }

  /** The structured output. Set once. */
  output<S extends ToolSchemaSource>(schema: S): AgentBuilder<Info, S, Id> {
    const snapshot = this.#snapshot;
    if (snapshot.outputSchema !== undefined)
      return this.spawn({
        ...snapshot,
        diagnostics: addDiagnostics(snapshot.diagnostics, [singleValue(snapshot.id, "output schema")]),
      }) as unknown as AgentBuilder<Info, S, Id>;
    return this.spawn({ ...snapshot, outputSchema: schema }) as unknown as AgentBuilder<Info, S, Id>;
  }

  /** @deprecated Use `.capability()`, `.mcp()`, `.skills()`, `.plugin()` or `.sandbox()`. */
  use(middleware: StepMiddleware<Info>): this;
  /** @deprecated Use `.capability()`, `.mcp()`, `.skills()`, `.plugin()` or `.sandbox()`. */
  use(id: string, middleware: StepMiddleware<Info>): this;
  /** @deprecated Use `.capability()`, `.mcp()`, `.skills()`, `.plugin()` or `.sandbox()`. */
  use(declaration: CapabilityInput<Info>): this;
  use(
    idOrMiddleware: string | StepMiddleware<Info> | CapabilityInput<Info>,
    middleware?: StepMiddleware<Info>
  ): this {
    if (typeof idOrMiddleware === "object") {
      deprecate(
        "NYLORUN_DEP_USE",
        ".use(capability) is deprecated. Use .capability(), .mcp(), .skills(), .plugin() or .sandbox()."
      );
      const declaration = isCapabilityBuilder(idOrMiddleware)
        ? (idOrMiddleware.toDeclaration() as CapabilityInput<Info>)
        : idOrMiddleware;
      return this.addDeclaration(declaration, "use()");
    }
    const body = this.bodyFor("react", "use()");
    let compiled: ReturnType<typeof compileDeclaration>;
    if (typeof idOrMiddleware === "function") {
      compiled = {
        bound: {
          id: nextMiddlewareId(this.#snapshot.entries),
          handle: idOrMiddleware as StepMiddleware,
          hasMiddleware: true,
        },
        middleware: idOrMiddleware as StepMiddleware,
      };
    } else {
      compiled = {
        bound: {
          id: idOrMiddleware,
          handle: middleware! as StepMiddleware,
          hasMiddleware: true,
        },
        middleware: middleware as StepMiddleware,
      };
    }
    return this.appendCompiled(compiled, body);
  }

  /**
   * @deprecated Use `.beforeTurn()` or `.beforeModel()`.
   * Run `fn` before each turn (`"turn"`) or before every model call (`"step"`).
   */
  before<S extends HookScope>(
    scope: S,
    fn: BeforeHook<S, Info>
  ): this {
    deprecate("NYLORUN_DEP_HOOKS", '.before()/.after() are deprecated. Use .beforeTurn(), .beforeModel(), .afterModel() or .afterTurn().');
    return this.addAgentHook("before", scope, fn);
  }

  /**
   * @deprecated Use `.afterModel()` or `.afterTurn()`.
   * Run `fn` after every model call (`"step"`) or after the turn's final answer (`"turn"`).
   */
  after<S extends HookScope>(
    scope: S,
    fn: AfterHook<S, Info>
  ): this {
    deprecate("NYLORUN_DEP_HOOKS", '.before()/.after() are deprecated. Use .beforeTurn(), .beforeModel(), .afterModel() or .afterTurn().');
    return this.addAgentHook("after", scope, fn);
  }

  // ── Flow: code decides ─────────────────────────────────────────────────────

  /** The flow agent's input. Set once. */
  input<S extends ToolSchemaSource>(
    schema: S
  ): FlowAgentBuilder<Info, SchemaOutput<S>, SchemaOutput<S>, {}, SchemaOut<Schema>, Id> {
    const snapshot = this.#snapshot;
    const body = this.bodyFor("flow", "input()");
    if (snapshot.inputSchema !== undefined)
      return this.spawn({
        ...snapshot,
        ...body,
        diagnostics: addDiagnostics(body.diagnostics ?? snapshot.diagnostics, [singleValue(snapshot.id, "input schema")]),
      }) as never;
    return this.spawn({ ...snapshot, ...body, inputSchema: schema }) as never;
  }

  step<C, const StepId extends string = IdOf<C>>(
    child: C,
    options?: { readonly id?: StepId; readonly input?: (args: StageArgs<any, {}, any>) => unknown }
  ): StartFlow<Info, Schema, Id, FlowOut<C>, AddResult<{}, StepId, FlowOut<C>>>;
  step(child: unknown, options?: Readonly<Record<string, unknown>>): unknown {
    return this.addStage(stepStage(child, options), "step()");
  }

  switch<const Cases extends Readonly<Record<string, unknown>>, T, const StageId extends string = string>(
    cases: Cases,
    options: {
      readonly input: (args: StageArgs<any, {}, any>) => T;
      readonly on: (args: StageArgs<T, {}, any>) => CaseKey<Cases>;
      readonly id?: StageId;
    }
  ): StartFlow<Info, Schema, Id, CasesOut<Cases>, AddResult<{}, StageId, CasesOut<Cases>>>;
  switch<const Cases extends Readonly<Record<string, unknown>>, const StageId extends string = string>(
    cases: Cases,
    options: { readonly on: (args: StageArgs<any, {}, any>) => CaseKey<Cases>; readonly id?: StageId }
  ): StartFlow<Info, Schema, Id, CasesOut<Cases>, AddResult<{}, StageId, CasesOut<Cases>>>;
  switch(cases: unknown, options?: Readonly<Record<string, unknown>>): unknown {
    return this.addStage(switchStage(cases, options), "switch()");
  }

  parallel<const Branches extends Readonly<Record<string, unknown>>, const StageId extends string = string>(
    branches: Branches,
    options?: { readonly id?: StageId; readonly input?: (args: StageArgs<any, {}, any>) => unknown }
  ): StartFlow<Info, Schema, Id, BranchesOut<Branches>, AddResult<{}, StageId, BranchesOut<Branches>>>;
  parallel(branches: unknown, options?: Readonly<Record<string, unknown>>): unknown {
    return this.addStage(parallelStage(branches, options), "parallel()");
  }

  map<E, const StageId extends string = string>(
    each: E,
    options?: { readonly id?: StageId; readonly input?: (args: StageArgs<any, {}, any>) => readonly unknown[] }
  ): StartFlow<Info, Schema, Id, FlowOut<E>[], AddResult<{}, StageId, FlowOut<E>[]>>;
  map(each: unknown, options?: Readonly<Record<string, unknown>>): unknown {
    return this.addStage(mapStage(each, options), "map()");
  }

  loop<B, const StageId extends string = string>(
    body: B,
    options: {
      readonly verify: LoopVerifyFn<any, FlowOut<B>> | object;
      readonly max?: number;
      readonly decide?: (args: LoopDecideArgs<any, FlowOut<B>>) => LoopChoice<FlowOut<B>>;
      readonly id?: StageId;
      readonly input?: (args: StageArgs<any, {}, any>) => unknown;
    }
  ): StartFlow<Info, Schema, Id, FlowOut<B>, AddResult<{}, StageId, FlowOut<B>>>;
  loop(body: unknown, options?: Readonly<Record<string, unknown>>): unknown {
    return this.addStage(loopStage(body, options), "loop()");
  }

  /** Give this agent a new step id where there is no options object. */
  withId(id: string): Named<this> {
    return named(this, id) as unknown as Named<this>;
  }

  // ── Build ─────────────────────────────────────────────────────────────────

  /** Optional no-op: returns the assembled agent facade (a workflow for flow agents). */
  build(): BuiltAgent<Info, ReactOutput<Schema>> {
    return this.ensure() as BuiltAgent<Info, ReactOutput<Schema>>;
  }

  private ensure(): BuiltAgent<Info, ReactOutput<Schema>> | BuiltWorkflow {
    if (this.#agent) return this.#agent;
    if (this.#workflow) return this.#workflow;
    if (this.#error) throw this.#error;
    const snapshot = this.#snapshot;
    if (snapshot.diagnostics?.length) {
      this.#error = new AgentBuildError(snapshot.diagnostics);
      throw this.#error;
    }
    if (snapshot.body === "flow") {
      try {
        this.#workflow = compileAgentFlow({
          id: snapshot.id,
          ...(snapshot.name === undefined ? {} : { name: snapshot.name }),
          ...(snapshot.description === undefined ? {} : { description: snapshot.description }),
          ...(snapshot.metadata === undefined ? {} : { metadata: snapshot.metadata }),
          stages: snapshot.stages,
          ...(snapshot.inputSchema === undefined ? {} : { inputSchema: snapshot.inputSchema }),
          ...(snapshot.outputSchema === undefined ? {} : { outputSchema: snapshot.outputSchema }),
          ...(snapshot.sandbox === undefined ? {} : { sandbox: snapshot.sandbox }),
        });
      } catch (error) {
        if (error instanceof WorkflowBuildError) {
          this.#error = new AgentBuildError(error.diagnostics);
          throw this.#error;
        }
        throw error;
      }
      return this.#workflow;
    }
    const result = assembleAgent(
      snapshot.entries,
      {
        id: snapshot.id,
        name: snapshot.name,
        description: snapshot.description,
        metadata: snapshot.metadata,
        outputSchema: snapshot.outputSchema,
      },
      snapshot.dynamics
    );
    if (!result.ok) {
      this.#error = new AgentBuildError(result.diagnostics);
      throw this.#error;
    }
    this.#agent = result.agent as BuiltAgent<Info, ReactOutput<Schema>>;
    return this.#agent;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** Record which body a method belongs to; mixing bodies is a build error. */
  private bodyFor(kind: "react" | "flow", method: string): { body: Body; diagnostics?: readonly BuildDiagnostic[] } {
    const snapshot = this.#snapshot;
    if (snapshot.body === "none" || snapshot.body === kind) return { body: kind };
    const diagnostic =
      kind === "react"
        ? Object.freeze({
            code: "flow.no-model",
            message: `'${snapshot.id}' is a flow agent, which runs no model. Move .${method} to an agent passed to .step().`,
          })
        : Object.freeze({
            code: "agent.mixed-body",
            message: `'${snapshot.id}' is a ReAct agent. An agent is either a ReAct loop or a flow: put the ReAct part in its own Agent and add it with .step().`,
          });
    return { body: snapshot.body, diagnostics: addDiagnostics(snapshot.diagnostics, [diagnostic]) };
  }

  private addStage(stage: FlowStage, method: string): unknown {
    const snapshot = this.#snapshot;
    const body = this.bodyFor("flow", method);
    return this.spawn({ ...snapshot, ...body, stages: Object.freeze([...snapshot.stages, stage]) });
  }

  private withAgentItems(
    method: string,
    items: { instructions?: readonly string[]; tools?: readonly (ToolDefinition<any, any, any> | AgentTool)[] }
  ): this {
    const snapshot = this.#snapshot;
    const body = this.bodyFor("react", method);
    const flows = (items.tools ?? []).filter((item) => isFlowItem(item));
    const part = {
      ...(snapshot.agentPart?.instructions !== undefined || items.instructions !== undefined
        ? { instructions: Object.freeze([...(snapshot.agentPart?.instructions ?? []), ...(items.instructions ?? [])]) }
        : {}),
      ...(snapshot.agentPart?.tools !== undefined || items.tools !== undefined
        ? { tools: Object.freeze([...(snapshot.agentPart?.tools ?? []), ...(items.tools ?? []).filter((item) => !isFlowItem(item))]) }
        : {}),
    };
    const diagnostics = flows.map((item) =>
      Object.freeze({
        code: "delegation.flow-unsupported",
        message: `'${(item as { id?: string }).id ?? "workflow"}' was built with Chain, Switch, Parallel, Map or Loop and cannot be a subagent. Write it as a flow agent, Agent({ id }).step(…), which can.`,
      })
    );
    const compiled = compileDeclaration({ id: "agent", ...part });
    const dynamics = snapshot.dynamics.get("agent") ?? {};
    const hooks = hooksFrom(dynamics.before, dynamics.after);
    const bound = hooks === undefined ? compiled.bound : Object.freeze({ ...compiled.bound, hooks });
    return this.spawn({
      ...snapshot,
      ...body,
      agentPart: Object.freeze(part),
      entries: replaceOrAppend(snapshot.entries, bound),
      dynamics: withDynamics(snapshot.dynamics, "agent", dynamics),
      diagnostics: addDiagnostics(body.diagnostics ?? snapshot.diagnostics, diagnostics),
    });
  }

  private addDeclaration(declaration: CapabilityInput<Info>, method: string): this {
    const body = this.bodyFor("react", method);
    return this.appendCompiled(compileDeclaration(declaration), body);
  }

  private appendCompiled(
    compiled: ReturnType<typeof compileDeclaration>,
    body: { body: Body; diagnostics?: readonly BuildDiagnostic[] }
  ): this {
    const snapshot = this.#snapshot;
    const dynamics = new Map(snapshot.dynamics);
    dynamics.set(compiled.bound.id, {
      ...(compiled.before ? { before: compiled.before } : {}),
      ...(compiled.after ? { after: compiled.after } : {}),
      ...(compiled.middleware ? { middleware: compiled.middleware } : {}),
    });
    return this.spawn({
      ...snapshot,
      ...body,
      entries: Object.freeze([...snapshot.entries, compiled.bound]),
      dynamics,
    });
  }

  private addAgentHook(
    at: HookAt,
    scope: HookScope,
    fn: unknown
  ): this {
    if (typeof fn !== "function")
      throw new HarnessError(
        "configuration.invalid",
        `${at}("${scope}") requires a function`
      );
    if (scope !== "turn" && scope !== "step")
      throw new HarnessError(
        "configuration.invalid",
        `Unknown hook scope '${String(scope)}'; use "turn" or "step"`
      );
    const snapshot = this.#snapshot;
    const body = this.bodyFor("react", hookMethod(at, scope));
    const dynamics = new Map(snapshot.dynamics);
    const existing = dynamics.get("agent") ?? {};
    const current = existing[at] as Record<string, unknown> | undefined;
    if (current?.[scope] !== undefined)
      return this.spawn({
        ...snapshot,
        ...body,
        diagnostics: addDiagnostics(body.diagnostics ?? snapshot.diagnostics, [
          Object.freeze({
            code: "hook.duplicate",
            message: `Agent hook ${at}("${scope}") is registered more than once`,
          }),
        ]),
      });
    const next: CapabilityDynamics = {
      ...existing,
      [at]: Object.freeze({ ...current, [scope]: fn }),
    };
    dynamics.set("agent", next);
    return this.spawn({
      ...snapshot,
      ...body,
      entries: withAgentHooks(snapshot.entries, next),
      dynamics,
    });
  }
}

function createSnapshot(
  options: AgentOptions<ToolSchemaSource | undefined>
): BuilderSnapshot {
  const entries: BoundMiddleware[] = [];
  const dynamics = new Map<string, CapabilityDynamics>();
  const instructions =
    options.instructions === undefined
      ? undefined
      : typeof options.instructions === "string"
      ? [options.instructions]
      : options.instructions;
  if (instructions !== undefined || options.tools !== undefined || options.outputSchema !== undefined)
    deprecate(
      "NYLORUN_DEP_AGENT_OPTIONS",
      "Agent({ instructions, tools, outputSchema }) is deprecated. Use .instructions(), .tools(), .subagents() and .output()."
    );
  if (instructions !== undefined || options.tools !== undefined) {
    const compiled = compileDeclaration({
      id: "agent",
      ...(instructions === undefined ? {} : { instructions }),
      ...(options.tools === undefined ? {} : { tools: options.tools }),
    });
    entries.push(compiled.bound);
    dynamics.set("agent", {});
  }
  return {
    id: options.id,
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.description === undefined
      ? {}
      : { description: options.description }),
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    outputSchema: options.outputSchema,
    entries: Object.freeze(entries),
    dynamics,
    body: instructions !== undefined || options.tools !== undefined ? "react" : "none",
    ...(instructions === undefined && options.tools === undefined
      ? {}
      : {
          agentPart: Object.freeze({
            ...(instructions === undefined ? {} : { instructions: Object.freeze([...instructions]) }),
            ...(options.tools === undefined ? {} : { tools: Object.freeze([...options.tools]) }),
          }),
        }),
    stages: Object.freeze([]),
  };
}

function hookMethod(at: HookAt, scope: HookScope): string {
  return `${at}${scope === "turn" ? "Turn" : "Model"}()`;
}

function singleValue(id: string, what: string): BuildDiagnostic {
  return Object.freeze({
    code: "agent.single-value",
    message: `'${id}' already has ${what === "sandbox" ? "a sandbox" : `an ${what}`}; set it once`,
  });
}

function addDiagnostics(
  current: readonly BuildDiagnostic[] | undefined,
  added: readonly BuildDiagnostic[]
): readonly BuildDiagnostic[] | undefined {
  if (added.length === 0) return current;
  return Object.freeze([...(current ?? []), ...added]);
}

function withDynamics(
  dynamics: ReadonlyMap<string, CapabilityDynamics>,
  id: string,
  value: CapabilityDynamics
): ReadonlyMap<string, CapabilityDynamics> {
  const next = new Map(dynamics);
  next.set(id, value);
  return next;
}

/** Replace the entry with the same id in place, or append it. */
function replaceOrAppend(
  entries: readonly BoundMiddleware[],
  bound: BoundMiddleware
): readonly BoundMiddleware[] {
  const index = entries.findIndex((item) => item.id === bound.id);
  if (index < 0) return Object.freeze([...entries, bound]);
  return Object.freeze([...entries.slice(0, index), bound, ...entries.slice(index + 1)]);
}

/**
 * A workflow built with the v1 primitives, placed where a subagent is expected. Flow
 * agents are subagents like any agent: they run in their own linked session.
 */
function isFlowItem(value: unknown): boolean {
  if (!value || typeof value !== "object" || value instanceof AgentBuilder) return false;
  return isBuiltWorkflow(value) && value.manifest.workflowSchemaVersion === 1;
}

function nextMiddlewareId(entries: readonly BoundMiddleware[]): string {
  const taken = new Set(entries.map((item) => item.id));
  let seq = 0;
  let id: string;
  do {
    seq += 1;
    id = `middleware-${seq}`;
  } while (taken.has(id));
  return id;
}

/** Record the agent-level hooks on the synthetic `"agent"` capability, creating it if needed. */
function withAgentHooks(
  entries: readonly BoundMiddleware[],
  dynamics: CapabilityDynamics
): readonly BoundMiddleware[] {
  const hooks = hooksFrom(dynamics.before, dynamics.after);
  const index = entries.findIndex((item) => item.id === "agent");
  if (index >= 0) {
    const next = Object.freeze({ ...entries[index]!, hooks });
    return Object.freeze([
      ...entries.slice(0, index),
      next,
      ...entries.slice(index + 1),
    ]);
  }
  return Object.freeze([
    ...entries,
    Object.freeze({
      id: "agent",
      handle: async (_request: unknown, next: () => Promise<unknown>) => next(),
      hasMiddleware: false,
      contributions: Object.freeze({}),
      hooks,
    } as BoundMiddleware),
  ]);
}

export type { Implementations };
export type { WorkflowBinding, WorkflowManifest };
