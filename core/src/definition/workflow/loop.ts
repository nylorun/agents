import type { AgentTool, BuiltAgent } from "../../types/agent.js";
import type { JsonValue } from "../../types/shared.js";
import type { Verdict, WorkflowAgentNode, WorkflowFnRef, WorkflowSlotNode } from "../../types/workflow.js";
import type { ToolSchemaSource } from "../../types/tool.js";
import { normalizeSchema } from "../schema.js";
import {
  assertValidPathPart,
  diagnostic,
  fail,
} from "./diagnostics.js";
import { emptyAccumulator, finishWorkflow, mergeChild } from "./build.js";
import {
  remapNodeKeys,
  resolveChild,
  type WorkflowRunnable,
} from "./runnable.js";
import { isSlot, type ChildRef, type Slot } from "./slot.js";
import type { BuiltWorkflow } from "./types.js";

/** Arguments passed to a Loop verify function. */
export type LoopVerifyArgs = {
  readonly input: JsonValue;
  readonly output: JsonValue;
  readonly iteration: number;
};

/** Arguments passed to a Loop decide function. */
export type LoopDecideArgs = {
  readonly agent?: import("../../types/manifest.js").AgentManifest;
  readonly output: JsonValue;
  readonly verdict: Verdict;
  readonly iteration: number;
  readonly input: JsonValue;
  readonly history: readonly {
    readonly iteration: number;
    readonly output: JsonValue;
    readonly verdict: Verdict;
  }[];
};

export type LoopDecision =
  | { readonly input: JsonValue; readonly agent?: import("../../types/manifest.js").AgentManifest }
  | { readonly output: JsonValue };

export type LoopVerifyFn = (
  args: LoopVerifyArgs,
  ctx?: unknown,
) => Verdict | Promise<Verdict>;

export type LoopDecideFn = (args: LoopDecideArgs) => LoopDecision;

/** @deprecated Prefer WorkflowRunnable — tracer alias. */
export type LoopRunnable = WorkflowRunnable;

export type LoopVerify =
  | LoopVerifyFn
  | BuiltAgent
  | AgentTool
  | { build(): BuiltAgent }
  | Slot<BuiltAgent | AgentTool | { build(): BuiltAgent }>;

export interface LoopOptions<In = JsonValue, Out = JsonValue> {
  readonly id: string;
  readonly run: ChildRef;
  readonly verify: LoopVerify;
  readonly decide: LoopDecideFn;
  readonly inputSchema?: ToolSchemaSource;
  readonly outputSchema?: ToolSchemaSource;
}

function isVerifyFn(value: unknown): value is LoopVerifyFn {
  return typeof value === "function";
}

/**
 * Build-time check: a verifier agent's outputSchema must accept Verdict (loops.md §5).
 */
function assertVerifierAgent(
  agent: Pick<BuiltAgent, "id" | "getBinding">,
): void {
  const schema = agent.getBinding().outputSchema;
  if (!schema) {
    fail([
      diagnostic(
        "loop.verify-schema",
        `Verifier agent '${agent.id}' must declare an outputSchema that extends Verdict`,
      ),
    ]);
  }
  const normalized = normalizeSchema(schema, "output");
  const pass = normalized.validate({ pass: true });
  const failVerdict = normalized.validate({ pass: false, feedback: "x" });
  if (!pass.ok || !failVerdict.ok) {
    fail([
      diagnostic(
        "loop.verify-schema",
        `Verifier agent '${agent.id}' outputSchema must accept Verdict ({ pass: true } | { pass: false, feedback })`,
      ),
    ]);
  }
}

/**
 * Build a Loop workflow: run → verify → decide, repeating until decide returns output.
 * `run` accepts any runnable or slot; `verify` is a function or verifier agent (loops.md).
 */
export function Loop<In = JsonValue, Out = JsonValue>(
  options: LoopOptions<In, Out>,
): BuiltWorkflow<In, Out> {
  const { id, verify, decide } = options;
  if (!id) fail([diagnostic("loop.missing-id", "Loop requires id")]);
  assertValidPathPart(id, "Loop id");
  if (!options.run) fail([diagnostic("loop.missing-run", "Loop requires run")]);
  if (!verify) fail([diagnostic("loop.missing-verify", "Loop requires verify")]);
  if (!decide || typeof decide !== "function")
    fail([diagnostic("loop.missing-decide", "Loop requires decide")]);

  const acc = emptyAccumulator();
  const runResolved = resolveChild(options.run);
  const runPath = `${id}/${runResolved.id}`;
  mergeChild(acc, {
    agents: runResolved.agents,
    nodes: remapNodeKeys(runResolved.nodes, runResolved.id, runPath),
    sandboxSpecs: runResolved.sandboxSpecs,
  });

  let verifyField: WorkflowFnRef | WorkflowAgentNode | WorkflowSlotNode;
  if (isVerifyFn(verify)) {
    verifyField = { fn: true };
    acc.nodes[id] = { kind: "verify", fn: verify as (...args: never[]) => unknown };
  } else {
    const verifyChild = isSlot(verify)
      ? resolveChild(verify as ChildRef)
      : resolveChild(verify as WorkflowRunnable);
    const agentEntry = Object.values(verifyChild.agents)[0];
    if (!agentEntry) {
      fail([
        diagnostic(
          "loop.invalid-verify",
          "Loop.verify must be a verify function or a verifier agent",
        ),
      ]);
    }
    assertVerifierAgent({
      id: agentEntry.manifest.id,
      getBinding: () => agentEntry,
    });
    // Keys follow the harness path for the verifier, `<loop>/<part>` (workflows.md §6).
    mergeChild(acc, {
      agents: verifyChild.agents,
      nodes: remapNodeKeys(verifyChild.nodes, verifyChild.id, `${id}/${verifyChild.id}`),
      sandboxSpecs: verifyChild.sandboxSpecs,
    });
    const node = verifyChild.node;
    if (!("agent" in node) && !("slot" in node)) {
      fail([
        diagnostic(
          "loop.invalid-verify",
          "Loop.verify must be a verify function or a verifier agent",
        ),
      ]);
    }
    verifyField = node as WorkflowAgentNode | WorkflowSlotNode;
  }

  acc.nodes[`${id}/decide`] = {
    kind: "fn",
    fn: decide as (...args: never[]) => unknown,
  };

  return finishWorkflow<In, Out>({
    id,
    root: {
      loop: {
        id,
        run: runResolved.node,
        verify: verifyField,
        decide: { fn: true },
      },
    },
    acc,
    inputSchema: options.inputSchema,
    outputSchema: options.outputSchema,
  });
}
