import { createContext, Script } from "node:vm";
import { z } from "zod";
import { isToolError, type JsonValue, type ToolDefinition, type ToolExecutionContext, type ToolOutcome, type ToolRunResult } from "@nylorun/agents/define";

const DEFAULT_TIMEOUT_MS = 5_000;
const SYNC_TIMEOUT_MS = 1_000;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export class ToolCallError extends Error {
  readonly toolName: string;

  constructor(toolName: string, message: string) {
    super(message);
    this.name = "ToolCallError";
    this.toolName = toolName;
  }
}

export class CodeRunError extends Error {
  readonly logs: readonly string[];

  constructor(message: string, logs: readonly string[] = []) {
    super(message);
    this.name = "CodeRunError";
    this.logs = logs;
  }
}

export type CodeModeCall = Readonly<{
  name: string;
  args: JsonValue;
  output?: JsonValue;
  error?: string;
}>;

export type CodeModeResult = Readonly<{
  logs: readonly string[];
  result?: JsonValue;
  calls: readonly CodeModeCall[];
}>;

/** node:vm separates globals; it is not a security sandbox. */
export async function runCodeProgram(
  code: string,
  roster: readonly ToolDefinition[],
  context: ToolExecutionContext,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CodeModeResult> {
  const logs: string[] = [];
  const calls: CodeModeCall[] = [];
  const sandbox = createContext({
    tools: createBindings(roster, context, calls),
    ToolCallError,
    console: {
      log(...args: unknown[]) {
        logs.push(args.map(formatLog).join(" "));
      },
    },
    Promise,
    JSON,
    Math,
    Date,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Map,
    Set,
    Error,
    TypeError,
    RangeError,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    undefined,
  });

  let pending: unknown;
  try {
    pending = new Script(`"use strict"; (async () => {\n${code}\n})()`, {
      filename: "run_code.js",
    }).runInContext(sandbox, { timeout: SYNC_TIMEOUT_MS });
  } catch (error) {
    throw new CodeRunError(messageOf(error), logs);
  }

  let value: unknown;
  try {
    value = await withBudget(
      Promise.resolve(pending),
      context.signal,
      timeoutMs,
    );
  } catch (error) {
    if (error instanceof ToolCallError) {
      throw new CodeRunError(`${error.toolName}: ${error.message}`, logs);
    }
    throw new CodeRunError(messageOf(error), logs);
  }

  return {
    logs,
    ...(value === undefined ? {} : { result: asJsonValue(value, logs) }),
    calls,
  };
}

export function renderToolsSdk(roster: readonly ToolDefinition[]): string {
  const bindings = [...roster]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((tool) => {
      const comment = tool.description
        ? `  /** ${escapeJsdoc(tool.description)} */\n`
        : "";
      return `${comment}  ${bindingKey(tool.name)}: (args: ${argsType(tool)}) => Promise<unknown>;`;
    })
    .join("\n");
  return `declare const tools: {\n${bindings}\n};`;
}

function createBindings(
  roster: readonly ToolDefinition[],
  context: ToolExecutionContext,
  calls: CodeModeCall[],
) {
  const bindings = Object.create(null) as Record<
    string,
    (args: unknown) => Promise<unknown>
  >;
  for (const tool of roster) {
    bindings[tool.name] = async (args: unknown) => {
      const parsed = zodInputSchema(tool).safeParse(args);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map(
            (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
          )
          .join("; ");
        throw new ToolCallError(tool.name, issues);
      }
      let outcome: ToolOutcome;
      try {
        outcome = await invokeTool(tool, parsed.data, context);
      } catch (error) {
        throw new ToolCallError(tool.name, messageOf(error));
      }
      const recordedArgs = asJsonValue(parsed.data);
      if (outcome.kind === "completed") {
        calls.push({
          name: tool.name,
          args: recordedArgs,
          output: outcome.output,
        });
        return outcome.output;
      }
      if (outcome.kind === "failed") {
        calls.push({
          name: tool.name,
          args: recordedArgs,
          error: outcome.message,
        });
        throw new ToolCallError(tool.name, outcome.message);
      }
      if (outcome.kind === "denied") {
        calls.push({
          name: tool.name,
          args: recordedArgs,
          error: outcome.reason,
        });
        throw new ToolCallError(tool.name, outcome.reason);
      }
      throw new ToolCallError(
        tool.name,
        "This tool cannot run inside run_code. Call it directly instead.",
      );
    };
  }
  return new Proxy(Object.freeze(bindings), {
    get(target, property) {
      if (typeof property === "string" && Object.hasOwn(target, property))
        return target[property];
      if (typeof property === "string") {
        return async () => {
          throw new ToolCallError(property, `Unknown tool '${property}'.`);
        };
      }
      return undefined;
    },
  });
}

/** Resolve execute|run, normalize plain returns, and map ToolError to failed. */
export async function invokeTool(
  tool: ToolDefinition,
  args: unknown,
  context: ToolExecutionContext,
): Promise<ToolOutcome> {
  const run = tool.execute ?? tool.run;
  if (typeof run !== "function") {
    throw new ToolCallError(
      tool.name,
      `Tool '${tool.name}' has no execute() or run().`,
    );
  }
  try {
    return normalizeToolOutcome(await run(args as never, context));
  } catch (error) {
    if (isToolError(error)) {
      return { kind: "failed", code: error.code, message: error.message };
    }
    throw error;
  }
}

export function normalizeToolOutcome(raw: ToolRunResult): ToolOutcome {
  if (raw && typeof raw === "object" && "kind" in raw) {
    const kind = (raw as { kind: string }).kind;
    if (
      kind === "completed" ||
      kind === "denied" ||
      kind === "failed" ||
      kind === "interaction-required" ||
      kind === "deferred"
    ) {
      return raw as ToolOutcome;
    }
  }
  return { kind: "completed", output: raw as JsonValue };
}

function argsType(tool: ToolDefinition): string {
  try {
    return jsonSchemaToTs(
      z.toJSONSchema(zodInputSchema(tool), { target: "draft-07" }),
    );
  } catch {
    return "Record<string, unknown>";
  }
}

function zodInputSchema(tool: ToolDefinition): z.ZodType {
  if (tool.inputSchema instanceof z.ZodType) return tool.inputSchema;
  throw new Error(`PTC tool '${tool.name}' must use a Zod inputSchema`);
}

function jsonSchemaToTs(schema: unknown): string {
  if (schema === null || typeof schema !== "object") return "unknown";
  const node = schema as Record<string, unknown>;
  if (Object.hasOwn(node, "const")) return JSON.stringify(node.const);
  if (Array.isArray(node.enum) && node.enum.every(isJsonLiteral)) {
    return (
      node.enum.map((value) => JSON.stringify(value)).join(" | ") || "unknown"
    );
  }
  if (Array.isArray(node.anyOf) || Array.isArray(node.oneOf)) {
    const variants = (
      Array.isArray(node.anyOf) ? node.anyOf : node.oneOf
    ) as unknown[];
    return variants.map(jsonSchemaToTs).join(" | ") || "unknown";
  }
  if (node.type === "string") return "string";
  if (node.type === "number" || node.type === "integer") return "number";
  if (node.type === "boolean") return "boolean";
  if (node.type === "null") return "null";
  if (node.type === "array")
    return `readonly (${jsonSchemaToTs(node.items)})[]`;
  if (node.type === "object" || node.properties !== undefined) {
    const properties =
      node.properties !== null &&
      typeof node.properties === "object" &&
      !Array.isArray(node.properties)
        ? (node.properties as Record<string, unknown>)
        : {};
    const required = new Set(Array.isArray(node.required) ? node.required : []);
    const fields = Object.entries(properties).map(([key, value]) => {
      const optional = required.has(key) ? "" : "?";
      return `${bindingKey(key)}${optional}: ${jsonSchemaToTs(value)}`;
    });
    if (fields.length === 0) {
      return node.additionalProperties === false
        ? "Record<string, never>"
        : "Record<string, unknown>";
    }
    return `{ ${fields.join("; ")} }`;
  }
  return "unknown";
}

function bindingKey(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

function escapeJsdoc(value: string): string {
  return value.replaceAll("*/", "*\\/");
}

function asJsonValue(value: unknown, logs: readonly string[] = []): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch (error) {
    throw new CodeRunError(messageOf(error), logs);
  }
}

async function withBudget<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  if (signal.aborted) throw new Error("run_code aborted.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = new Promise<never>((_, reject) => {
    const onAbort = () => reject(new Error("run_code aborted."));
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(
      () => reject(new Error("run_code timed out.")),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, abort]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function formatLog(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isJsonLiteral(
  value: unknown,
): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
