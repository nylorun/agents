import { tool, type ToolDefinition } from "@nylorun/agents/define";
import { z } from "zod";
import { CodeRunError, renderToolsSdk, runCodeProgram } from "./executor.js";
import { TOOLS_CATALOG } from "../shared/tools/index.js";
import { loadToolsFromDirectory } from "../shared/tools/load.js";

export { renderToolsSdk, ToolCallError } from "./executor.js";

export const CODE_MODE_RULE =
  "Only `run_code` may be called directly. Call every other tool from inside a `run_code` program as `await tools.name(args)`.";

export const CODE_MODE_USAGE = [
  "## Writing code for run_code",
  "",
  "`run_code` takes two required arguments: `code` — the body of an async JavaScript function (no `enum`, namespaces, or type annotations; the SDK types are for reference) — and `description`, a short summary of what the program does. Inside the program:",
  "Write top-level await and return statements. Do not wrap the body in a function declaration or an async arrow function: an uninvoked function does no work. Combine a related calculation/conversion/time request into one run_code call.",
  "",
  '- Call tools as `await tools.name(args)` — quoted access for exotic names: `tools["my-tool"](args)`. Every call resolves to the tool\'s canonical JSON value. Tool arguments must be lossless JSON.',
  "- A FAILED tool call rejects with `ToolCallError`, whose `toolName` identifies the failed tool and whose `message` is human-readable — `try/catch` it to handle and continue.",
  "- Independent read-only calls MAY overlap under `Promise.all`. Sequence dependent work with `await`.",
  "- Emit results with `return` and/or `console.log(...)`. Read each tool's described result fields; an object containing a number is not itself a number. ONLY what you print or return comes back to you — intermediate tool results never enter the conversation, so extract just what you need.",
  "",
  "The available tools:",
].join("\n");

export type CodeModeSource = { readonly directory: string };

export type CodeMode = {
  readonly instructions: readonly string[];
  readonly tools: readonly ToolDefinition[];
};

/** The catalog as a generated SDK in the instructions, and `run_code` as the one tool. */
export async function codeMode(
  source: CodeModeSource = { directory: TOOLS_CATALOG },
): Promise<CodeMode> {
  const roster = await loadToolsFromDirectory(source.directory);
  if (roster.length === 0) return { instructions: [], tools: [] };

  return {
    instructions: [CODE_MODE_RULE, CODE_MODE_USAGE, renderToolsSdk(roster)],
    tools: [runCodeTool(roster)],
  };
}

function runCodeTool(roster: readonly ToolDefinition[]) {
  return tool({
    name: "run_code",
    description:
      "Execute a JavaScript program against the available tools. Pass the body of an async function as `code`. Call tools as `await tools.name(args)`. Only printed lines and the return value come back.",
    inputSchema: z.object({
      code: z.string().min(1).max(8_000),
      description: z.string().min(1).max(200),
    }),
    async execute({ code }, context) {
      try {
        return {
          kind: "completed" as const,
          output: await runCodeProgram(code, roster, context),
        };
      } catch (error) {
        if (error instanceof CodeRunError) {
          return {
            kind: "failed" as const,
            code: "code_run_failed",
            message: error.logs.length
              ? `${error.message}\nCaptured output:\n${error.logs.join("\n")}`
              : error.message,
          };
        }
        return {
          kind: "failed" as const,
          code: "code_run_failed",
          message: error instanceof Error ? error.message : "run_code failed.",
        };
      }
    },
  });
}
