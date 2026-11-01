/**
 * Our engine's own tools as the model reads them (protocol 15, ADR-100): each tool's name,
 * description, input schema and the effect its calls make. Our harness runs them
 * (`@nylorun/harness`); the compiler and the SDK's `previewTurn` read the same definitions, so
 * what a preview shows is what a session is offered. Their schemas reach the model: change them
 * deliberately.
 */
import { z } from "zod";
import { ARTIFACT_NAME_MAX, PLAN_LIMITS, PLAN_STEP_STATES, TRIGGER_DELAY_PATTERN, TRIGGER_TITLE_MAX } from "../contracts.js";
import { MEMORY_ROOT } from "../utils/memory.js";
import { SANDBOX_TOOL_NAMES, SANDBOX_WORKSPACE, type SandboxToolName } from "../utils/sandbox.js";
import { SKILL_ENTRY } from "../utils/definition-files.js";
import { READ_ARTIFACT_TOOL, SAVE_ARTIFACT_TOOL } from "../utils/runtime-tools.js";
import { tool } from "../definition/helpers.js";
import { normalizedSchemasFor } from "../definition/schema.js";
import { ToolError } from "../definition/tool-error.js";
import type { JsonObject } from "../types/shared.js";
import type { SkillManifest } from "../types/manifest.js";
import type { EffectTarget } from "../harness-api/messages.js";

/**
 * A tool our engine adds to an agent for one execution (one of our engine's own, a session's MCP
 * tool). It is not part of the hashed manifest.
 */
export interface EngineTool {
  /** The agent used as a tool that owns this tool; absent for the root agent. */
  readonly agentId?: string;
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema?: JsonObject;
  /**
   * Not in the model's tool list (R2b C10): the model finds it with `tool_search` and runs it
   * with `tool_call`, which makes the call as this tool's own.
   */
  readonly deferred?: boolean;
  /** Text the model reads, after the engine's, while this tool is advertised. */
  readonly instructions?: readonly string[];
  /** What runs its calls: their effects' `target` (an MCP tool's identity, our engine's `harness`). */
  readonly target?: EffectTarget;
}

const SCHEMA = "http://json-schema.org/draft-07/schema#";
const HARNESS: EffectTarget = Object.freeze({ kind: "harness" });
const SANDBOX: EffectTarget = Object.freeze({ kind: "sandbox" });

// --- The sandbox tools -----------------------------------------------------------------------

/** What the sandbox tools hold a call to: the harness's configuration of them. */
export interface SandboxToolLimits {
  /** The characters of `bash` stdout and stderr each keeps, its middle cut past it. */
  readonly outputChars: number;
  /** Seconds a `bash` command runs when it names no `timeout`. */
  readonly defaultTimeoutS: number;
  /** The longest `timeout` a `bash` command may name, in seconds. */
  readonly maxTimeoutS: number;
  /** Lines `read` returns when it names no `limit`. */
  readonly readLines: number;
  /** The most lines one `read` may ask for. */
  readonly maxReadLines: number;
  /** The characters of one line `read` and `grep` show, the rest cut. */
  readonly lineChars: number;
  /** Matches `grep` returns when it names no `max_results`. */
  readonly grepResults: number;
  /** The most matches one `grep` may ask for. */
  readonly maxGrepResults: number;
  /** The most paths `glob` returns. */
  readonly globResults: number;
  /** The most files `glob` looks through. */
  readonly globScan: number;
}

/** The sandbox tools' limits when the harness sets none. */
export const DEFAULT_SANDBOX_TOOL_LIMITS: SandboxToolLimits = Object.freeze({
  outputChars: 30_000,
  defaultTimeoutS: 120,
  maxTimeoutS: 600,
  readLines: 2000,
  maxReadLines: 5000,
  lineChars: 2000,
  grepResults: 200,
  maxGrepResults: 1000,
  globResults: 500,
  globScan: 20_000,
});

/** The limits in force: `set`, with the default for each it leaves out. */
export function sandboxToolLimitsOf(set?: Partial<SandboxToolLimits>): SandboxToolLimits {
  return Object.freeze({ ...DEFAULT_SANDBOX_TOOL_LIMITS, ...definedOf(set ?? {}) });
}

const object = (properties: JsonObject, required: readonly string[]): JsonObject => ({
  $schema: SCHEMA,
  type: "object",
  properties,
  required: [...required],
  additionalProperties: false,
});
const pathField = { type: "string", minLength: 1 };

/**
 * The sandbox tools, in the order the model reads them, with `workspace` named in their text
 * and `limits` in their schemas: all six, or those `names` lists (ADR-100, `engine.sandbox`),
 * still in our order. Each is a `sandbox` effect named by its operation.
 */
export function sandboxTools(
  limits: SandboxToolLimits,
  workspace: string,
  names: readonly SandboxToolName[] = SANDBOX_TOOL_NAMES,
): EngineTool[] {
  const relative = `Relative paths resolve under ${workspace}.`;
  const tools: Omit<EngineTool, "target">[] = [
    {
      name: "bash",
      description:
        `Run a bash command in the sandbox. The working directory is ${workspace}. ` +
        "Returns exitCode, stdout and stderr; a non-zero exit code is a normal result, not an error. " +
        "Long output is truncated in the middle.",
      inputSchema: object(
        {
          command: { type: "string", minLength: 1, description: "The command line to run with bash." },
          timeout: {
            description: `Seconds before the command is killed. Default ${limits.defaultTimeoutS}, maximum ${limits.maxTimeoutS}.`,
            type: "integer",
            minimum: 1,
            maximum: limits.maxTimeoutS,
          },
        },
        ["command"],
      ),
    },
    {
      name: "read",
      description:
        `Read a text file from the sandbox. ${relative} Returns numbered lines. ` +
        "Use offset and limit to page through large files.",
      inputSchema: object(
        {
          path: pathField,
          offset: {
            description: "First line to return, 1-based.",
            type: "integer",
            minimum: 1,
            maximum: Number.MAX_SAFE_INTEGER,
          },
          limit: {
            description: `Maximum number of lines. Default ${limits.readLines}.`,
            type: "integer",
            minimum: 1,
            maximum: limits.maxReadLines,
          },
        },
        ["path"],
      ),
    },
    {
      name: "write",
      description: `Create or overwrite a text file in the sandbox. ${relative} Parent directories are created.`,
      inputSchema: object({ path: pathField, content: { type: "string" } }, ["path", "content"]),
    },
    {
      name: "edit",
      description:
        `Replace text in a sandbox file. ${relative} old_string must match exactly and be unique ` +
        "unless replace_all is true.",
      inputSchema: object(
        {
          path: pathField,
          old_string: { type: "string", minLength: 1 },
          new_string: { type: "string" },
          replace_all: { type: "boolean" },
        },
        ["path", "old_string", "new_string"],
      ),
    },
    {
      name: "grep",
      description:
        `Search file contents in the sandbox with an extended regular expression. ${relative} ` +
        "Returns matching lines as path:line:text.",
      inputSchema: object(
        {
          pattern: { type: "string", minLength: 1 },
          path: { description: `Directory or file to search. Default ${workspace}.`, ...pathField },
          glob: { description: 'Only search files whose name matches, e.g. "*.py".', ...pathField },
          ignore_case: { type: "boolean" },
          max_results: {
            description: `Default ${limits.grepResults}.`,
            type: "integer",
            minimum: 1,
            maximum: limits.maxGrepResults,
          },
        },
        ["pattern"],
      ),
    },
    {
      name: "glob",
      description: `Find files in the sandbox by glob pattern, e.g. "**/*.csv". ${relative} Returns matching paths.`,
      inputSchema: object(
        {
          pattern: { type: "string", minLength: 1 },
          path: { description: `Directory to search. Default ${workspace}.`, ...pathField },
        },
        ["pattern"],
      ),
    },
  ];
  return tools.filter((item) => names.includes(item.name as SandboxToolName)).map((item) => ({ ...item, target: SANDBOX }));
}

// --- The artifact tools ----------------------------------------------------------------------

const SAVE_DESCRIPTION =
  `Save a file as an artifact of this session, for the user to download. Give path (a file in the sandbox; relative paths resolve under ${SANDBOX_WORKSPACE}) or content (text), not both. ` +
  "Returns the artifact's id and version. Pass artifactId to save a new version of an artifact you saved before.";

const SAVE_SCHEMA: JsonObject = {
  $schema: SCHEMA,
  type: "object",
  properties: {
    path: { description: "A file in the sandbox.", type: "string", minLength: 1 },
    content: { description: "Text to save instead of a file.", type: "string" },
    name: {
      description: "The artifact's name. Default: the file's name.",
      type: "string",
      minLength: 1,
      maxLength: ARTIFACT_NAME_MAX,
    },
    contentType: {
      description: "The media type, e.g. image/png. Default: from the name's extension.",
      type: "string",
      minLength: 1,
    },
    artifactId: { description: "Save a new version of this artifact.", type: "string", minLength: 1 },
  },
  additionalProperties: false,
};

function readDescription(pageBytes: number, sandboxed: boolean): string {
  return (
    `Read an artifact of this session, such as a tool result marked truncated or a file from an earlier turn. A text file returns up to ${pageBytes} bytes from offset, ` +
    "with nextOffset while more remains: pass it as offset to read on. An image or another file you can read is shown to you." +
    (sandboxed
      ? ` Pass path to copy the whole artifact into the sandbox instead (relative paths resolve under ${SANDBOX_WORKSPACE}), for a command to use.`
      : "")
  );
}

function readSchema(pageBytes: number, sandboxed: boolean): JsonObject {
  return {
    $schema: SCHEMA,
    type: "object",
    properties: {
      artifactId: { type: "string", minLength: 1, description: "The artifact to read, e.g. a truncated result's artifactId." },
      version: {
        description: "The version to read. Default: the latest.",
        type: "integer",
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
      },
      offset: {
        description: "The byte to start at. Default 0.",
        type: "integer",
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
      },
      length: {
        description: `How many bytes to read. Default and most: ${pageBytes}.`,
        type: "integer",
        minimum: 1,
        maximum: pageBytes,
      },
      ...(sandboxed
        ? {
            path: {
              description: "Copy the artifact to this file in the sandbox instead of reading it.",
              type: "string",
              minLength: 1,
            },
          }
        : {}),
    },
    required: ["artifactId"],
    additionalProperties: false,
  };
}

/** `save_artifact` (with `save`) and `read_artifact` (with `read`), which takes `path` with a sandbox. */
export function artifactTools(
  offer: { readonly read: boolean; readonly save: boolean; readonly sandboxed: boolean },
  options: { readonly pageBytes: number },
): EngineTool[] {
  return [
    ...(offer.save ? [{ name: SAVE_ARTIFACT_TOOL, description: SAVE_DESCRIPTION, inputSchema: SAVE_SCHEMA, target: HARNESS }] : []),
    ...(offer.read
      ? [
          {
            name: READ_ARTIFACT_TOOL,
            description: readDescription(options.pageBytes, offer.sandboxed),
            inputSchema: readSchema(options.pageBytes, offer.sandboxed),
            target: HARNESS,
          },
        ]
      : []),
  ];
}

// --- The skill tools -------------------------------------------------------------------------

/** Loads a skill's `SKILL.md`. */
export const LOAD_SKILL_TOOL = "load_skill";
/** Reads one resource file of a skill. */
export const READ_SKILL_RESOURCE_TOOL = "read_skill_resource";

/**
 * `load_skill` for the agent's skills, and `read_skill_resource` when a skill has files besides
 * `SKILL.md`. Empty for an agent without skills. Each runs in the harness.
 */
export function skillTools(skills: readonly SkillManifest[]): EngineTool[] {
  if (skills.length === 0) return [];
  const names = skills.map((skill) => skill.name).sort();
  const name: JsonObject = names.length === 1 ? { type: "string", const: names[0]! } : { type: "string", enum: names };
  const tools: EngineTool[] = [
    {
      name: LOAD_SKILL_TOOL,
      description: "Load the full instructions for a named skill. Call this before following a skill.",
      inputSchema: { $schema: SCHEMA, type: "object", properties: { name }, required: ["name"], additionalProperties: false },
      target: HARNESS,
    },
  ];
  if (skills.some((skill) => Object.keys(skill.files).some((path) => path !== SKILL_ENTRY)))
    tools.push({
      name: READ_SKILL_RESOURCE_TOOL,
      description: "Read one text resource from a skill after load_skill.",
      inputSchema: {
        $schema: SCHEMA,
        type: "object",
        properties: { name, path: { type: "string", minLength: 1 } },
        required: ["name", "path"],
        additionalProperties: false,
      },
      target: HARNESS,
    });
  return tools;
}

// --- memory ----------------------------------------------------------------------------------

/** The memory tool's name. */
export const MEMORY_TOOL = "memory";
const RUNTIME_MEMORY: EffectTarget = Object.freeze({ kind: "runtime", operation: "memory" });
const MEMORY_WRITES = ["create", "str_replace", "insert", "delete", "rename"] as const;

/** `memory`: view, and the writes when the agent may write. A `runtime` effect, operation `memory`. */
export function memoryToolOf(writes: boolean): EngineTool {
  return {
    name: MEMORY_TOOL,
    description: [
      `Read${writes ? " and edit" : ""} your persistent memory directory, ${MEMORY_ROOT}. Files there survive across sessions.`,
      "Commands:",
      "- view: show a directory listing, or a file's contents with line numbers. Params: path, optional view_range [start, end] (end -1 means to the end).",
      ...(writes
        ? [
            "- create: create a file, or replace an existing one. Params: path, file_text.",
            "- str_replace: replace text that appears exactly once in a file. Params: path, old_str, new_str (omit new_str to delete old_str).",
            "- insert: insert text after a line number (0 inserts at the top). Params: path, insert_line, insert_text.",
            "- delete: delete a file or directory. Params: path.",
            "- rename: rename or move a file or directory; never overwrites. Params: old_path, new_path.",
          ]
        : []),
      `All paths are under ${MEMORY_ROOT} and memory files end in .md.`,
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", enum: writes ? ["view", ...MEMORY_WRITES] : ["view"], description: "The operation to perform." },
        path: {
          type: "string",
          description: writes ? `Path under ${MEMORY_ROOT}. Used by view, create, str_replace, insert and delete.` : `Path under ${MEMORY_ROOT}.`,
        },
        view_range: {
          type: "array",
          items: { type: "integer" },
          minItems: 2,
          maxItems: 2,
          description: "view only: [start_line, end_line], 1-indexed; end_line -1 means to the end.",
        },
        ...(writes
          ? {
              file_text: { type: "string", description: "create only: the full file contents." },
              old_str: { type: "string", description: "str_replace only: text that appears exactly once in the file." },
              new_str: { type: "string", description: "str_replace only: the replacement text." },
              insert_line: { type: "integer", description: "insert only: insert after this line; 0 inserts at the top." },
              insert_text: { type: "string", description: "insert only: the text to insert." },
              old_path: { type: "string", description: "rename only: the current path." },
              new_path: { type: "string", description: "rename only: the new path." },
            }
          : {}),
      },
      required: ["command"],
      additionalProperties: false,
    },
    target: RUNTIME_MEMORY,
  };
}

// --- schedule_wake ---------------------------------------------------------------------------

/** The self-wake tool's name. */
export const SCHEDULE_WAKE_TOOL = "schedule_wake";
const RUNTIME_WAKE: EffectTarget = Object.freeze({ kind: "runtime", operation: "schedule_wake" });

/** `schedule_wake` (track T4): a `runtime` effect. */
export function wakeToolOf(): EngineTool {
  return {
    name: SCHEDULE_WAKE_TOOL,
    description:
      "Book this session's next turn for later, when nobody may be here to ask: give `in` (a duration such as 30m, 2h or 1d) or `at` (an RFC 3339 time with an offset), and a `note` that will be your message at that turn. A session holds one booking: a new one replaces it, and `cancel: true` removes it. Returns when it is booked for.",
    inputSchema: {
      type: "object",
      properties: {
        in: { type: "string", pattern: "^[1-9][0-9]*(s|m|h|d)$", description: "How long from now: 30m, 2h, 1d." },
        at: { type: "string", description: "An RFC 3339 time with an offset, such as 2026-11-01T09:00:00+05:30." },
        note: { type: "string", minLength: 1, description: "What to do then, in your own words: your message at that turn." },
        cancel: { type: "boolean", description: "Remove the session's booking instead." },
      },
      additionalProperties: false,
    },
    target: RUNTIME_WAKE,
  };
}

// --- triggers --------------------------------------------------------------------------------

/** The triggers tool's name (D83). */
export const TRIGGERS_TOOL = "triggers";
/** What serves a `triggers` call: the Runtime, in the call's own transaction. */
export const RUNTIME_TRIGGERS: EffectTarget = Object.freeze({ kind: "runtime", operation: "triggers" });

/**
 * `triggers` (D83): list, create and delete the triggers the calling session made, for an agent
 * whose version declares `engine.triggers`; the root agent's only. A `runtime` effect, operation
 * `triggers`; its input is `TriggerToolInputSchema`'s.
 */
export function triggersToolOf(): EngineTool {
  return {
    name: TRIGGERS_TOOL,
    description: [
      "Set up work that runs later, when nobody may be here to ask: a trigger runs its prompt as your message, on a schedule, at a time or after a delay.",
      "Commands:",
      "- list: the triggers this session made, each with its id, title, status, when and next run.",
      "- create: make a trigger, or replace the one this session made with the same id. Params: id, title (optional, a few words), exactly one of schedule (five cron fields: minute hour day-of-month month day-of-week, with an optional IANA timezone, default UTC), at (an RFC 3339 time with an offset) or in (a delay: 30m, 2h, 1d), session (this: run here, as a follow-up; own: run in a session of its own, kept across runs), and prompt (what to do then, in your own words).",
      "- delete: remove a trigger this session made. Params: id.",
      "Returns the trigger's id, status, next run and the session it runs in.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", enum: ["list", "create", "delete"], description: "The operation to perform." },
        id: {
          type: "string",
          pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
          description: "create and delete: the trigger's id, such as daily-standup: 1-64 letters, digits, '.', '_' and '-'.",
        },
        title: { type: "string", minLength: 1, maxLength: TRIGGER_TITLE_MAX, description: "create only: a few words that name it." },
        schedule: { type: "string", description: "create only: five cron fields, such as 0 9 * * 1-5 (weekdays at nine)." },
        timezone: { type: "string", description: "create only, with schedule: an IANA time zone, such as Europe/Berlin; default UTC." },
        at: { type: "string", description: "create only: one run at an RFC 3339 time with an offset, such as 2026-11-01T09:00:00+05:30." },
        in: { type: "string", pattern: TRIGGER_DELAY_PATTERN.source, description: "create only: one run after a delay: 30m, 2h, 1d." },
        session: {
          type: "string",
          enum: ["this", "own"],
          description: "create only: this runs it in this session; own runs it in a session of its own, kept across its runs.",
        },
        prompt: { type: "string", minLength: 1, description: "create only: what to do then, in your own words: your message when it runs." },
      },
      required: ["command"],
      additionalProperties: false,
    },
    target: RUNTIME_TRIGGERS,
  };
}

// --- update_plan -----------------------------------------------------------------------------

/** The plan tool's name. */
export const UPDATE_PLAN_TOOL = "update_plan";

/** `update_plan` (A2A profile v2, `progress/v1`): runs in the harness. */
export function planToolOf(): EngineTool {
  return {
    name: UPDATE_PLAN_TOOL,
    description: [
      "Keep your plan for this task: a short list of steps, each with a state, which the person or agent who asked sees while you work.",
      "Pass the whole plan each time, never only the changes: the steps in order, each with a label (a few words) and a state (pending, active, done, blocked or skipped), and optionally a note (a short fact, such as why a step is blocked).",
      `At most ${PLAN_LIMITS.steps} steps; a label is cut at ${PLAN_LIMITS.labelChars} characters and a note at ${PLAN_LIMITS.noteChars}.`,
      "Never put tool arguments, results, secrets or file contents in a label or note.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          description: `The whole plan, in order: at most ${PLAN_LIMITS.steps} steps.`,
          items: {
            type: "object",
            properties: {
              label: {
                type: "string",
                minLength: 1,
                description: `What the step does, in a few words (at most ${PLAN_LIMITS.labelChars} characters).`,
              },
              state: { type: "string", enum: [...PLAN_STEP_STATES], description: "The step's state." },
              note: { type: "string", description: `A short fact about the step (at most ${PLAN_LIMITS.noteChars} characters).` },
            },
            required: ["label", "state"],
            additionalProperties: false,
          },
        },
      },
      required: ["steps"],
      additionalProperties: false,
    },
    target: HARNESS,
  };
}

// --- request_connection ----------------------------------------------------------------------

/** The connection tool's name. */
export const REQUEST_CONNECTION_TOOL = "request_connection";
/** The most characters of the app's name and of the reason. */
export const CONNECTION_LIMITS = Object.freeze({ appChars: 80, reasonChars: 280 });

/** `request_connection` (A2A profile v2, `interactions/v1` kind `connection`): runs in the harness. */
export function connectionToolOf(): EngineTool {
  return {
    name: REQUEST_CONNECTION_TOOL,
    description: [
      "Ask the person or agent who gave you this task to connect an app you need and cannot reach, such as their GitHub, Linear or Google Drive, then wait for their answer.",
      "Give the app's name and the reason, in a sentence they can act on.",
      "It answers Connected: <app> once they connected it, so try again; or Not connected: <app>, so go on without it or say what you could not do.",
      "Use it only when a tool says the app is not connected or its credential is missing; never to ask anything else.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        app: {
          type: "string",
          minLength: 1,
          description: `The app to connect, by its name (at most ${CONNECTION_LIMITS.appChars} characters).`,
        },
        reason: {
          type: "string",
          minLength: 1,
          description: `Why you need it, in a sentence (at most ${CONNECTION_LIMITS.reasonChars} characters).`,
        },
      },
      required: ["app", "reason"],
      additionalProperties: false,
    },
    target: HARNESS,
  };
}

// --- tool_search and tool_call ---------------------------------------------------------------

/** Finds deferred tools by a query (BM25 over their names and descriptions). */
export const TOOL_SEARCH_TOOL = "tool_search";
/** Runs a deferred tool by name, as a call of that tool. */
export const TOOL_CALL_TOOL = "tool_call";

async function runsInHarness(): Promise<never> {
  throw new ToolError(
    "tools.runtime-only",
    "tool_search and tool_call run in Nylorun's harness. Connect the agent to a Runtime to use them.",
  );
}

/**
 * `tool_search` (ours, `harness`) and `tool_call`, as our engine gives them to an agent with
 * deferred tools. `tool_call` makes the effect of the tool it names; it is never one itself.
 */
export function deferredToolsTools(config: { readonly toolSearchDefaultLimit: number; readonly toolSearchMaxLimit: number }): readonly EngineTool[] {
  const search = tool({
    name: TOOL_SEARCH_TOOL,
    description:
      "Search the tools not in your tool list by name and description. Returns the best matches, each with its name, description and inputSchema. Run one with tool_call.",
    inputSchema: z.object({
      query: z.string().min(1).describe("Words of what the tool does, or of its name."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(config.toolSearchMaxLimit)
        .optional()
        .describe(`How many tools to return. Default ${config.toolSearchDefaultLimit}.`),
    }),
    effects: "read",
    execute: runsInHarness,
  });
  const call = tool({
    name: TOOL_CALL_TOOL,
    description:
      "Run a tool tool_search found, by its name. arguments must match that tool's inputSchema; the result is the tool's own.",
    inputSchema: z.object({
      name: z.string().min(1).describe("The tool's name, as tool_search returned it."),
      arguments: z.record(z.string(), z.unknown()).optional().describe("The tool's arguments, matching its inputSchema. Default {}."),
    }),
    effects: "write",
    execute: runsInHarness,
  });
  return [search, call].map((item, index): EngineTool => {
    const schemas = normalizedSchemasFor(item);
    const manifest = {
      name: item.name,
      ...(item.description === undefined ? {} : { description: item.description }),
      inputSchema: schemas.inputSchema.jsonSchema,
    };
    return index === 0 ? { ...manifest, target: HARNESS } : manifest;
  });
}

function definedOf<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}
