/**
 * HTTP tools (R2 M3): a tool the manifest describes as one HTTP request, which the Runtime makes
 * itself through its Tool Gate. No developer code runs for it: the tool value carries its target
 * (`http`) and static approval into the manifest, and its `execute` only says where it runs.
 */
import type { ApprovalMode, HttpToolMethod, HttpToolTarget, ToolManifest } from "../types/manifest.js";
import type { JsonObject } from "../types/shared.js";
import type { ToolDefinition, ToolInputSchema, ToolOutputSchema, ToolSchemaSource } from "../types/tool.js";
import { HarnessError } from "../errors.js";
import { ToolError } from "./tool-error.js";
import { prepareTool } from "./schema.js";
import { schemaFromJSON } from "./schema-json.js";

type AnyTool = ToolDefinition<any, any, any>;

/** Survives duplicate installed copies of core, like the delegate brand. */
const HTTP = Symbol.for("@nylorun/core/http-tool");

export const HTTP_TOOL_METHODS = ["POST", "PUT", "PATCH"] as const satisfies readonly HttpToolMethod[];
export const APPROVAL_MODES = ["never", "always"] as const satisfies readonly ApprovalMode[];
/** How long a service may take to answer when the tool sets no `timeoutMs`. */
export const HTTP_TOOL_DEFAULT_TIMEOUT_MS = 60_000;
/** The longest `timeoutMs` a tool may set. */
export const HTTP_TOOL_MAX_TIMEOUT_MS = 300_000;

/** What an HTTP tool puts in its manifest entry besides its name and schemas. */
export interface HttpTool {
  readonly http: HttpToolTarget;
  readonly approval?: ApprovalMode;
}

export interface HttpToolOptions<
  InputSchema extends ToolInputSchema | JsonObject = ToolInputSchema,
  OutputSchema extends ToolOutputSchema | JsonObject | undefined = undefined,
> extends HttpToolTarget {
  readonly name: string;
  readonly description?: string;
  /** A Zod schema, a Standard Schema, a `defineSchema()` contract, or a JSON Schema object. */
  readonly input: InputSchema;
  /** Checked against the answer; a mismatch is a tool error the model sees. */
  readonly output?: OutputSchema;
  /** `always`: each call waits for approval. Default `never`. */
  readonly approval?: ApprovalMode;
}

/**
 * A tool the Runtime runs as an HTTP request: it sends the input as JSON to `url` and gives
 * the model the answer. Use it in `.tools(...)` like any tool; it has no implementation.
 */
export function http<
  InputSchema extends ToolInputSchema | JsonObject,
  OutputSchema extends ToolOutputSchema | JsonObject | undefined = undefined,
>(options: HttpToolOptions<InputSchema, OutputSchema>): AnyTool {
  const { name, description, input, output, approval, url, method, credential, timeoutMs } = options;
  const target: HttpToolTarget = {
    url,
    ...(method === undefined ? {} : { method }),
    ...(credential === undefined ? {} : { credential }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
  const issue = httpTargetIssue(target) ?? approvalIssue(approval);
  if (issue) throw new HarnessError("tool.invalid", `HTTP tool '${name}': ${issue}`);
  return prepareTool(
    withHttpTarget(
      {
        name,
        ...(description === undefined ? {} : { description }),
        inputSchema: schemaSource(input),
        ...(output === undefined ? {} : { outputSchema: schemaSource(output) }),
      },
      { http: target, ...(approval === undefined ? {} : { approval }) },
    ),
  );
}

/** Rebuilds an HTTP tool from its manifest entry. */
export function httpToolFromManifest(declared: ToolManifest & { readonly http: HttpToolTarget }): AnyTool {
  return withHttpTarget(
    {
      name: declared.name,
      ...(declared.description === undefined ? {} : { description: declared.description }),
      inputSchema: schemaFromJSON(declared.inputSchema),
      ...(declared.outputSchema === undefined ? {} : { outputSchema: schemaFromJSON(declared.outputSchema) }),
    },
    { http: declared.http, ...(declared.approval === undefined ? {} : { approval: declared.approval }) },
  );
}

/**
 * Marks `tool` as an HTTP tool. A host gives its own `execute` (the Runtime's engine routes the
 * call to its Tool Gate); without one, calling it explains that only the Runtime runs it.
 * `approval: "always"` makes each call wait for approval.
 */
export function withHttpTarget(
  tool: Omit<AnyTool, "execute"> & Pick<Partial<AnyTool>, "execute">,
  target: HttpTool,
): AnyTool {
  const definition: AnyTool = {
    ...tool,
    execute: tool.execute ?? runtimeOnly,
    ...(target.approval === "always" ? { approval: () => true } : {}),
  };
  Object.defineProperty(definition, HTTP, {
    value: Object.freeze({ http: Object.freeze({ ...target.http }), ...(target.approval ? { approval: target.approval } : {}) }),
    enumerable: false,
  });
  return Object.freeze(definition);
}

/** The HTTP target behind a tool definition, or behind the bound snapshot of one. */
export function httpToolOf(tool: unknown): HttpTool | undefined {
  if (tool === null || typeof tool !== "object") return undefined;
  const value = tool as Record<symbol, HttpTool | undefined> & { source?: unknown };
  return value[HTTP] ?? (value.source === tool ? undefined : httpToolOf(value.source));
}

/** Why `target` is not a valid HTTP tool target, or undefined. */
export function httpTargetIssue(target: HttpToolTarget): string | undefined {
  const url = httpUrlIssue(target.url);
  if (url) return url;
  if (target.method !== undefined && !(HTTP_TOOL_METHODS as readonly string[]).includes(target.method))
    return `method must be one of ${HTTP_TOOL_METHODS.join(", ")}`;
  if (target.credential !== undefined && (typeof target.credential !== "string" || target.credential === ""))
    return "credential must be a non-empty name";
  if (
    target.timeoutMs !== undefined &&
    (!Number.isInteger(target.timeoutMs) || target.timeoutMs <= 0 || target.timeoutMs > HTTP_TOOL_MAX_TIMEOUT_MS)
  )
    return `timeoutMs must be a positive integer of at most ${HTTP_TOOL_MAX_TIMEOUT_MS}`;
  return undefined;
}

/** Why `url` is not an HTTP tool's URL, or undefined. */
export function httpUrlIssue(url: unknown): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(String(url));
  } catch {
    return "url must be an absolute http or https URL";
  }
  if (typeof url !== "string" || (parsed.protocol !== "http:" && parsed.protocol !== "https:"))
    return "url must be an absolute http or https URL";
  if (parsed.username !== "" || parsed.password !== "")
    return "url must not carry credentials; name a vault credential with `credential`";
  if (parsed.hash !== "") return "url must not have a fragment";
  return undefined;
}

function approvalIssue(approval: unknown): string | undefined {
  return approval === undefined || (APPROVAL_MODES as readonly unknown[]).includes(approval)
    ? undefined
    : `approval must be one of ${APPROVAL_MODES.join(", ")}`;
}

async function runtimeOnly(): Promise<never> {
  throw new ToolError("http.runtime-only", "HTTP tools are run by the Nylorun Runtime, not in this process");
}

/** A schema source as `tool()` takes it, or a JSON Schema object. */
function schemaSource(value: ToolSchemaSource | JsonObject): ToolSchemaSource {
  const candidate = value as Record<string, unknown>;
  const authored =
    typeof candidate.validate === "function" || "~standard" in candidate || "_zod" in candidate;
  return authored ? (value as ToolSchemaSource) : schemaFromJSON(value as JsonObject);
}
