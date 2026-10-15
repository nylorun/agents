/**
 * HTTP tools (R2 M3): a tool the manifest describes as one HTTP request, which the Runtime makes
 * itself through its Tool Gate. No developer code runs for it: the tool value carries its target
 * (`http`) into the manifest, and its `execute` only says where it runs. Whether a call waits for
 * a person is the Tenant's tool policy, decided at the Tool Gate (R5 step 2), never the tool's.
 * An HTTP tool is also a flow stage. `http({ url })` without a name and an input is a bare
 * target, a Loop's HTTP verifier: its manifest form is itself, `{ http: { url, … } }`.
 *
 * How a call's input becomes the request (`httpToolRequest`) is decided here, so every Runtime
 * and every check agree: the fields the URL's path names as `{field}` fill it, percent-encoded;
 * the rest are the JSON body for `POST`, `PUT` and `PATCH`, and the query string for `GET` and
 * `DELETE`, which send no body.
 */
import type { ApprovalMode, HttpToolMethod, HttpToolTarget, ToolManifest } from "../types/manifest.js";
import { APPROVAL_REMOVED } from "./approval.js";
import type { JsonObject } from "../types/shared.js";
import type { ToolDefinition, ToolInputSchema, ToolOutputSchema, ToolSchemaSource } from "../types/tool.js";
import { HarnessError } from "../errors.js";
import { ToolError } from "./tool-error.js";
import { normalizedSchemasFor, prepareTool } from "./schema.js";
import { schemaFromJSON } from "./schema-json.js";

type AnyTool = ToolDefinition<any, any, any>;

/** Survives duplicate installed copies of core, like the delegate brand. */
const HTTP = Symbol.for("@nylorun/core/http-tool");
const TARGET = Symbol.for("@nylorun/core/http-target");

export const HTTP_TOOL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const satisfies readonly HttpToolMethod[];
/** The methods that send the input as a JSON body; the others send it as the query string. */
export const HTTP_BODY_METHODS = ["POST", "PUT", "PATCH"] as const satisfies readonly HttpToolMethod[];
export const APPROVAL_MODES = ["never", "always"] as const satisfies readonly ApprovalMode[];
/** How long a service may take to answer when the tool sets no `timeoutMs`. */
export const HTTP_TOOL_DEFAULT_TIMEOUT_MS = 60_000;
/** The longest `timeoutMs` a tool may set. */
export const HTTP_TOOL_MAX_TIMEOUT_MS = 300_000;

/** What an HTTP tool puts in its manifest entry besides its name and schemas. */
export interface HttpTool {
  readonly http: HttpToolTarget;
  /**
   * @deprecated A pinned manifest's `approval`, from before R5 step 2: kept so the rebuilt
   * definition hashes as pinned, and held by the Tool Gate. Nothing asks for it here, and
   * `http()` refuses it.
   */
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
}

/** A bare HTTP target: a Loop's HTTP verifier, `.loop(body, { verify: http({ url }), max })`. */
export interface HttpTarget {
  readonly http: HttpToolTarget;
}

/**
 * A tool the Runtime runs as an HTTP request to `url` with `method` (default `POST`): the input
 * fields the URL's path names as `{field}` fill it, and the rest are the JSON body (`POST`, `PUT`,
 * `PATCH`) or the query string (`GET`, `DELETE`). The model gets the answer. Use it in
 * `.tools(...)` like any tool, or as a flow stage; it has no implementation.
 */
export function http<
  InputSchema extends ToolInputSchema | JsonObject,
  OutputSchema extends ToolOutputSchema | JsonObject | undefined = undefined,
>(options: HttpToolOptions<InputSchema, OutputSchema>): AnyTool;
/**
 * A Loop's HTTP verifier: the Runtime POSTs `{ input, output, iteration }` to `url` and reads
 * the answer as a verdict, `{ pass: boolean, feedback?: string }`.
 */
export function http(target: HttpToolTarget): HttpTarget;
export function http(options: HttpToolOptions<any, any> | HttpToolTarget): AnyTool | HttpTarget {
  if (!("name" in options) && !("input" in options)) return httpTarget(options);
  const { name, description, input, output } = options as HttpToolOptions<any, any>;
  const target = targetOf(options);
  const issue =
    (input === undefined ? "input is required" : undefined) ??
    httpTargetIssue(target) ??
    ("approval" in options ? APPROVAL_REMOVED : undefined);
  if (issue) throw new HarnessError("tool.invalid", `HTTP tool '${name}': ${issue}`);
  const tool = prepareTool(
    withHttpTarget(
      {
        name,
        ...(description === undefined ? {} : { description }),
        inputSchema: schemaSource(input),
        ...(output === undefined ? {} : { outputSchema: schemaSource(output) }),
      },
      { http: target },
    ),
  );
  const parameters = httpInputIssue(target, normalizedSchemasFor(tool).inputSchema.jsonSchema);
  if (parameters) throw new HarnessError("tool.invalid", `HTTP tool '${name}': ${parameters}`);
  return tool;
}

function targetOf({ url, method, credential, timeoutMs }: HttpToolTarget): HttpToolTarget {
  return {
    url,
    ...(method === undefined ? {} : { method }),
    ...(credential === undefined ? {} : { credential }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

function httpTarget(options: HttpToolTarget): HttpTarget {
  const fields = ["url", "method", "credential", "timeoutMs"];
  const unknown = Object.keys(options).filter((key) => !fields.includes(key));
  if (unknown.length > 0)
    throw new HarnessError(
      "configuration.invalid",
      `HTTP verifier: unknown option${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}; an HTTP tool needs a name and an input`,
    );
  const target = targetOf(options);
  const issue = httpTargetIssue(target) ?? httpVerifierIssue(target);
  if (issue) throw new HarnessError("configuration.invalid", `HTTP verifier: ${issue}`);
  const value = { http: Object.freeze(target) };
  Object.defineProperty(value, TARGET, { value: true, enumerable: false });
  return Object.freeze(value);
}

/** True for a bare HTTP target made by `http({ url })`. */
export function isHttpTarget(value: unknown): value is HttpTarget {
  return !!value && typeof value === "object" && (value as Record<symbol, unknown>)[TARGET] === true;
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
 */
export function withHttpTarget(
  tool: Omit<AnyTool, "execute"> & Pick<Partial<AnyTool>, "execute">,
  target: HttpTool,
): AnyTool {
  const definition: AnyTool = {
    ...tool,
    execute: tool.execute ?? runtimeOnly,
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
  const url = httpUrlIssue(target.url) ?? httpUrlTemplateIssue(target.url);
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

const PLACEHOLDER = /\{([^{}]*)\}/g;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The input fields an HTTP target's URL names in its path as `{field}`, in order. */
export function httpPathParameters(url: string): string[] {
  return [...url.matchAll(PLACEHOLDER)].map((match) => match[1]!);
}

/**
 * Why the `{field}` parameters of an absolute http(s) `url` are malformed, or undefined: each is
 * a field name, named once, in the path (never the host or the query string).
 */
export function httpUrlTemplateIssue(url: string): string | undefined {
  if (!/[{}]/.test(url)) return undefined;
  if (/[{}]/.test(url.replace(PLACEHOLDER, ""))) return "url has an unmatched { or }";
  const scheme = url.indexOf("://");
  if (scheme === -1) return "url must be an absolute http or https URL";
  const authority = scheme + 3;
  const query = url.indexOf("?", authority);
  const end = query === -1 ? url.length : query;
  const path = url.indexOf("/", authority);
  const seen = new Set<string>();
  for (const match of url.matchAll(PLACEHOLDER)) {
    const name = match[1]!;
    if (path === -1 || match.index < path || match.index >= end)
      return "url may name input fields as {field} only in its path";
    if (!FIELD_NAME.test(name)) return `url parameter {${name}} must be an input field name`;
    if (seen.has(name)) return `url names {${name}} twice`;
    seen.add(name);
  }
  return undefined;
}

/**
 * Why `target` cannot be a Loop's HTTP verifier, or undefined: the Runtime sends a verifier
 * `{ input, output, iteration }` as a JSON body, so it takes a body method and no URL parameters.
 */
export function httpVerifierIssue(target: HttpToolTarget): string | undefined {
  if (target.method !== undefined && !(HTTP_BODY_METHODS as readonly string[]).includes(target.method))
    return `an HTTP verifier is sent a JSON body: method must be one of ${HTTP_BODY_METHODS.join(", ")}`;
  if (httpPathParameters(target.url).length > 0) return "an HTTP verifier's url takes no {field} parameters";
  return undefined;
}

/**
 * Why an HTTP tool's `inputSchema` does not fit its target, or undefined. Each `{field}` its URL
 * names is a required property of the input, and not an object or an array, so the model always
 * has one value to put there. For `GET` and `DELETE`, which send the other fields as the query
 * string, no field is an object, and none is a query parameter the URL already fixes.
 */
export function httpInputIssue(target: HttpToolTarget, inputSchema: JsonObject | undefined): string | undefined {
  // A malformed URL reports its own issue.
  if (inputSchema === undefined || httpUrlTemplateIssue(target.url)) return undefined;
  const properties = (
    inputSchema.properties && typeof inputSchema.properties === "object" ? inputSchema.properties : {}
  ) as Record<string, unknown>;
  const required = Array.isArray(inputSchema.required) ? inputSchema.required : [];
  const names = httpPathParameters(target.url);
  for (const name of names) {
    if (!Object.hasOwn(properties, name))
      return `url names {${name}}, which is not a property of the input schema`;
    if (!required.includes(name)) return `url names {${name}}, which the input schema must list as required`;
    if (typesOf(properties[name]).some((type) => type === "object" || type === "array"))
      return `url names {${name}}, which must be a string, a number or a boolean`;
  }
  if ((HTTP_BODY_METHODS as readonly string[]).includes(target.method ?? "POST")) return undefined;
  let fixed: URLSearchParams;
  try {
    fixed = new URL(target.url.replace(PLACEHOLDER, "x")).searchParams;
  } catch {
    return undefined; // the URL's own issue is reported
  }
  for (const [name, property] of Object.entries(properties)) {
    if (names.includes(name)) continue;
    if (fixed.has(name)) return `'${name}' is both an input field and a query parameter the url fixes`;
    const types = typesOf(property);
    const items = types.includes("array") ? typesOf((property as { items?: unknown }).items) : [];
    if (types.includes("object") || items.includes("object") || items.includes("array"))
      return `'${name}' is sent in the query string by ${target.method}, so it must not be an object or hold objects`;
  }
  return undefined;
}

/** The JSON Schema `type`s a property declares, if any. */
function typesOf(schema: unknown): string[] {
  const type = schema && typeof schema === "object" ? (schema as { type?: unknown }).type : undefined;
  return typeof type === "string" ? [type] : Array.isArray(type) ? type.filter((t) => typeof t === "string") : [];
}

/** The request one call of an HTTP target makes, or why its input cannot make one. */
export type HttpToolRequest =
  | {
      readonly url: string;
      readonly method: HttpToolMethod;
      /** The JSON body, for `POST`, `PUT` and `PATCH`; `GET` and `DELETE` send none. */
      readonly body?: string;
    }
  | { readonly issue: string };

/**
 * The request a call of `target` with `input` makes. The fields the URL's path names fill it,
 * each percent-encoded as one path segment; the other fields are the JSON body for a body
 * method, and the query string, after the URL's own, for `GET` and `DELETE`. In the query
 * string an array repeats its name (`tag=a&tag=b`), a `null` is left out, and an object is
 * refused. A body-method target without URL parameters sends the input as it is.
 */
export function httpToolRequest(target: HttpToolTarget, input: unknown): HttpToolRequest {
  const method = target.method ?? "POST";
  const hasBody = (HTTP_BODY_METHODS as readonly string[]).includes(method);
  const names = httpPathParameters(target.url);
  if (hasBody && names.length === 0) return { url: target.url, method, body: JSON.stringify(input ?? {}) };
  const fields = input ?? {};
  if (typeof fields !== "object" || Array.isArray(fields)) return { issue: "The tool input must be an object" };
  const rest: Record<string, unknown> = { ...fields };
  let url = target.url;
  for (const name of names) {
    const segment = pathSegment(rest[name]);
    if (segment === undefined)
      return {
        issue: `'${name}' must be a non-empty string, a number or a boolean, and not . or ..: it fills {${name}} in the URL`,
      };
    delete rest[name];
    url = url.replace(`{${name}}`, () => segment);
  }
  if (hasBody) return { url, method, body: JSON.stringify(rest) };
  const query = queryString(rest);
  if (typeof query !== "string") return query;
  if (query === "") return { url, method };
  const joiner = !url.includes("?") ? "?" : url.endsWith("?") || url.endsWith("&") ? "" : "&";
  return { url: `${url}${joiner}${query}`, method };
}

/** `value` as one percent-encoded path segment, or undefined when it cannot be one. */
function pathSegment(value: unknown): string | undefined {
  if (typeof value === "number" && !Number.isFinite(value)) return undefined;
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return undefined;
  const text = String(value);
  // `.` and `..` are not encoded, and would move the request to another path. Side by side,
  // `{a}{b}` or `.{a}`, a `..` segment needs one value to be `.`, so this check covers them too.
  if (text === "" || text === "." || text === "..") return undefined;
  return encodeURIComponent(text);
}

/** `fields` as a query string, in their order, without a leading `?`; an object cannot be one. */
function queryString(fields: Readonly<Record<string, unknown>>): string | { readonly issue: string } {
  const pairs: string[] = [];
  for (const [name, value] of Object.entries(fields))
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item === null || item === undefined) continue;
      if (typeof item === "object")
        return { issue: `'${name}' is sent in the query string, so it must not be an object or hold objects` };
      pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(item))}`);
    }
  return pairs.join("&");
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
