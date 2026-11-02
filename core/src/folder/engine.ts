/**
 * `agent-folder/2` (ADR-100): a folder declares every engine feature it uses, and our engine adds
 * nothing else. `AGENT.md` names the format (`format: agent-folder/2`, or `2`) and, in its
 * `engine:` block, the features no other key declares:
 *
 * ```yaml
 * format: agent-folder/2
 * memory: { access: read_write, index: true }      # index can be turned off
 * engine:
 *   sandbox: [bash, read, write, edit, grep, glob]  # any subset; needs a computer in runtime.json
 *   artifacts: { read: true, save: false }          # save needs a computer
 *   outputs: true                                   # save /workspace/outputs when a turn ends; needs a computer
 *   toolSearch: false                               # no automatic deferral; a server's own `deferred` still applies
 *   triggers: true                                  # the triggers tool and its text (D83); the root agent's only
 *   instructions:                                   # a block's wording, replaced by a file under engine/
 *     memory: engine/memory.md
 * ```
 *
 * The compiled manifest's `harness.engine` holds the declarations, each replaced wording's text,
 * and the text blocks the agent gets (`blocks`), each with its version and hash, so an engine
 * release that changes a block changes the version's hash. A subagent (`agents/<id>/`) declares
 * its own `engine:` block, a subset of its parent's; without one it gets no engine feature.
 */
import { SANDBOX_TOOL_NAMES, SANDBOX_WORKSPACE, type SandboxToolName } from "../utils/sandbox.js";
import { ENGINE_BLOCK_NAMES, isEngineBlockName, type EngineBlockName } from "../engine/names.js";
import { blockRefs } from "../engine/blocks.js";
import { DEFAULT_ENGINE_TOOL_LIMITS, engineProjection } from "../engine/projection.js";
import { TOOL_SEARCH_TOOL } from "../engine/tools.js";
import type { HarnessEngine, SkillManifest, ToolManifest } from "../types/manifest.js";
import { suggestion } from "./suggest.js";
import type { ReportOptions } from "./context.js";

/** The keys of `AGENT.md`'s `engine:` block. */
export const ENGINE_KEYS = ["sandbox", "artifacts", "outputs", "toolSearch", "triggers", "instructions"] as const;
const ARTIFACT_KEYS = ["read", "save"] as const;
/** Where a folder keeps the files that replace a block's wording. */
export const ENGINE_TEXT_DIR = "engine";

/** A folder's format: 1 (`agent-folder/1`, the default) or 2 (`agent-folder/2`); undefined when it is neither. */
export function folderFormatOf(value: unknown): 1 | 2 | undefined {
  if (value === undefined || value === 1 || value === "agent-folder/1") return 1;
  if (value === 2 || value === "agent-folder/2") return 2;
  return undefined;
}

/** What a folder inside another needs to know of the folder that holds it. */
export interface EngineScopeFacts {
  readonly format: 1 | 2;
  /** The uploaded folder's runtime has a computer (kind `virtual` or `pod`). */
  readonly computer: boolean;
  /** The root agent's declarations, under format 2: a subagent's are a subset. */
  readonly engine?: HarnessEngine;
  /** The root agent has memory: a subagent may view it. */
  readonly memory: boolean;
  /** The uploaded folder's runtime sets `selfWake`. */
  readonly selfWake: boolean;
  /** The uploaded folder is `agent-folder/3` (ADR-105). */
  readonly v3?: boolean;
  /** Its plugins, under format 3: a subagent's are a subset. */
  readonly plugins?: readonly { readonly name: import("../plugins/index.js").PluginName; readonly tools: readonly string[] }[];
}

type Fail = (code: string, message: string, path?: readonly PropertyKey[], options?: ReportOptions) => void;

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * `AGENT.md`'s `engine:` block, checked: the declarations, with each replaced wording read from
 * its file (`text`), and the files they came from (`sources`). Undefined, with the errors
 * reported, when it is not one. `parent` is a subagent's parent's declarations.
 */
export function engineDeclarations(
  value: unknown,
  options: {
    readonly error: Fail;
    readonly computer: boolean;
    readonly role: "root" | "subagent";
    readonly parent?: HarnessEngine;
    /** The text of a file of the folder that replaces a block's wording, or undefined after reporting why not. */
    readonly text: (path: string, at: readonly PropertyKey[]) => string | undefined;
  },
): { engine: HarnessEngine; sources: Partial<Record<EngineBlockName, string>> } | undefined {
  const { error, computer, role, parent } = options;
  const sources: Partial<Record<EngineBlockName, string>> = {};
  if (value === undefined) return { engine: {}, sources };
  if (!isObject(value)) {
    error("value_invalid", `engine is a map of the engine features the agent uses: ${ENGINE_KEYS.join(", ")}`, ["engine"]);
    return undefined;
  }
  let valid = true;
  const fail: Fail = (...args) => {
    valid = false;
    error(...args);
  };
  const needsComputer = (what: string, path: readonly PropertyKey[]) =>
    fail(
      "engine_needs_computer",
      `${what} needs a computer, and the runtime has none. Fix: set "kind": "virtual" (or "pod") in runtime.json, or leave it out`,
      path,
    );
  const subset = (what: string, path: readonly PropertyKey[]) =>
    fail("engine_subset", `${what}, and the agent that holds this subagent does not: a subagent's engine block is a subset of its parent's`, path);
  for (const key of Object.keys(value))
    if (!(ENGINE_KEYS as readonly string[]).includes(key)) {
      const close = suggestion(key, ENGINE_KEYS);
      fail("unknown_key", `Unknown key '${key}'.${close ? ` Did you mean '${close}'?` : ` Known keys: ${ENGINE_KEYS.join(", ")}.`}`, ["engine", key], {
        key: true,
        rename: ENGINE_KEYS,
      });
    }
  const engine: { -readonly [K in keyof HarnessEngine]: HarnessEngine[K] } = {};
  // sandbox: any of the six, each once.
  if (value.sandbox !== undefined) {
    const at = ["engine", "sandbox"];
    if (!Array.isArray(value.sandbox) || !value.sandbox.every((item) => typeof item === "string"))
      fail("value_invalid", `engine.sandbox is a list of sandbox tools: any of ${SANDBOX_TOOL_NAMES.join(", ")}`, at);
    else {
      const names: SandboxToolName[] = [];
      for (const [index, name] of (value.sandbox as string[]).entries()) {
        if (!(SANDBOX_TOOL_NAMES as readonly string[]).includes(name)) {
          const close = suggestion(name, SANDBOX_TOOL_NAMES);
          fail("value_invalid", `${name} is not a sandbox tool: ${SANDBOX_TOOL_NAMES.join(", ")}.${close ? ` Did you mean '${close}'?` : ""}`, [...at, index]);
        } else if (names.includes(name as SandboxToolName)) fail("value_invalid", `engine.sandbox names ${name} twice`, [...at, index]);
        else names.push(name as SandboxToolName);
      }
      if (names.length > 0 && !computer) needsComputer("engine.sandbox", at);
      const outside = names.filter((name) => parent !== undefined && !(parent.sandbox ?? []).includes(name));
      if (role === "subagent" && outside.length > 0) subset(`engine.sandbox names ${outside.join(", ")}`, at);
      engine.sandbox = SANDBOX_TOOL_NAMES.filter((name) => names.includes(name));
    }
  }
  if (value.artifacts !== undefined) {
    const at = ["engine", "artifacts"];
    if (!isObject(value.artifacts)) fail("value_invalid", "engine.artifacts is a map: read and save, each true or false", at);
    else {
      const artifacts: { read?: boolean; save?: boolean } = {};
      for (const [key, flag] of Object.entries(value.artifacts)) {
        if (!(ARTIFACT_KEYS as readonly string[]).includes(key)) {
          fail("unknown_key", `Unknown key '${key}'. Known keys: read, save.`, [...at, key], { key: true, rename: ARTIFACT_KEYS });
          continue;
        }
        if (typeof flag !== "boolean") {
          fail("value_invalid", `engine.artifacts.${key} is true or false`, [...at, key]);
          continue;
        }
        artifacts[key as "read" | "save"] = flag;
      }
      if (artifacts.save === true && !computer) needsComputer("engine.artifacts.save (save_artifact saves a file of the sandbox)", [...at, "save"]);
      if (role === "subagent" && artifacts.read === true && parent?.artifacts?.read !== true) subset("engine.artifacts.read is true", [...at, "read"]);
      if (role === "subagent" && artifacts.save === true && parent?.artifacts?.save !== true) subset("engine.artifacts.save is true", [...at, "save"]);
      engine.artifacts = artifacts;
    }
  }
  if (value.outputs !== undefined) {
    const at = ["engine", "outputs"];
    if (typeof value.outputs !== "boolean") fail("value_invalid", `engine.outputs is true or false: true saves ${SANDBOX_WORKSPACE}/outputs when a turn ends`, at);
    // A subagent shares its parent's sandbox: with outputs, it is told of the folder its parent's
    // turn saves.
    else if (role === "subagent" && value.outputs && parent?.outputs !== true) subset("engine.outputs is true", at);
    else {
      if (value.outputs && !computer) needsComputer(`engine.outputs (${SANDBOX_WORKSPACE}/outputs is a folder of the sandbox)`, at);
      engine.outputs = value.outputs;
    }
  }
  if (value.toolSearch !== undefined) {
    const at = ["engine", "toolSearch"];
    if (typeof value.toolSearch !== "boolean") fail("value_invalid", "engine.toolSearch is true or false: true defers MCP tools behind tool_search past the threshold", at);
    else {
      if (role === "subagent" && value.toolSearch && parent?.toolSearch !== true) subset("engine.toolSearch is true", at);
      engine.toolSearch = value.toolSearch;
    }
  }
  // triggers: the root agent's (D83). A subagent whose parent declares them is refused in
  // `nested.ts`; one whose parent does not, here.
  if (value.triggers !== undefined) {
    const at = ["engine", "triggers"];
    if (typeof value.triggers !== "boolean")
      fail("value_invalid", "engine.triggers is true or false: true offers the agent the triggers tool, to set up its own schedules and follow-ups", at);
    else {
      if (role === "subagent" && value.triggers && parent?.triggers !== true) subset("engine.triggers is true", at);
      engine.triggers = value.triggers;
    }
  }
  if (value.instructions !== undefined) {
    const at = ["engine", "instructions"];
    if (!isObject(value.instructions))
      fail("value_invalid", `engine.instructions is a map of block names to Markdown files under ${ENGINE_TEXT_DIR}/: ${ENGINE_BLOCK_NAMES.join(", ")}`, at);
    else {
      const texts: Partial<Record<EngineBlockName, string>> = {};
      for (const [block, path] of Object.entries(value.instructions)) {
        if (!isEngineBlockName(block)) {
          const close = suggestion(block, ENGINE_BLOCK_NAMES);
          fail("unknown_key", `${block} is not an engine text block.${close ? ` Did you mean '${close}'?` : ` The blocks are ${ENGINE_BLOCK_NAMES.join(", ")}.`}`, [...at, block], {
            key: true,
            rename: ENGINE_BLOCK_NAMES,
          });
          continue;
        }
        if (typeof path !== "string" || path === "") {
          fail("value_invalid", `engine.instructions.${block} is the path of a Markdown file under ${ENGINE_TEXT_DIR}/, such as ${ENGINE_TEXT_DIR}/${block}.md`, [...at, block]);
          continue;
        }
        const relative = path.replace(/^\.\//, "");
        if (!relative.startsWith(`${ENGINE_TEXT_DIR}/`) || !relative.endsWith(".md")) {
          fail("value_invalid", `engine.instructions.${block} names ${path}: a block's wording is a Markdown file under ${ENGINE_TEXT_DIR}/, such as ${ENGINE_TEXT_DIR}/${block}.md`, [...at, block]);
          continue;
        }
        const text = options.text(relative, [...at, block]);
        if (text === undefined) {
          valid = false;
          continue;
        }
        texts[block] = text;
        sources[block] = relative;
      }
      if (Object.keys(texts).length > 0) engine.instructions = texts;
    }
  }
  return valid ? { engine, sources } : undefined;
}

/**
 * The text blocks an agent gets, from what it declares and what the folder says of its session:
 * whether its runtime has a computer and sets `selfWake`, its skills, memory and loop settings,
 * whether it is the root agent declaring `engine.triggers`, and whether its MCP tools may be
 * deferred. The harness's own projection decides them
 * (`engineProjection`), so the list is what a session's system text holds.
 */
export function engineBlocksOf(
  agent: {
    readonly engine: HarnessEngine;
    readonly tools?: readonly ToolManifest[];
    readonly skills?: Readonly<Record<string, SkillManifest>>;
    readonly mcpServers?: Readonly<Record<string, { readonly deferred?: boolean; readonly tools?: Readonly<Record<string, { readonly deferred?: boolean }>> }>>;
  },
  facts: {
    readonly computer: boolean;
    readonly selfWake: boolean;
    readonly memory?: { readonly root: boolean; readonly access?: "read_write" | "read_only"; readonly index?: boolean };
    readonly plan: boolean;
    readonly connections: boolean;
    /** The root agent declares `engine.triggers` (D83). */
    readonly triggers?: boolean;
    /** The root agent has `ask` (`agent-folder/3`, `harness.loop.ask`). */
    readonly ask?: boolean;
  },
): EngineBlockName[] {
  const projection = engineProjection(
    agent,
    { ...(facts.computer ? { sandbox: { workspace: SANDBOX_WORKSPACE } } : {}), ...(facts.selfWake ? { selfWake: true } : {}) },
    DEFAULT_ENGINE_TOOL_LIMITS,
    facts.memory && { access: facts.memory.access ?? "read_write", root: facts.memory.root, index: facts.memory.index !== false },
    facts.plan,
    facts.connections,
    facts.triggers === true,
    facts.ask === true,
  );
  const names = projection.blocks.map((block) => block.name);
  const servers = Object.values(agent.mcpServers ?? {});
  const deferrable =
    servers.length > 0 &&
    (agent.engine.toolSearch === true ||
      servers.some((server) => server.deferred === true || Object.values(server.tools ?? {}).some((tool) => tool.deferred === true)));
  if (deferrable && !(agent.tools ?? []).some((tool) => tool.name === TOOL_SEARCH_TOOL)) names.push("tool_search");
  return names;
}

/** `harness.engine` as the compiled manifest holds it: the declarations, then the blocks. */
export function compiledEngine(
  engine: HarnessEngine,
  blocks: readonly EngineBlockName[],
  sources: Partial<Record<EngineBlockName, string>>,
): HarnessEngine {
  return { ...engine, blocks: blockRefs(blocks, engine, sources) };
}

/** The blocks whose wording `engine` replaces that the agent does not get. */
export function unusedInstructions(engine: HarnessEngine, blocks: readonly EngineBlockName[]): EngineBlockName[] {
  return (Object.keys(engine.instructions ?? {}) as EngineBlockName[]).filter((name) => !blocks.includes(name));
}
