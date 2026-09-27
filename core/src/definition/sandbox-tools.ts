import { z } from "zod";
import type { ToolDefinition } from "../types/tool.js";
import { tool } from "./helpers.js";
import { ToolError } from "./tool-error.js";
import { SANDBOX_WORKSPACE } from "../utils/sandbox.js";

const PATH_NOTE = `Relative paths resolve under ${SANDBOX_WORKSPACE}.`;

/** Instructions attached to every sandbox capability. */
export const SANDBOX_INSTRUCTIONS =
  `You have an isolated Linux sandbox with a persistent working directory at ${SANDBOX_WORKSPACE}. ` +
  "Use bash to run commands, read/write/edit to work with files, and grep/glob to search. " +
  "Network egress is limited by policy; a failed download usually means the host is not allowed.";

/**
 * Stub implementation for the developer process. The Runtime executes sandbox tools;
 * reaching this means the agent ran without a Nylorun Runtime.
 */
async function runtimeOnly(): Promise<never> {
  throw new ToolError(
    "sandbox.runtime-only",
    "Sandbox tools run in the Nylorun Runtime. Connect the agent to a Runtime (npx nylorun up, then npm run dev) to use them."
  );
}

/** The six built-in sandbox tools. Schemas are part of the hashed manifest; change them deliberately. */
export function createSandboxTools(): readonly ToolDefinition[] {
  return Object.freeze([
    tool({
      name: "bash",
      description:
        `Run a bash command in the sandbox. The working directory is ${SANDBOX_WORKSPACE}. ` +
        "Returns exitCode, stdout and stderr; a non-zero exit code is a normal result, not an error. " +
        "Long output is truncated in the middle.",
      inputSchema: z.object({
        command: z.string().min(1).describe("The command line to run with bash."),
        timeout: z
          .number()
          .int()
          .min(1)
          .max(600)
          .optional()
          .describe("Seconds before the command is killed. Default 120, maximum 600."),
      }),
      effects: "write",
      execute: runtimeOnly,
    }),
    tool({
      name: "read",
      description:
        `Read a text file from the sandbox. ${PATH_NOTE} Returns numbered lines. ` +
        "Use offset and limit to page through large files.",
      inputSchema: z.object({
        path: z.string().min(1),
        offset: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("First line to return, 1-based."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .optional()
          .describe("Maximum number of lines. Default 2000."),
      }),
      effects: "read",
      execute: runtimeOnly,
    }),
    tool({
      name: "write",
      description: `Create or overwrite a text file in the sandbox. ${PATH_NOTE} Parent directories are created.`,
      inputSchema: z.object({
        path: z.string().min(1),
        content: z.string(),
      }),
      effects: "write",
      execute: runtimeOnly,
    }),
    tool({
      name: "edit",
      description:
        `Replace text in a sandbox file. ${PATH_NOTE} old_string must match exactly and be unique ` +
        "unless replace_all is true.",
      inputSchema: z.object({
        path: z.string().min(1),
        old_string: z.string().min(1),
        new_string: z.string(),
        replace_all: z.boolean().optional(),
      }),
      effects: "write",
      execute: runtimeOnly,
    }),
    tool({
      name: "grep",
      description:
        `Search file contents in the sandbox with an extended regular expression. ${PATH_NOTE} ` +
        "Returns matching lines as path:line:text.",
      inputSchema: z.object({
        pattern: z.string().min(1),
        path: z.string().min(1).optional().describe(`Directory or file to search. Default ${SANDBOX_WORKSPACE}.`),
        glob: z.string().min(1).optional().describe("Only search files whose name matches, e.g. \"*.py\"."),
        ignore_case: z.boolean().optional(),
        max_results: z.number().int().min(1).max(1000).optional().describe("Default 200."),
      }),
      effects: "read",
      execute: runtimeOnly,
    }),
    tool({
      name: "glob",
      description:
        `Find files in the sandbox by glob pattern, e.g. "**/*.csv". ${PATH_NOTE} Returns matching paths.`,
      inputSchema: z.object({
        pattern: z.string().min(1),
        path: z.string().min(1).optional().describe(`Directory to search. Default ${SANDBOX_WORKSPACE}.`),
      }),
      effects: "read",
      execute: runtimeOnly,
    }),
  ]);
}
