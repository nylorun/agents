/**
 * `flow.json` (track T7, design §3.8): workflow manifest v3's node tree, as a folder writes it.
 * The node names are v3's (`agent`, `tool`, `chain`, `switch`, `parallel`, `map`, `loop`, and
 * `id` on any node), so a v3 tree pastes in. Two leaves differ, because a folder names things
 * instead of embedding them:
 *
 * - `{ "agent": "<id>" }` names a folder of the flow root's `agents/`. The compiler embeds its
 *   manifest where v3 wants it: a sub-flow's agents in the sub-flow, not in the root.
 * - `{ "tool": "<name>" }` names `tools/<name>.json` beside that `flow.json`, and a loop's
 *   `verify` takes `{ "agent" }` or `{ "tool" }`, the folder form of `{ "http" }`.
 *
 * Every problem is reported with its place in `flow.json`; translating goes on past it, so one
 * pass names them all.
 */
import { isObject, type EmbeddedAgent, type ReportOptions } from "./context.js";

export const NODE_KINDS = ["agent", "tool", "chain", "switch", "parallel", "map", "loop"] as const;
const NODE_KEYS = [...NODE_KINDS, "id"];
/** The keys of `switch`, `map`, `loop` and a loop's `verify`: `schemas.ts` builds `flow.json`'s JSON Schema from them. */
export const SWITCH_KEYS = ["cases", "default"] as const;
export const MAP_KEYS = ["each"] as const;
export const LOOP_KEYS = ["run", "verify", "max"] as const;
export const VERIFY_KEYS = ["agent", "tool", "id"] as const;
const FLOW_FILE = "flow.json";

/** What a flow's leaves name: the flow root's agents and the tools beside this `flow.json`. */
export interface FlowNames {
  readonly agentIds: readonly string[];
  agent(id: string): EmbeddedAgent | "unknown" | "cycle" | "failed";
  /** The agents used, by id: unused ones are a warning at the flow root. */
  readonly used: Set<string>;
  readonly tools: ReadonlyMap<string, Record<string, unknown>>;
}

export interface TranslatedFlow {
  /** The v3 node tree; undefined when a node has an error. */
  readonly root?: Record<string, unknown>;
  /** The agents it names, embedded in the order the tree first names them. */
  readonly agents: Record<string, EmbeddedAgent>;
  readonly toolsUsed: ReadonlySet<string>;
  /** False when an agent it names did not compile: its errors are reported where it is. */
  readonly complete: boolean;
}

type FlowReport = (code: string, message: string, file: string, path: readonly PropertyKey[], options?: ReportOptions) => void;

/** Translates `flow.json`'s node tree into v3's, embedding the agents and tools it names. */
export function translateFlow(
  flow: Record<string, unknown>,
  names: FlowNames,
  report: FlowReport,
  suggest: (name: string, known: readonly string[]) => string | undefined,
): TranslatedFlow {
  const agents: Record<string, EmbeddedAgent> = {};
  const toolsUsed = new Set<string>();
  let complete = true;
  let valid = true;
  const fail = (code: string, message: string, path: readonly PropertyKey[], options?: ReportOptions) => {
    valid = false;
    report(code, message, FLOW_FILE, path, options);
  };
  const close = (name: string, known: readonly string[]) => {
    const found = suggest(name, known);
    return found ? ` Did you mean '${found}'?` : "";
  };
  const checkKeys = (value: Record<string, unknown>, known: readonly string[], path: readonly PropertyKey[]) => {
    for (const key of Object.keys(value))
      if (!known.includes(key)) {
        const found = suggest(key, known);
        fail("unknown_key", `Unknown key '${key}'.${found ? ` Did you mean '${found}'?` : ` Known keys: ${known.join(", ")}.`}`, [...path, key], { key: true, rename: known });
      }
  };

  /** `{ agent }`: the agent's id, with its manifest embedded. */
  const agentLeaf = (value: unknown, path: readonly PropertyKey[]): string | undefined => {
    if (typeof value !== "string" || value === "") {
      fail("flow_invalid", "agent names a folder of the flow root's agents/ by its id", path);
      return undefined;
    }
    names.used.add(value);
    const found = names.agent(value);
    if (found === "unknown") {
      fail("agent_unknown", `No agent ${value} is in the flow root's agents/.${close(value, names.agentIds)}`, path);
      return undefined;
    }
    if (found === "cycle") {
      fail("flow_cycle", `${value} is a sub-flow that runs itself through this node: a flow cannot contain itself`, path);
      return undefined;
    }
    if (found === "failed") {
      complete = false;
      return value;
    }
    agents[value] ??= found;
    return value;
  };

  /** `{ tool }`: the tool file beside this flow.json. */
  const toolLeaf = (value: unknown, path: readonly PropertyKey[]): Record<string, unknown> | undefined => {
    if (isObject(value)) {
      fail("flow_invalid", 'A flow names a tool by its file: write "tool": "<name>" and keep the tool in tools/<name>.json beside this flow.json', path);
      return undefined;
    }
    if (typeof value !== "string" || value === "") {
      fail("flow_invalid", "tool names a file of tools/ beside this flow.json, without .json", path);
      return undefined;
    }
    const tool = names.tools.get(value);
    if (!tool) {
      fail("tool_unknown", `No tool ${value} is in tools/ beside this flow.json (tools/${value}.json).${close(value, [...names.tools.keys()])}`, path);
      return undefined;
    }
    toolsUsed.add(value);
    if (tool.approval !== undefined) {
      valid = false;
      report("flow_invalid", "A flow's tool takes no approval: approvals are the Tenant's tool policy", `tools/${value}.json`, ["approval"], { key: true });
      return undefined;
    }
    return tool;
  };

  const node = (value: unknown, path: readonly PropertyKey[]): Record<string, unknown> | undefined => {
    if (!isObject(value)) {
      fail("flow_invalid", `A node is an object with one of ${NODE_KINDS.join(", ")}, and an optional id`, path);
      return undefined;
    }
    checkKeys(value, NODE_KEYS, path);
    const kinds = NODE_KINDS.filter((kind) => kind in value);
    if (kinds.length !== 1) {
      fail(
        "flow_invalid",
        kinds.length === 0
          ? `A node has one of ${NODE_KINDS.join(", ")}`
          : `A node has one of ${NODE_KINDS.join(", ")}; this one has ${kinds.join(" and ")}: nest one inside the other, as in a chain`,
        path,
      );
      return undefined;
    }
    const id = value.id;
    if (id !== undefined && (typeof id !== "string" || id === "")) fail("flow_invalid", "id is a non-empty string", [...path, "id"]);
    const withId = (built: Record<string, unknown> | undefined) =>
      built === undefined ? undefined : { ...built, ...(typeof id === "string" && id !== "" ? { id } : {}) };
    const kind = kinds[0]!;
    const at = [...path, kind];
    const body = value[kind];
    switch (kind) {
      case "agent": {
        const agent = agentLeaf(body, at);
        return withId(agent === undefined ? undefined : { agent });
      }
      case "tool": {
        const tool = toolLeaf(body, at);
        return withId(tool === undefined ? undefined : { tool: stageTool(tool) });
      }
      case "chain": {
        if (!Array.isArray(body) || body.length === 0) {
          fail("flow_invalid", "chain is a list of one or more nodes, run in order", at);
          return undefined;
        }
        const chain = body.map((item, index) => node(item, [...at, index]));
        return withId(chain.every((item) => item !== undefined) ? { chain } : undefined);
      }
      case "switch": {
        if (!isObject(body)) {
          fail("flow_invalid", "switch is { cases: { <route>: <node> }, default?: <node> }", at);
          return undefined;
        }
        checkKeys(body, SWITCH_KEYS, at);
        if (!isObject(body.cases)) {
          fail("flow_invalid", "cases maps each route to the node it runs", body.cases === undefined ? at : [...at, "cases"]);
          return undefined;
        }
        const cases = Object.fromEntries(Object.entries(body.cases).map(([key, item]) => [key, node(item, [...at, "cases", key])]));
        const fallback = body.default === undefined ? undefined : node(body.default, [...at, "default"]);
        if (Object.values(cases).some((item) => item === undefined) || (body.default !== undefined && fallback === undefined)) return undefined;
        return withId({ switch: { cases, ...(fallback === undefined ? {} : { default: fallback }) } });
      }
      case "parallel": {
        if (!isObject(body) || Object.keys(body).length === 0) {
          fail("flow_invalid", "parallel maps each branch's name to the node it runs, with at least one branch", at);
          return undefined;
        }
        const branches = Object.fromEntries(Object.entries(body).map(([key, item]) => [key, node(item, [...at, key])]));
        return withId(Object.values(branches).every((item) => item !== undefined) ? { parallel: branches } : undefined);
      }
      case "map": {
        if (!isObject(body) || body.each === undefined) {
          fail("flow_invalid", "map is { each: <node> }: the node runs once per item of its input", at);
          return undefined;
        }
        checkKeys(body, MAP_KEYS, at);
        const each = node(body.each, [...at, "each"]);
        return withId(each === undefined ? undefined : { map: { each } });
      }
      case "loop": {
        if (!isObject(body)) {
          fail("flow_invalid", "loop is { run: <node>, verify: { agent } or { tool }, max: <attempts> }", at);
          return undefined;
        }
        checkKeys(body, LOOP_KEYS, at);
        const run = body.run === undefined ? undefined : node(body.run, [...at, "run"]);
        if (body.run === undefined) fail("flow_invalid", "loop needs run: the node each attempt runs", at);
        const verify = verifier(body.verify, [...at, "verify"]);
        if (typeof body.max !== "number" || !Number.isInteger(body.max) || body.max < 1) {
          fail("flow_invalid", "max is the most attempts the loop makes: a whole number, 1 or more", body.max === undefined ? at : [...at, "max"]);
          return undefined;
        }
        if (run === undefined || verify === undefined) return undefined;
        return withId({ loop: { run, verify, max: body.max } });
      }
    }
  };

  /** A loop's `verify`: `{ agent, id? }`, or `{ tool }` for an HTTP verifier (`{ http }` in v3). */
  const verifier = (value: unknown, path: readonly PropertyKey[]): Record<string, unknown> | undefined => {
    if (!isObject(value)) {
      fail("flow_invalid", "verify is { agent: <id> } or { tool: <name> }: what judges each attempt", path);
      return undefined;
    }
    if ("http" in value) {
      fail("flow_invalid", 'An HTTP verifier is a tool file: write "verify": { "tool": "<name>" } with tools/<name>.json beside this flow.json', [...path, "http"], { key: true });
      return undefined;
    }
    checkKeys(value, VERIFY_KEYS, path);
    if (("agent" in value) === ("tool" in value)) {
      fail("flow_invalid", "verify has exactly one of agent and tool", path);
      return undefined;
    }
    if ("tool" in value) {
      if (value.id !== undefined) fail("flow_invalid", "An HTTP verifier takes no id", [...path, "id"], { key: true });
      const tool = toolLeaf(value.tool, [...path, "tool"]);
      return tool === undefined || value.id !== undefined ? undefined : { http: tool.http };
    }
    const id = value.id;
    if (id !== undefined && (typeof id !== "string" || id === "")) fail("flow_invalid", "id is a non-empty string", [...path, "id"]);
    const agent = agentLeaf(value.agent, [...path, "agent"]);
    return agent === undefined ? undefined : { agent, ...(typeof id === "string" && id !== "" ? { id } : {}) };
  };

  const root = node(flow, []);
  return { ...(valid && root !== undefined ? { root } : {}), agents, toolsUsed, complete };
}

/** An HTTP tool, compiled from its file, as a v3 stage: its name, schemas and request. */
function stageTool(tool: Record<string, unknown>): Record<string, unknown> {
  const { approval: _, ...stage } = tool;
  return stage;
}
