/**
 * Our engine's sandbox tools (protocol 15): `bash`, `read`, `write`, `edit`, `grep` and `glob`,
 * offered to every agent of a session with a sandbox (`turn.start.environment.sandbox`), with the
 * note on the sandbox that goes with them. Our engine names, describes and instructs them; each
 * call is a `sandbox` effect named by its operation, which the host runs in the session's sandbox
 * (`executors.tool`), so the record keeps `environment.exec` and the sandbox's network policy
 * holds.
 *
 * Their limits are the harness's configuration (`SandboxToolLimits`): the schema maxima and
 * defaults the model reads here, and the same numbers where the host runs the call.
 */
import type { EffectTarget } from "@nylorun/core/harness-api";
import type { JsonObject } from "@nylorun/core/define";
import type { DurableSessionTool } from "../run/durable.js";

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

function definedOf<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>;
}

const SANDBOX: EffectTarget = Object.freeze({ kind: "sandbox" });
const SCHEMA = "http://json-schema.org/draft-07/schema#";

/** The note on the sandbox the model reads with the sandbox tools. */
export function sandboxInstructions(workspace: string): string {
  return (
    `You have an isolated Linux sandbox with a persistent working directory at ${workspace}. ` +
    "Use bash to run commands, read/write/edit to work with files, and grep/glob to search. " +
    "Network egress is limited by policy; a failed download usually means the host is not allowed."
  );
}

const object = (properties: JsonObject, required: readonly string[]): JsonObject => ({
  $schema: SCHEMA,
  type: "object",
  properties,
  required: [...required],
  additionalProperties: false,
});
const path = { type: "string", minLength: 1 };

/**
 * The six sandbox tools, in the order the model reads them, with `workspace` named in their text
 * and `limits` in their schemas. Each is a `sandbox` effect named by its operation.
 */
export function sandboxTools(limits: SandboxToolLimits, workspace: string): DurableSessionTool[] {
  const relative = `Relative paths resolve under ${workspace}.`;
  const tools: Omit<DurableSessionTool, "target">[] = [
    {
      name: "bash",
      description:
        `Run a bash command in the sandbox. The working directory is ${workspace}. ` +
        "Returns exitCode, stdout and stderr; a non-zero exit code is a normal result, not an error. " +
        "Long output is truncated in the middle.",
      inputSchema: object(
        {
          command: {
            type: "string",
            minLength: 1,
            description: "The command line to run with bash.",
          },
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
          path,
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
      inputSchema: object({ path, content: { type: "string" } }, ["path", "content"]),
    },
    {
      name: "edit",
      description:
        `Replace text in a sandbox file. ${relative} old_string must match exactly and be unique ` +
        "unless replace_all is true.",
      inputSchema: object(
        {
          path,
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
          path: { description: `Directory or file to search. Default ${workspace}.`, ...path },
          glob: {
            description: 'Only search files whose name matches, e.g. "*.py".',
            ...path,
          },
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
          path: { description: `Directory to search. Default ${workspace}.`, ...path },
        },
        ["pattern"],
      ),
    },
  ];
  return tools.map((tool) => ({ ...tool, target: SANDBOX }));
}
