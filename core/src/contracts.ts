/** Public wire contracts only. Never import checkpoint or engine modules here. */
import { z } from "zod";
import type {
  AgentHarnessSection,
  AgentManifest,
  HarnessMcpServer,
  HarnessSkill,
  McpServerManifest,
  WorkflowHarnessSection,
} from "./types/manifest.js";
import type { JsonObject, JsonValue } from "./types/shared.js";
import type { WorkflowLoopVerify, WorkflowManifest, WorkflowNode } from "./types/workflow.js";
import {
  SANDBOX_NETWORK_PRESETS,
  isSandboxHostPattern,
  parseSandboxDuration,
  parseSandboxSize,
} from "./utils/sandbox.js";
import {
  REMOVED_MANIFEST_FIELDS,
  REMOVED_RUNTIME_SECTION_FIELDS,
  agentManifestVersionIssue,
  manifestVersionIssue,
  workflowVersionIssue,
} from "./definition/removed.js";
import { DELEGATE_INPUT_SCHEMA, DELEGATE_NAME_PATTERN } from "./definition/delegate.js";
import { stdioMcpRefusal } from "./definition/mcp.js";
import {
  APPROVAL_MODES,
  HTTP_TOOL_METHODS,
  httpInputIssue,
  httpUrlIssue,
  httpUrlTemplateIssue,
  httpVerifierIssue,
} from "./definition/http-tool.js";
import { canonical } from "./utils/canonical.js";
import { FILE_NAME_MAX, FILE_PATH_MAX, LINK_TARGET_MAX } from "./utils/file-systems.js";
export { FILE_NAME_MAX, FILE_PATH_MAX } from "./utils/file-systems.js";
import { DEFAULT_HARNESS, HARNESS_ID_PATTERN, isHarnessId } from "./utils/harness-id.js";
export { DEFAULT_HARNESS, HARNESS_ID_PATTERN, isHarnessId };
import { isDefinitionFileHash, skillFilesIssue } from "./utils/definition-files.js";
import { MEMORY_ACCESS, MEMORY_INSTRUCTIONS_MAX, MEMORY_OPERATIONS } from "./utils/memory.js";
export {
  MEMORY_ACCESS,
  MEMORY_DESCRIPTION_MAX,
  MEMORY_INSTRUCTIONS_MAX,
  MEMORY_OPERATIONS,
  MEMORY_PATH_MAX,
  MEMORY_ROOT,
  memoryDescriptionOf,
  memoryPathOf,
  memoryPathWithin,
  type MemoryAccess,
  type MemoryOperation,
} from "./utils/memory.js";
export type {
  AgentHarnessSection,
  AgentManifest,
  AgentMemorySettings,
  HarnessMcpServer,
  HarnessSection,
  HarnessSkill,
  WorkflowHarnessSection,
} from "./types/manifest.js";
export type { WorkflowManifest } from "./types/workflow.js";
export { PROTOCOL_VERSION, ERROR_CODES } from "./compatibility.js";
export {
  SKILL_TOTAL_BYTES_DEFAULT,
  definitionFilesOf,
  isDefinitionFileHash,
  skillsOf,
} from "./utils/definition-files.js";
export {
  HARNESS_LIMIT_DEFAULTS,
  HarnessLimitsSchema,
  JS_STRING_MAX_LENGTH,
  RECORD_ENVELOPE_RESERVE_BYTES,
  RUNTIME_LIMIT_CEILINGS,
  RUNTIME_LIMIT_DEFAULTS,
  RuntimeLimitsSchema,
  S2_RECORD_MAX_BYTES,
  TIMER_MAX_MS,
  harnessLimitsOf,
  inlineBodyBytes,
  limitExceededMessage,
  runtimeLimitIssues,
  runtimeLimitsOf,
  type HarnessLimit,
  type HarnessLimits,
  type RuntimeLimit,
  type RuntimeLimits,
} from "./utils/runtime-limits.js";
import { RuntimeLimitsSchema, TIMER_MAX_MS } from "./utils/runtime-limits.js";
export {
  DEFAULT_CONTENT_TYPE,
  MODEL_IMAGE_TYPES,
  contentTypeFor,
  essence,
  extensionFor,
  inputLabel,
  isModelImage,
  isOffice,
  isText,
  modelInputOf,
  normalizeContentType,
} from "./utils/media-types.js";
export type { ErrorCode } from "./compatibility.js";
import { ERROR_CODES, isArtifactId } from "./compatibility.js";
export const RequestIdSchema = z.string().min(1);
/** At most 256 characters: an identifier's grammar is the protocol's (it crosses the Runtime API, the Harness API and tokens, and means the same in every installation), so its length is a constant of protocol 15, not a setting. */
export const IdempotencyKeySchema = z.string().min(1).max(256);
const jsonObject = z.record(z.string(), z.unknown());
/**
 * A JSON object in a definition document (a schema, metadata). Documents arrive as JSON, so its
 * values are JSON values: the manifest types say `JsonObject`, and the schema checks no value.
 */
const definitionJson = jsonObject as z.ZodType<JsonObject>;
// Recursive schemas carry an `id`: a document generated from them (the Runtime's OpenAPI)
// refers back to the named schema instead of expanding it forever.
const jsonValue: z.ZodType<JsonValue> = z
  .lazy(() =>
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(jsonValue),
      z.record(z.string(), jsonValue),
    ])
  )
  .meta({ id: "JsonValue" });
/**
 * A name the model sees in a tool name (R2b C6): a declared tool's, or an MCP server's, which
 * prefixes its tools' names. Letters, digits, `_` and `-`, up to 64: what every provider accepts.
 */
const modelFacingName = (what: string) =>
  z.string().regex(DELEGATE_NAME_PATTERN, {
    error: (issue) =>
      `${what} name '${String(issue.input)}' may use only letters, digits, _ and -, up to 64 characters, so that every model provider accepts it`,
  });
/** Which Agent Plugin brought a skill or an MCP server. */
const pluginLabelSchema = z
  .object({ name: z.string().min(1), version: z.string().min(1).optional() })
  .strict()
  .meta({ id: "PluginLabel" });
/** One tool's settings on an MCP server (R2b C9). */
const mcpToolSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    approval: z.enum(APPROVAL_MODES).optional(),
    deferred: z.boolean().optional(),
  })
  .strict()
  .meta({ id: "McpToolSettings" });
/** Per-tool settings keyed by the server's tool names, `"*"` for the rest (R2b C9, C10). */
const mcpServerSettings = {
  deferred: z.boolean().optional(),
  tools: z.record(z.string().min(1), mcpToolSettingsSchema).optional(),
  plugin: pluginLabelSchema.optional(),
};
const mcpServerSchema = z.discriminatedUnion(
  "type",
  [
    z
      .object({
        name: modelFacingName("MCP server"),
        type: z.literal("streamable-http"),
        url: z.string().min(1),
        headers: z.record(z.string(), z.string()).optional(),
        approval: z.enum(APPROVAL_MODES).optional(),
        ...mcpServerSettings,
      })
      .strict(),
    z
      .object({
        name: modelFacingName("MCP server"),
        type: z.literal("sse"),
        url: z.string().min(1),
        headers: z.record(z.string(), z.string()).optional(),
        approval: z.enum(APPROVAL_MODES).optional(),
        ...mcpServerSettings,
      })
      .strict(),
  ],
  { error: (issue) => stdioIssue(issue.input) },
);
/** A remote MCP server as a manifest declares it (`streamable-http` or `sse`). */
export const McpServerManifestSchema: z.ZodType<McpServerManifest> = mcpServerSchema;
/** The refusal of a `stdio` server; other bad declarations keep zod's own message. */
function stdioIssue(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const server = input as { type?: unknown; name?: unknown };
  if (server.type !== "stdio") return undefined;
  return stdioMcpRefusal(typeof server.name === "string" ? server.name : "(unnamed)");
}
const skillManifestSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    files: z.record(z.string(), z.string()),
    plugin: pluginLabelSchema.optional(),
  })
  .strict()
  .superRefine((skill, ctx) => {
    const issue = skillFilesIssue(skill.files);
    if (issue) ctx.addIssue({ code: "custom", path: ["files"], message: `Skill '${skill.name}' ${issue}` });
  });
const sandboxManifestSchema = z
  .object({
    image: z.string().min(1).optional(),
    network: z
      .object({
        preset: z.enum(SANDBOX_NETWORK_PRESETS).optional(),
        allow: z
          .array(
            z.string().refine(isSandboxHostPattern, {
              message: "network.allow entries must be host names such as api.github.com or *.example.com",
            })
          )
          .optional(),
      })
      .strict()
      .optional(),
    resources: z
      .object({
        /** At most the Tenant's `limits.resources.cpus` (`environments.config`). */
        cpus: z.number().int().min(1).optional(),
        memory: z
          .string()
          .refine((value) => parseSandboxSize(value) !== undefined, {
            message: "resources.memory must be a size such as 512MiB or 2GiB",
          })
          .optional(),
      })
      .strict()
      .optional(),
    idle: z
      .string()
      .refine((value) => parseSandboxDuration(value) !== undefined, {
        message: "idle must be a duration such as 30s, 15m or 1h",
      })
      .optional(),
  })
  .strict();
const httpToolTargetSchema = z
  .object({
    url: z.string().superRefine((url, ctx) => {
      const issue = httpUrlIssue(url) ?? httpUrlTemplateIssue(url);
      if (issue) ctx.addIssue({ code: "custom", message: issue });
    }),
    method: z.enum(HTTP_TOOL_METHODS).optional(),
    credential: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().max(TIMER_MAX_MS).optional(),
  })
  .strict();
/** A name kept for a later kind of `what` (tool, verifier), refused for now. */
const reservedKind = (what: string) =>
  z
    .unknown()
    .refine((value) => value === undefined, { message: "Functions are not available yet" })
    .optional()
    .meta({ description: `Reserved for a later kind of ${what}; refused for now.` });
/** Names kept for later kinds of tool, beside `agent` and `http`. */
const reservedToolKind = reservedKind("tool");
const toolManifestSchema = z
  .object({
    name: modelFacingName("Tool"),
    description: z.string().optional(),
    inputSchema: definitionJson,
    outputSchema: definitionJson.optional(),
    agent: z
      .lazy(() => z.union([workflowManifestSchema, AgentManifestSchema]))
      .meta({ id: "ToolAgentManifest" })
      .optional(),
    http: httpToolTargetSchema.optional(),
    approval: z.enum(APPROVAL_MODES).optional(),
    fn: reservedToolKind,
    command: reservedToolKind,
  })
  .strict()
  .superRefine((tool, ctx) => {
    if (tool.agent !== undefined && tool.http !== undefined)
      ctx.addIssue({
        code: "custom",
        message: `Tool '${tool.name}' is an agent or an HTTP request, not both`,
      });
    if (tool.approval !== undefined && tool.http === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["approval"],
        message: `Tool '${tool.name}' takes approval only as an HTTP tool`,
      });
    const parameters = tool.http && httpInputIssue(tool.http, tool.inputSchema);
    if (parameters) ctx.addIssue({ code: "custom", path: ["http", "url"], message: `Tool '${tool.name}': ${parameters}` });
  });
/** A manifest naming a removed field is refused with what replaces it. */
const removedFieldError =
  (removedFields: Readonly<Record<string, string>>) =>
  (issue: { code?: string; keys?: readonly string[] }) => {
    if (issue.code !== "unrecognized_keys") return undefined;
    const removed = issue.keys?.find((key) => removedFields[key] !== undefined);
    return removed === undefined ? undefined : removedFields[removed];
  };
/**
 * An environment variable name a shell secret or plain variable may take (R2c, D50): a POSIX
 * name, of any length (POSIX and Linux set none; a request's body bounds it). Names the sandbox
 * needs for itself (the proxy, the trust store, `PATH`, `HOME`) and `NYLORUN_*` are reserved.
 */
export const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * What an agent needs of the Environment its session opens on (protocol 14, D65), checked when a
 * session opens (`409 environment_unsuitable`). `sandbox`: `any` needs kind `virtual` or `pod`,
 * `pod` needs kind `pod`, `none` needs nothing. `secrets`: names its skills' scripts read, which
 * the Environment's vault must hold. The agent names no Environment: the app still maps.
 */
const agentRequirementsSchema = z
  .object({
    sandbox: z.enum(["none", "any", "pod"]).optional(),
    /** At most the Tenant's Runtime limit `environmentSecretSlots`, checked when the agent is deployed. */
    secrets: z.array(z.string().regex(ENVIRONMENT_NAME_PATTERN, "A secret name in requires is an environment variable name")).optional(),
  })
  .strict();
const agentManifestSchema = z
  .strictObject(
    {
      manifestSchemaVersion: z.literal(7, {
        error: (issue) => manifestVersionIssue(issue.input),
      }),
      id: z.string().min(1),
      name: z.string().min(1).optional(),
      description: z.string().optional(),
      metadata: definitionJson.optional(),
      outputSchema: definitionJson.optional(),
      instructions: z.array(z.string()).optional(),
      tools: z.array(toolManifestSchema).optional(),
      skills: z.record(z.string(), skillManifestSchema).optional(),
      mcpServers: z.record(z.string(), mcpServerSchema).optional(),
      requires: agentRequirementsSchema.optional(),
      // Reserved for Functions, which are deferred: developer code the Runtime will run from
      // uploaded definition files (a `functions/` folder). Any value is refused below.
      functions: z.unknown().optional().meta({ description: "Reserved: Functions are not available yet" }),
    },
    { error: removedFieldError(REMOVED_MANIFEST_FIELDS) }
  )
  .superRefine((manifest, ctx) => {
    if (manifest.functions !== undefined)
      ctx.addIssue({ code: "custom", path: ["functions"], message: "Functions are not available yet" });
    delegationIssues(manifest, (message) =>
      ctx.addIssue({ code: "custom", message })
    );
    const names = new Set<string>();
    for (const tool of manifest.tools ?? []) {
      if (tool.name.includes("__"))
        ctx.addIssue({
          code: "custom",
          message: `Tool '${tool.name}' must not contain '__', which names an MCP server's tools`,
        });
    }
    for (const tool of manifest.tools ?? []) {
      if (names.has(tool.name))
        ctx.addIssue({ code: "custom", message: "Tool names must be unique" });
      names.add(tool.name);
    }
    if (manifest.skills && Object.keys(manifest.skills).length === 0)
      ctx.addIssue({ code: "custom", message: "skills must be omitted when the agent has no skills" });
    for (const [key, skill] of Object.entries(manifest.skills ?? {}))
      if (key !== skill.name)
        ctx.addIssue({ code: "custom", message: `skills key '${key}' must equal the skill name` });
    if (manifest.mcpServers && Object.keys(manifest.mcpServers).length === 0)
      ctx.addIssue({ code: "custom", message: "mcpServers must be omitted when the agent has no servers" });
    for (const [key, server] of Object.entries(manifest.mcpServers ?? {}))
      if (key !== server.name)
        ctx.addIssue({ code: "custom", message: `mcpServers key '${key}' must equal the server name` });
  });
/**
 * An agent's manifest (manifest v7). Its output is checked against `AgentManifest` here and below
 * (`ManifestDrift`): the hand-written type keeps its read-only fields and its docs.
 */
export const AgentManifestSchema: z.ZodType<AgentManifest> = agentManifestSchema;
/** Agents used as tools: one level deep, `{ task }` input. */
function delegationIssues(manifest: AgentManifest, issue: (message: string) => void): void {
  for (const tool of manifest.tools ?? []) {
    const child = tool.agent;
    if (!child) continue;
    if (tool.name !== child.id)
      issue(`Tool '${tool.name}' must be named after the agent it runs ('${child.id}')`);
    if (!child.description?.trim() || tool.description !== child.description)
      issue(`Agent tool '${tool.name}' must carry the agent's non-empty description`);
    if (canonical(tool.inputSchema) !== canonical(DELEGATE_INPUT_SCHEMA))
      issue(`Agent tool '${tool.name}' must take the standard { task } input`);
    if (tool.outputSchema !== undefined)
      issue(`Agent tool '${tool.name}' must not declare outputSchema; the agent's outputSchema applies`);
    // A flow agent runs in its own linked session; its leaves may delegate in turn.
    if ("kind" in child) continue;
    if (child.tools?.some((item) => item.agent !== undefined))
      issue(`'${child.id}' delegates to another agent; nested delegation is not supported yet`);
  }
}
// Workflow manifest v3 (flow agents): `id` on any node, embedded agents, no functions.
const workflowNodeOptions = { id: z.string().min(1).optional() };
const workflowAgentNodeSchema = z
  .object({ agent: z.string().min(1), ...workflowNodeOptions })
  .strict();
/**
 * What judges a Loop attempt: a verifier agent (`{ agent, id? }`) or an HTTP verifier
 * (`{ http }`). `fn` and `command` are reserved for later kinds of verifier.
 */
const workflowLoopVerifySchema = z
  .object({
    agent: z.string().min(1).optional(),
    http: httpToolTargetSchema.optional(),
    fn: reservedKind("verifier"),
    command: reservedKind("verifier"),
    ...workflowNodeOptions,
  })
  .strict()
  .superRefine((verify, ctx) => {
    if (verify.fn !== undefined || verify.command !== undefined) return;
    if ((verify.agent === undefined) === (verify.http === undefined))
      ctx.addIssue({
        code: "custom",
        message: "A Loop's verify is a verifier agent ({ agent }) or an HTTP verifier ({ http }): exactly one",
      });
    else if (verify.http !== undefined && verify.id !== undefined)
      ctx.addIssue({ code: "custom", path: ["id"], message: "An HTTP verifier takes no id" });
    const verifier = verify.http && httpVerifierIssue(verify.http);
    if (verifier) ctx.addIssue({ code: "custom", path: ["http"], message: verifier });
  })
  .meta({ id: "WorkflowLoopVerify" }) as z.ZodType<WorkflowLoopVerify>; // the refinement picks one kind
const workflowNodeKinds = z.lazy(() =>
  z.union([
    workflowAgentNodeSchema,
    z
      .object({
        tool: z
          .object({
            name: z.string().min(1),
            description: z.string().optional(),
            inputSchema: definitionJson.optional(),
            outputSchema: definitionJson.optional(),
            /** An HTTP stage: the Runtime makes the request, as for an agent's HTTP tool. */
            http: httpToolTargetSchema.optional(),
          })
          .strict()
          .superRefine((tool, ctx) => {
            const parameters = tool.http && httpInputIssue(tool.http, tool.inputSchema);
            if (parameters)
              ctx.addIssue({ code: "custom", path: ["http", "url"], message: `Tool '${tool.name}': ${parameters}` });
          }),
        ...workflowNodeOptions,
      })
      .strict(),
    z.object({ chain: z.array(workflowNodeSchema).min(1), ...workflowNodeOptions }).strict(),
    z
      .object({
        switch: z
          .object({
            cases: z.record(z.string(), workflowNodeSchema),
            default: workflowNodeSchema.optional(),
          })
          .strict(),
        ...workflowNodeOptions,
      })
      .strict(),
    z
      .object({
        parallel: z
          .record(z.string(), workflowNodeSchema)
          .refine((branches) => Object.keys(branches).length > 0, {
            message: "parallel needs at least one branch",
          }),
        ...workflowNodeOptions,
      })
      .strict(),
    z
      .object({
        map: z.object({ each: workflowNodeSchema }).strict(),
        ...workflowNodeOptions,
      })
      .strict(),
    z
      .object({
        loop: z
          .object({
            run: workflowNodeSchema,
            verify: workflowLoopVerifySchema,
            max: z.number().int().positive(),
          })
          .strict(),
        ...workflowNodeOptions,
      })
      .strict(),
  ])
).meta({ id: "WorkflowNode" });
const workflowNodeSchema: z.ZodType<WorkflowNode> = workflowNodeKinds;
const workflowManifestObject = z.lazy(() =>
  z
    .object({
      kind: z.literal("workflow"),
      workflowSchemaVersion: z.literal(3, {
        error: (issue) => workflowVersionIssue(issue.input),
      }),
      id: z.string().min(1),
      name: z.string().min(1).optional(),
      description: z.string().optional(),
      metadata: definitionJson.optional(),
      inputSchema: definitionJson.optional(),
      outputSchema: definitionJson.optional(),
      sandbox: sandboxManifestSchema.optional(),
      root: workflowNodeSchema,
      agents: z.record(
        z.string().min(1),
        z.union([workflowManifestSchema, AgentManifestSchema])
      ),
    })
    .strict()
    .superRefine((manifest, ctx) => {
      for (const agentId of referencedAgents(manifest.root)) {
        if (!(agentId in manifest.agents))
          ctx.addIssue({
            code: "custom",
            path: ["agents"],
            message: `Agent '${agentId}' is used in the flow but not embedded in agents`,
          });
      }
      for (const [key, agent] of Object.entries(manifest.agents)) {
        if (agent.id !== key)
          ctx.addIssue({
            code: "custom",
            path: ["agents", key],
            message: `Embedded agent '${agent.id}' must be keyed by its id`,
          });
      }
    })
).meta({ id: "WorkflowManifest" });
const workflowManifestSchema: z.ZodType<WorkflowManifest> = workflowManifestObject;
function referencedAgents(node: WorkflowNode): string[] {
  const out: string[] = [];
  const visit = (child: WorkflowNode): void => {
    if ("agent" in child) out.push(child.agent);
    else if ("chain" in child) child.chain.forEach(visit);
    else if ("switch" in child) {
      Object.values(child.switch.cases).forEach(visit);
      if (child.switch.default) visit(child.switch.default);
    } else if ("parallel" in child) Object.values(child.parallel).forEach(visit);
    else if ("map" in child) visit(child.map.each);
    else if ("loop" in child) {
      visit(child.loop.run);
      if ("agent" in child.loop.verify) visit(child.loop.verify);
    }
  };
  visit(node);
  return out;
}
/** Workflow definition document. `kind: "workflow"`; a missing `kind` is never a workflow. */
export const WorkflowManifestSchema = workflowManifestSchema;
/**
 * The manifest types are written by hand (read-only fields, their docs); each schema above must
 * accept exactly them. Its annotation checks that what it outputs is one; `ManifestDrift` checks
 * the other way: the same keys, optional the same, with the same leaf types. Read-only modifiers
 * do not count, nor do the reserved names (typed `unknown`, refused when set). The paths stop at
 * the recursive types, which are compared on their own.
 */
type SameType<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type ShapeStop = JsonObject | AgentManifest | WorkflowManifest | WorkflowNode | WorkflowLoopVerify;
/** Whether `T` is a stop (or one kind of node), compared as a type, not by its shape. */
type IsShapeStop<T, Stop = ShapeStop> = Stop extends unknown ? SameType<T, Stop> : never;
/** Every property path of `T`: keys (`?` when optional), `[]` for an item, then the leaf's type. */
type ShapePaths<T, Top extends boolean = false> = T extends unknown
  ? Top extends false
    ? true extends IsShapeStop<T>
      ? []
      : ShapeMembers<T>
    : ShapeMembers<T>
  : never;
type ShapeMembers<T> = T extends readonly (infer Item)[]
  ? ["[]", ...ShapePaths<Item>]
  : T extends object
    ? Exclude<
        {
          [K in keyof T]: unknown extends T[K]
            ? never
            : [NonNullable<T[K]>] extends [never]
              ? never
              : [ShapeKey<T, K>] | [ShapeKey<T, K>, ...ShapePaths<NonNullable<T[K]>>];
        }[keyof T],
        undefined
      >
    : [T];
type ShapeKey<T, K extends keyof T> = {} extends Pick<T, K> ? `${K & string}?` : K;
/** `true`, or the paths only one side has. */
type ManifestDrift<Declared, Schema> = [
  Exclude<ShapePaths<Declared, true>, ShapePaths<Schema, true>>,
  Exclude<ShapePaths<Schema, true>, ShapePaths<Declared, true>>,
] extends [never, never]
  ? true
  : {
      declaredOnly: Exclude<ShapePaths<Declared, true>, ShapePaths<Schema, true>>;
      schemaOnly: Exclude<ShapePaths<Schema, true>, ShapePaths<Declared, true>>;
    };
type AssertNoDrift<T extends true> = T;
type _AgentManifestDrift = AssertNoDrift<
  ManifestDrift<AgentManifest, z.output<typeof agentManifestSchema>>
>;
type _WorkflowManifestDrift = AssertNoDrift<
  ManifestDrift<WorkflowManifest, z.output<typeof workflowManifestObject>>
>;
type _WorkflowNodeDrift = AssertNoDrift<
  ManifestDrift<WorkflowNode, z.output<typeof workflowNodeKinds>>
>;
/**
 * A loop manifest: what the engine runs (agent manifest v7's shape, or workflow manifest v3's),
 * as the Runtime makes it from an agent manifest v8's harness section (`loopManifestOf`) and a
 * session pins it.
 */
export const DefinitionDocumentSchema = z.union([
  AgentManifestSchema,
  WorkflowManifestSchema,
]);
export type DefinitionDocument = AgentManifest | WorkflowManifest;
const hostPatternSchema = z.string().refine(isSandboxHostPattern, {
  message: "network.allowedHosts entries must be host names such as api.github.com or *.example.com",
});
const durationSchema = (name: string) =>
  z.string().refine((value) => parseSandboxDuration(value) !== undefined, {
    message: `${name} must be a duration such as 30s, 15m or 1h`,
  });
const resourcesSchema = z
  .object({
    /** At most the Tenant's `limits.resources.cpus` (`environments.config`), which it sets. */
    cpus: z.number().int().min(1).optional(),
    memory: z
      .string()
      .refine((value) => parseSandboxSize(value) !== undefined, {
        message: "resources.memory must be a size such as 512MiB or 2GiB",
      })
      .optional(),
  })
  .strict();

// --- Environments (protocol 11, R2d, blueprint D55 and D56) --------------------------------

/**
 * An Agent id (protocol 16; an Environment id before): 1–200 characters, one or more
 * `/`-separated segments of letters, digits, `.`, `_` and `-`, each starting with a letter or
 * digit (`triage`, `users/alice/triage`). Ids are hierarchical so a grant can name a family of
 * them (`users/alice/*`).
 */
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
/**
 * An identifier's grammar is the protocol's (B15): it crosses the Runtime API, tokens and grants
 * and means the same in every installation, so its length is a constant of the protocol, not a
 * setting.
 */
export const AGENT_ID_MAX_LENGTH = 200;

export function isAgentId(value: unknown): value is string {
  return typeof value === "string" && value.length <= AGENT_ID_MAX_LENGTH && AGENT_ID_PATTERN.test(value);
}

/** An Agent grant: an exact Agent id, or a prefix ending in `/*` (`team-a/*`). */
export function isAgentGrant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return value === "*" || (value.endsWith("/*") ? isAgentId(value.slice(0, -2)) : isAgentId(value));
}

/**
 * Whether `grants` (a token caller's Agent grants) reach Agent `id`: `*`, an exact entry, or a
 * prefix entry `p/*` for any id below `p/`. No grants reach no Agent.
 */
export function agentGranted(grants: readonly string[] | undefined, id: string): boolean {
  for (const grant of grants ?? []) {
    if (grant === "*") return true;
    if (grant.endsWith("/*")) {
      if (id.startsWith(grant.slice(0, -1))) return true;
    } else if (grant === id) return true;
  }
  return false;
}

export const AgentIdSchema = z
  .string()
  .refine(isAgentId, {
    message: "An Agent id is up to 200 characters: /-separated segments of letters, digits, '.', '_' and '-'",
  })
  .meta({ description: "An Agent id, such as `triage` or `users/alice/triage`" });
export const AgentGrantSchema = z.string().refine(isAgentGrant, {
  message: "An Agent grant is *, an Agent id, or a prefix ending in /* such as team-a/*",
});

/**
 * `virtual`: a just-bash workspace in the harness container, no cluster (a local convenience).
 * `pod`: an agent-sandbox pod with its own volume (Host feature `sandbox-pods`). `none`: no
 * compute, only the vault, for agents whose tools are remote MCP servers and HTTP tools.
 */
export const ENVIRONMENT_KINDS = ["virtual", "pod", "none"] as const;
export type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number];
/** The kinds with a sandbox (a disk and the sandbox tools). */
export type SandboxKind = Exclude<EnvironmentKind, "none">;

const LABEL_KEY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/;
const LABEL_VALUE_PATTERN = /^[\x20-\x7e]*$/;
/**
 * The developer's own key-value pairs; the Runtime stores and filters them, never reads them. How
 * many, and how long a key and a value may be, are the Tenant's Runtime limits
 * `environmentLabels`, `labelKeyChars` and `labelValueChars`, checked when they are set.
 */
export const EnvironmentLabelsSchema = z.record(
  z.string().regex(LABEL_KEY_PATTERN, {
    message: "Label keys are letters, digits, '.', '_', '/' and '-', and start and end with a letter or digit",
  }),
  z.string().regex(LABEL_VALUE_PATTERN, {
    message: "Label values are printable ASCII characters",
  }),
);
export type EnvironmentLabels = z.infer<typeof EnvironmentLabelsSchema>;

/** A harness id (track R4): what a harness names itself in `hello`. */
export const HarnessIdSchema = z.string().regex(HARNESS_ID_PATTERN, {
  message: "harness must be a harness id: lowercase letters, digits and dashes, starting with a letter",
});

/**
 * An Environment's lifecycle. `idle`: stop compute after this long without a turn, at most the
 * Tenant's `limits.idle` (default the Tenant's). `deleteAfter`: delete the Environment, its vault
 * and its disk once it has gone this long unused (no turn, recipe change, secret write, stop or
 * reset); default never.
 */
export const EnvironmentLifecycleSchema = z
  .object({
    idle: durationSchema("lifecycle.idle").optional(),
    deleteAfter: durationSchema("lifecycle.deleteAfter").optional(),
  })
  .strict();
export type EnvironmentLifecycle = z.infer<typeof EnvironmentLifecycleSchema>;

/**
 * The default of a setup command's `timeout` setting. The longest one may ask for is the Tenant's
 * Runtime limit `setupCommandMs`.
 */
export const ENVIRONMENT_SETUP_TIMEOUT_DEFAULT = "10m";
const absoluteWorkspacePath = (name: string) =>
  z
    .string()
    .min(1)
    .max(FILE_PATH_MAX)
    .refine(
      (value) =>
        (value === "/workspace" || value.startsWith("/workspace/")) &&
        !value.split("/").some((segment) => segment === ".." || segment === "."),
      { message: `${name} must be /workspace or a path under it, without . or .. segments` },
    );
/**
 * One setup command (pods only): run with `/bin/sh -c` when the pod's disk is made or reset,
 * before the engine takes a turn, with the Environment's variables, secrets (as the sentinel)
 * and egress, as a turn's commands are.
 */
export const EnvironmentSetupCommandSchema = z
  .object({
    /** At most the Tenant's Runtime limit `setupCommandChars`, checked when the manifest is put. */
    command: z.string().min(1),
    /** Where it runs. Default `/workspace`. */
    cwd: absoluteWorkspacePath("cwd").optional(),
    /** Default 10m (`ENVIRONMENT_SETUP_TIMEOUT_DEFAULT`), at most the Tenant's `setupCommandMs`. */
    timeout: durationSchema("timeout").optional(),
  })
  .strict();
export type EnvironmentSetupCommand = z.infer<typeof EnvironmentSetupCommandSchema>;
/**
 * One input file (pods only): a version of a Tenant-wide artifact, copied in when the pod's disk
 * is made or reset, before the setup commands. A file artifact is written at `path`; a folder
 * artifact is unpacked under it.
 */
/** A file's path inside a `files` entry by hash: relative, `/`-separated, without `.` or `..`. */
const relativeFilePath = z
  .string()
  .min(1)
  .max(FILE_PATH_MAX)
  .refine(
    (value) =>
      !value.startsWith("/") && !value.includes("\0") && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    { message: "a file's path is relative, without empty, . or .. segments" },
  );
/**
 * One input file entry (pods only): an artifact version copied to `path` (a file artifact, or a
 * folder's files under it), or (Q6) files by content hash, each `sha256:<hex>` of a definition
 * file the Tenant holds (`PUT /v1/files/sha256:<hex>`, at most 2 GiB each), copied under `path`
 * at its relative path. A manifest by hash moves to another Tenant with its files.
 */
export const EnvironmentFileSchema = z.union([
  z
    .object({
      artifactId: z.string().refine(isArtifactId, { message: "artifactId must be an artifact id" }),
      version: z.number().int().positive(),
      path: absoluteWorkspacePath("path"),
    })
    .strict(),
  z
    .object({
      path: absoluteWorkspacePath("path"),
      files: z
        .record(
          relativeFilePath,
          z.string().refine(isDefinitionFileHash, { message: "each file is sha256:<64 lowercase hex>" }),
        )
        // At most the Tenant's Runtime limit `environmentFilesPerEntry`, checked when made (Q6).
        .refine((files) => Object.keys(files).length >= 1, { message: "files names at least one file" }),
    })
    .strict(),
]);
export type EnvironmentFile = z.infer<typeof EnvironmentFileSchema>;

/**
 * An agent manifest's name (protocol 16): 1–64 letters, digits, `.`, `_` and `-`, starting with a
 * letter or digit, such as `triage`; a version is at most 9 digits. Manifest names and Agent ids
 * are separate namespaces.
 */
const AGENT_MANIFEST_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export function isAgentManifestName(value: unknown): value is string {
  return typeof value === "string" && AGENT_MANIFEST_NAME_PATTERN.test(value);
}
export const AgentManifestNameSchema = z
  .string()
  .refine(isAgentManifestName, {
    message: "An agent manifest's name is 1-64 letters, digits, '.', '_' and '-', starting with a letter or digit",
  })
  .meta({ description: "An agent manifest's name, such as `triage`" });
/**
 * Which agent manifest an Agent is made from: `name` (tracking: the latest version when the Agent
 * is created; track T3 moves it on) or `name@n` (pinned to version `n`).
 */
export function parseAgentManifestRef(ref: string): { name: string; version?: number } | undefined {
  const at = ref.lastIndexOf("@");
  const name = at < 0 ? ref : ref.slice(0, at);
  if (!isAgentManifestName(name)) return undefined;
  if (at < 0) return { name };
  const version = ref.slice(at + 1);
  return /^[1-9][0-9]{0,8}$/.test(version) ? { name, version: Number(version) } : undefined;
}
export const AgentManifestRefSchema = z
  .string()
  .refine((value) => parseAgentManifestRef(value) !== undefined, {
    message: "manifest is an agent manifest's name, or name@version such as triage@3",
  })
  .meta({ description: "`name` (tracking) or `name@n` (pinned)" });

/**
 * What an Environment's artifacts, its sessions' skills and its disk versions may hold: part of
 * its manifest, fixed for its life. Each limit left out is the Tenant's (`/v1/tenant/artifacts`,
 * `/v1/tenant/skills`, `/v1/tenant/limits`) as it is when the limit is checked, and none may be
 * above the Tenant's.
 */
export const EnvironmentLimitsSchema = z
  .object({
    artifacts: z
      .object({
        /** The largest file one artifact upload, save or export may store. */
        fileBytes: z.number().int().positive().optional(),
        /** The most bytes the artifacts of its sessions and its disk versions may hold together. */
        totalBytes: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    skills: z
      .object({
        /** The most bytes one skill's files may hold together, for a session to open in it. */
        totalBytes: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    /** Its disk versions, within the Tenant's Runtime limits `diskVersion*` (`/v1/tenant/limits`). */
    disk: z
      .object({
        /** The most bytes of files one version of its disk holds. */
        versionBytes: z.number().int().positive().optional(),
        /** The most entries (files, links, empty directories) one version holds. */
        versionEntries: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type EnvironmentLimits = z.infer<typeof EnvironmentLimitsSchema>;

/**
 * The fields of a runtime section (agent manifest v8, protocol 16): what the Runtime provides
 * around an Agent's loop. Environment manifest v1's fields, which they were until protocol 16.
 */
const runtimeFields = {
  /** `virtual`, `pod` (needs sandbox pods, `nylorun local sandbox enable`) or `none`. Fixed. */
  kind: z.enum(ENVIRONMENT_KINDS),
  /** Pods only: the workload image (default the Tenant's, else `python:3.13-slim`). */
  image: z.string().min(1).optional(),
  resources: resourcesSchema.optional(),
  /** Pods only: the volume's size (default 5GiB). Fixed. */
  storage: z
    .string()
    .refine((value) => parseSandboxSize(value) !== undefined, {
      message: "storage must be a size such as 5GiB",
    })
    .optional(),
  /** Hosts the sandbox may reach; pods also take `*.suffix` patterns. */
  network: z
    .object({ allowedHosts: z.array(hostPatternSchema).optional() })
    .strict()
    .optional(),
  lifecycle: EnvironmentLifecycleSchema.optional(),
  /** Pods only: commands run when the disk is made or reset, before any turn. */
  setup: z.array(EnvironmentSetupCommandSchema).optional(),
  /** Pods only: artifact versions or files by hash copied in when the disk is made or reset, before `setup`. */
  files: z.array(EnvironmentFileSchema).optional(),
  /** What its artifacts and its sessions' skills may hold, at most the Tenant's limits. Fixed. */
  limits: EnvironmentLimitsSchema.optional(),
};

/**
 * `PUT /v1/agents/{agentId}` (protocol 16): creates the Agent, its vault and its compute from a
 * saved agent manifest, or finds the one with this id, so "get or create" is one call. An Agent is
 * the live instance of one version of an agent manifest: `manifest: "name"` records that it
 * tracks the manifest (its latest version, and every version saved later) and `"name@n"` that it
 * is pinned to one; the version it runs is `resolvedVersion`. On an existing Agent, `labels`
 * replace its labels, `owner` sets or clears its owner guard, and `manifest` moves it (track T3,
 * D73): to another version of its manifest, tracking or pinned. A move changes no data: its id,
 * disk, vault and sessions stay. A harness-only change applies at once; a runtime change of a pod
 * waits for its next start; one that adds a required secret waits for its value. Its manifest's
 * name, kind, harness and storage are fixed (`409 agent_fixed_field`); fork it to change them.
 * `?dryRun=true` answers the move's plan (`AgentMovePlan`) and changes nothing.
 */
export const PutAgentRequestSchema = z
  .object({
    requestId: RequestIdSchema.optional(),
    /** The agent manifest it is made from: `name` (tracking) or `name@n` (pinned). */
    manifest: AgentManifestRefSchema,
    /**
     * The owner guard: when set, only sessions of this owner may run on the Agent (checked when
     * a session opens and at every turn start). `null` clears it.
     */
    owner: z.string().min(1).nullable().optional(),
    labels: EnvironmentLabelsSchema.optional(),
    /**
     * Only when the `PUT` creates the Agent (Host feature `environment-disk-versions`): its disk
     * starts from this version of another Agent's disk. Its vault starts empty.
     */
    from: z
      .object({
        agent: AgentIdSchema,
        version: z.union([z.number().int().positive(), z.literal("latest")]),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PutAgentRequest = z.infer<typeof PutAgentRequestSchema>;

/**
 * What an Agent's environment runs: its manifest version's runtime section resolved against the
 * Tenant's limits when the Agent was made, with the harness that runs its loop. It never changes
 * after that.
 */
export const EnvironmentRecipeSchema = z
  .object({
    image: z.string().optional(),
    resources: z.object({ cpus: z.number().int(), memory: z.string() }).strict().optional(),
    storage: z.string().optional(),
    network: z.object({ allowedHosts: z.array(z.string()) }).strict().optional(),
    harness: z.string(),
    lifecycle: EnvironmentLifecycleSchema,
    setup: z.array(EnvironmentSetupCommandSchema).optional(),
    files: z.array(EnvironmentFileSchema).optional(),
    /** As the manifest set them: a limit left out is the Tenant's when it is checked. */
    limits: EnvironmentLimitsSchema.optional(),
    secrets: z.lazy(() => EnvironmentSecretSlotsSchema).optional(),
  })
  .strict();
export type EnvironmentRecipe = z.infer<typeof EnvironmentRecipeSchema>;

/** A session on an Agent, as the Agent's view lists it: none is special (D71). */
export const AgentSessionSchema = z
  .object({
    id: z.string(),
    ownerUserId: z.string(),
    status: z.string(),
    activeTurnId: z.string().nullable(),
  })
  .strict();

/** What the Runtime wants of a pod (`desired`) and what it last saw (`observed`). */
export const POD_DESIRED = ["running", "suspended", "deleted"] as const;
export const POD_OBSERVED = [
  "creating",
  "running",
  "suspended",
  "lost",
  "failed",
  "deleting",
] as const;
export type PodDesired = (typeof POD_DESIRED)[number];
export type PodObserved = (typeof POD_OBSERVED)[number];
export const AgentPodViewSchema = z
  .object({
    desired: z.enum(POD_DESIRED),
    observed: z.enum(POD_OBSERVED),
    /** Bumped by every reset: each generation has its own volume. */
    volumeGeneration: z.number().int().nonnegative(),
    /** Bumped each time a pod joins; a host token of an older epoch is refused. */
    hostEpoch: z.number().int().nonnegative(),
    /** Why it failed, or was lost. */
    reason: z.string().optional(),
    /**
     * The workload image by digest (`repo@sha256:…`), pinned the first time a pod was ready
     * (Q14): every later pod runs it. Absent before then, or for an image with no repository.
     */
    imageDigest: z.string().optional(),
  })
  .strict();
export type AgentPodView = z.infer<typeof AgentPodViewSchema>;

/**
 * The compute states an Agent's environment reports (`compute.state`): `ready` until a tool
 * first runs in a virtual one, then `creating`, `running` or `stopped`. An open set: clients must
 * accept values they do not know.
 */
export const COMPUTE_STATES = ["ready", "creating", "running", "stopped"] as const;

/**
 * An Agent's state (protocol 16), derived when it is read, the first that holds:
 *
 * - `paused`: its desired state is `off` (nothing in protocol 16 sets it; track T6 adds the control).
 * - `failing`: its compute failed or was lost, or a session's latest finished turn failed.
 * - `input_required`: a session waits on a person (an approval or interaction, or an uncertain
 *   effect), even while another works.
 * - `working`: a turn runs.
 * - `sleeping`: nothing to do.
 *
 * An open set: clients must accept values they do not know.
 */
export const AGENT_STATES = ["paused", "failing", "input_required", "working", "sleeping"] as const;
export type AgentState = (typeof AGENT_STATES)[number];
/** What made an Agent's state, or another state that also holds (`attention`). */
export const AgentAttentionSchema = z
  .object({
    state: z.enum(AGENT_STATES),
    /** The session behind it; absent for the Agent's compute. */
    sessionId: z.string().optional(),
    /** Why, for a person: the session's status, or the compute's failure. */
    reason: z.string(),
  })
  .strict();
export type AgentAttention = z.infer<typeof AgentAttentionSchema>;

/** `PUT` and `GET /v1/agents/{agentId}`. */
export const AgentViewSchema = z
  .object({
    id: z.string(),
    /** How it names its manifest: `name` (tracking) or `name@n` (pinned). */
    manifest: z.string(),
    /** The version of the manifest it runs: each turn takes it when the turn starts. */
    resolvedVersion: z.number().int().positive(),
    /** The hash of that version. */
    manifestHash: z.string(),
    /** Whether `manifest` tracks the manifest's latest version or pins one. */
    tracking: z.enum(["tracking", "pinned"]),
    /**
     * Track T3: the version it moves to while it is outdated, else `null`. It waits for a value of
     * each required secret the version adds (`waitingFor: "secrets"`) or for its pod's next start
     * (`"start"`); turns run `resolvedVersion` meanwhile.
     */
    targetVersion: z.number().int().positive().nullable(),
    /** What the move to `targetVersion` waits for, else `null`. */
    waitingFor: z.enum(["secrets", "start"]).nullable(),
    /**
     * A version that failed to start: the Agent went back to the one it ran, and a tracking Agent
     * does not move to it again on its own. `null` once a start on a new version succeeds.
     */
    failedVersion: z.number().int().positive().nullable(),
    /**
     * While its pod starts on a new version: the version it ran before, which a failed start
     * goes back to, and since when it starts. `null` otherwise.
     */
    startCheck: z
      .object({ from: z.number().int().positive(), startedAt: z.string() })
      .strict()
      .nullable(),
    kind: z.enum(ENVIRONMENT_KINDS),
    /** The harness that runs its loop: its manifest's `harness.id`, else `nylorun`. */
    harness: z.string(),
    /** The owner guard, or `null`. */
    owner: z.string().nullable(),
    labels: z.record(z.string(), z.string()),
    /** See `AGENT_STATES`: an open set. */
    state: z.string().meta({ description: "working, sleeping, input_required, failing or paused; an open set" }),
    /** Every state that holds, with the session behind each: what made `state` first. */
    attention: z.array(AgentAttentionSchema),
    /** `on`, or `off` once paused (track T6). */
    desired: z.enum(["on", "off"]),
    /** When its next trigger fires: the earliest next run of its active triggers (D74), or `null`. */
    nextWakeAt: z.string().nullable(),
    compute: z
      .object({
        /** See `COMPUTE_STATES`: an open set. */
        state: z.string().meta({ description: "ready, creating, running or stopped; an open set" }),
        /** Kind `pod`: what the Runtime wants of the pod and what it last saw. */
        pod: AgentPodViewSchema.optional(),
      })
      .strict(),
    /** What its environment runs: the runtime section of `resolvedVersion`, resolved. */
    runtime: EnvironmentRecipeSchema,
    /** The limits in force now: its manifest's, else the Tenant's, never above the Tenant's. */
    limits: z
      .object({
        artifacts: z.object({ fileBytes: z.number().int(), totalBytes: z.number().int() }).strict(),
        skills: z.object({ totalBytes: z.number().int() }).strict(),
        disk: z.object({ versionBytes: z.number().int(), versionEntries: z.number().int() }).strict(),
      })
      .strict(),
    /** Its sessions (acting for a subject, only the subject's own). */
    sessions: z.array(AgentSessionSchema),
    /** Each secret slot its manifest declares, and whether its vault holds a value for it. */
    slots: z.array(
      z
        .object({
          name: z.string(),
          type: z.string(),
          required: z.boolean(),
          set: z.boolean(),
        })
        .strict(),
    ),
    /**
     * Its disk versions (Host feature `environment-disk-versions`): the latest, and the copy
     * that holds the disk now, if one does. Absent for kind `none`.
     */
    disk: z
      .object({
        latestVersion: z.number().int().positive().nullable(),
        operation: z
          .object({
            kind: z.enum(["snapshot", "restore", "seed"]),
            version: z.number().int().positive().optional(),
            startedAt: z.string(),
          })
          .strict()
          .nullable(),
      })
      .strict()
      .optional(),
    /** The Agent it was forked from (`POST .../fork`), and the disk version it started from. */
    forkedFrom: z
      .object({ agent: z.string(), disk: z.number().int().positive().nullable() })
      .strict()
      .nullable(),
    /** When it was last used: a turn, a secret write, a stop or a reset. */
    lastUsedAt: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type AgentView = z.infer<typeof AgentViewSchema>;

/** `POST /v1/agents/{id}/snapshot`: a new version of the Agent's disk. */
export const AgentSnapshotSchema = z
  .object({
    agentId: z.string(),
    artifactId: z.string(),
    version: z.number().int().positive(),
    format: z.string(),
    /** Entries in the version: files, links and empty directories. */
    files: z.number().int().nonnegative(),
    /** The files' bytes. */
    bytes: z.number().int().nonnegative(),
    /** Of those, the bytes stored now (the rest were stored already). */
    storedBytes: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    /** True when the disk had not changed: `version` is the latest, and nothing was stored. */
    unchanged: z.boolean(),
    createdAt: z.string(),
  })
  .strict();
export type AgentSnapshot = z.infer<typeof AgentSnapshotSchema>;
/** `POST /v1/agents/{id}/restore`: which version of its disk to put back. */
export const RestoreAgentRequestSchema = z
  .object({
    requestId: RequestIdSchema.optional(),
    version: z.union([z.number().int().positive(), z.literal("latest")]),
  })
  .strict();
export type RestoreAgentRequest = z.infer<typeof RestoreAgentRequestSchema>;
export const AgentRestoreSchema = z
  .object({
    agentId: z.string(),
    restored: z.number().int().positive(),
    /**
     * `done` once the version is back (a virtual Agent); `pending` while a pod's new volume is
     * seeded (`disk.operation` in the view until it ends; turns wait for it).
     */
    status: z.enum(["done", "pending"]),
    volumeGeneration: z.number().int().nonnegative().optional(),
  })
  .strict();
export type AgentRestore = z.infer<typeof AgentRestoreSchema>;
/** `GET /v1/agents/{id}/versions`: its disk versions, newest first. */
export const AgentDiskVersionsSchema = z
  .object({
    agentId: z.string(),
    /** The folder artifact that holds them (read trees, files and diffs through `/v1/artifacts`). */
    artifactId: z.string().nullable(),
    latest: z.number().int().positive().nullable(),
    versions: z.array(
      z
        .object({
          version: z.number().int().positive(),
          bytes: z.number().int().nonnegative(),
          createdAt: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export type AgentDiskVersions = z.infer<typeof AgentDiskVersionsSchema>;

export const DeleteAgentResponseSchema = z
  .object({ id: z.string(), deleted: z.boolean() })
  .strict();
export type DeleteAgentResponse = z.infer<typeof DeleteAgentResponseSchema>;

/** A turn that was running on an Agent when one of its connections opened (D67). */
export const EgressRunningTurnSchema = z
  .object({ sessionId: z.string(), turnId: z.string() })
  .strict();
export type EgressRunningTurn = z.infer<typeof EgressRunningTurnSchema>;

/**
 * One connection a pod Agent opened through egress-gate (track R7, Q6): written when it closes,
 * or at once when the gate refused it, to the Agent's own stream as `agent.egress` (D67). The
 * connection is the Agent's: its egress token names the pod, and the Agent's sessions run turns
 * in parallel (D66). `runningTurns` lists the turns active on it as the connection opened, at
 * most 16, as context and never as the owner.
 *
 * `startedAt` is the gate's clock at CONNECT and `durationMs` runs from there to the close, so
 * the span is the gate's own measurement. `bytesUp` is what the sandbox sent, `bytesDown` what it
 * got. `mode: "credential"` is a host an `environment_secret` is bound to (R2c): the gate read
 * each request (`requests`) and set a credential on it (`credentialIds`, ids only). It never
 * carries a header value, a URL path or a body.
 */
export const EgressConnectionPayloadSchema = z
  .object({
    agentId: z.string(),
    host: z.string(),
    port: z.number().int(),
    outcome: z.enum(["allowed", "refused"]),
    /** Why the gate refused it, as in its `egress_refused` log line (`host_not_allowed`, …). */
    reason: z.string().optional(),
    /** The HTTP status a refusal answered the CONNECT with. */
    status: z.number().int().optional(),
    mode: z.enum(["tunnel", "credential"]),
    credentialBound: z.boolean(),
    credentialIds: z.array(z.string()).optional(),
    requests: z.number().int().nonnegative().optional(),
    bytesUp: z.number().int().nonnegative(),
    bytesDown: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
    startedAt: z.string(),
    runningTurns: z.array(EgressRunningTurnSchema).max(16),
  })
  .passthrough();

/** The schema id of an Agent's lifecycle events (its stream in the record). */
export const AGENT_EVENT_SCHEMA = "nylorun.agent-event/1";
export const AGENT_EVENT_TYPES = [
  "agent.created",
  "agent.attached",
  "agent.detached",
  "agent.deleted",
  // Kind `pod` (Host feature `sandbox-pods`).
  "agent.running",
  "agent.suspended",
  "agent.relaunched",
  "agent.lost",
  "agent.reset",
  "agent.failed",
  // Forked into a new Agent (Q15).
  "agent.forked",
  // Moved to another version of its manifest (track T3, D73).
  "agent.outdated",
  "agent.version_changed",
  "agent.start_failed",
  // egress-gate: every connection the Agent opens (R7, D67).
  "agent.egress",
  // Triggers (track T4, D74): each run, and a trigger paused or resumed.
  "agent.run",
  "agent.trigger_paused",
  "agent.trigger_resumed",
  "agent.trigger_secret_rotated",
] as const;
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];
/** The payload of each Agent lifecycle event. */
export const AGENT_EVENT_PAYLOADS = {
  "agent.created": z
    .object({
      kind: z.enum(ENVIRONMENT_KINDS),
      labels: z.record(z.string(), z.string()),
      /** The agent manifest and version it was made from, and how it refers to it. */
      manifest: z
        .object({ name: z.string(), version: z.number().int().positive(), tracking: z.enum(["tracking", "pinned"]) })
        .strict(),
      /** The Agent it was forked from, and the disk version it started from (Q15). */
      forkedFrom: z
        .object({ agent: z.string(), disk: z.number().int().positive().nullable() })
        .strict()
        .optional(),
    })
    .passthrough(),
  "agent.attached": z.object({ sessionId: z.string() }).passthrough(),
  "agent.detached": z
    .object({ sessionId: z.string(), reason: z.enum(["reset"]) })
    .passthrough(),
  /** Deleted by a `DELETE`, or by the sweep once `lifecycle.deleteAfter` passed (`reason`). */
  "agent.deleted": z
    .object({ reason: z.enum(["delete", "deleteAfter"]).optional() })
    .passthrough(),
  /** A pod joined and serves the Agent. */
  "agent.running": z.object({ hostEpoch: z.number().int() }).passthrough(),
  /** Stopped (`POST .../stop`, or idle): the volume is kept; the next turn starts it again. */
  "agent.suspended": z.object({ reason: z.enum(["stop", "idle", "restart"]) }).passthrough(),
  /** Its pod was replaced (same volume): the old pod's host token no longer works. */
  "agent.relaunched": z.object({ hostEpoch: z.number().int() }).passthrough(),
  /** Its volume or node is gone: turns are refused until a reset. */
  "agent.lost": z.object({ reason: z.string() }).passthrough(),
  /** Reset: a new pod on a new, empty volume. */
  "agent.reset": z.object({ volumeGeneration: z.number().int() }).passthrough(),
  /** The pod did not become ready. */
  "agent.failed": z.object({ reason: z.string() }).passthrough(),
  /** Forked into Agent `to`: its disk started from version `disk`, `secrets` were copied. */
  "agent.forked": z
    .object({
      to: z.string(),
      disk: z.number().int().positive().nullable(),
      manifest: z.object({ name: z.string(), version: z.number().int().positive() }).strict(),
      secrets: z.number().int().nonnegative(),
    })
    .passthrough(),
  /**
   * Asked to move to version `to` of its manifest, which waits (track T3): for a value of each
   * required secret it adds (`secrets`), or for its pod's next start (`start`).
   */
  "agent.outdated": z
    .object({
      from: z.number().int().positive(),
      to: z.number().int().positive(),
      waitingFor: z.enum(["secrets", "start"]),
    })
    .passthrough(),
  /** Runs version `to` of its manifest now: turns that start from here run it (track T3). */
  "agent.version_changed": z
    .object({ from: z.number().int().positive(), to: z.number().int().positive() })
    .passthrough(),
  /**
   * Its pod did not start on version `to` (its setup failed, the pod failed, or it took longer
   * than the Host allows): it went back to version `from`, with its disk as it was (track T3).
   */
  "agent.start_failed": z
    .object({
      from: z.number().int().positive(),
      to: z.number().int().positive(),
      reason: z.string(),
      reverted: z.boolean(),
    })
    .passthrough(),
  /** A connection through egress-gate, with the turns running as it opened (D67). */
  "agent.egress": EgressConnectionPayloadSchema,
  /** A trigger fired, or was run by hand: the run and what came of it (`TriggerRunSchema`). */
  "agent.run": z
    .object({
      runId: z.string(),
      triggerId: z.string(),
      dueAt: z.string(),
      late: z.boolean(),
      status: z.string(),
      reason: z.string().optional(),
      sessionId: z.string().optional(),
    })
    .passthrough(),
  "agent.trigger_paused": z.object({ triggerId: z.string(), reason: z.string() }).passthrough(),
  "agent.trigger_resumed": z.object({ triggerId: z.string() }).passthrough(),
  /** A webhook trigger's signing secret was made or replaced; the one before stopped working. */
  "agent.trigger_secret_rotated": z.object({ triggerId: z.string() }).passthrough(),
} as const satisfies Record<AgentEventType, z.ZodType>;


export type AgentEventPayload<T extends AgentEventType> = z.infer<(typeof AGENT_EVENT_PAYLOADS)[T]>;
/** One lifecycle event on an Agent's stream, numbered from 0. */
export const AgentEventSchema = z
  .object({
    schema: z.literal(AGENT_EVENT_SCHEMA),
    eventId: z.string(),
    tenantId: z.string(),
    agentId: z.string(),
    seq: z.number().int().nonnegative(),
    time: z.string(),
    type: z.enum(AGENT_EVENT_TYPES),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type AgentEvent = z.infer<typeof AgentEventSchema>;
export const ListAgentEventsResponseSchema = z
  .object({ events: z.array(AgentEventSchema) })
  .strict();

/**
 * `PUT /v1/sessions/{id}` (protocol 16): the session's Agent, owner and info. The session runs on
 * the Agent for its life (its sandbox, its vault's credentials) and pins the manifest version the
 * Agent runs when it opens. No session is special (D71): an app that keeps one conversation
 * going reuses its id.
 */
export const PutSessionRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    /** The Agent the session runs on. Fixed once the session exists. */
    agent: AgentIdSchema,
    ownerUserId: z.string().min(1),
    info: jsonObject.optional(),
  })
  .strict();
export type PutSessionRequest = z.infer<typeof PutSessionRequestSchema>;
/** The hosts a harness can run on (blueprint D38). */
export const PLACEMENT_HOSTS = ["harness-container", "sandbox"] as const;
export type PlacementHost = (typeof PLACEMENT_HOSTS)[number];

/**
 * A Tenant's Environment settings (Tenant setting `environments.config`): the limits every
 * Environment's recipe must fit, the pods' stop grace, and where harnesses may run.
 */
export const TenantEnvironmentsConfigSchema = z
  .object({
    limits: z
      .object({
        /** Hosts an Environment may allow. Default: package registries and code hosts. */
        network: z.array(hostPatternSchema).optional(),
        /** The most an Environment may ask for. */
        resources: resourcesSchema.optional(),
        /** What an Environment gets when it asks for nothing. */
        defaultResources: resourcesSchema.optional(),
        /** Stop compute after this long without use; an Environment's `lifecycle.idle` is at most this. */
        idle: durationSchema("limits.idle").optional(),
        /** The most Environments the Tenant may hold. Default 100. */
        environments: z.number().int().min(0).optional(),
      })
      .strict()
      .optional(),
    /** Pods: how long a pod has to stop. Read at every timer. */
    lifecycle: z
      .object({
        /** The pod's grace period to stop (its `terminationGracePeriodSeconds`). Default 10s. */
        stopGrace: durationSchema("lifecycle.stopGrace").optional(),
      })
      .strict()
      .optional(),
    /**
     * Where each harness may run (blueprint D38), by harness id (`nylorun`, or `*` for the rest):
     * `harness-container` (the Runtime's harness) and `sandbox` (the engine in a pod).
     * Default `{ "*": { hosts: ["harness-container", "sandbox"] } }`. Checked when a session
     * opens; a host left out is refused (`placement_refused`). `"*": { hosts: [] }` refuses every
     * harness the map does not name.
     */
    placement: z
      .record(
        z.string().min(1),
        z.object({ hosts: z.array(z.enum(PLACEMENT_HOSTS)) }).strict(),
      )
      .optional(),
  })
  .strict();
export type TenantEnvironmentsConfig = z.infer<typeof TenantEnvironmentsConfigSchema>;
/** `PUT /v1/tenant/sandbox`: replaces the Tenant's Environment settings (`environments.config`). */
export const PutTenantEnvironmentsRequestSchema = TenantEnvironmentsConfigSchema.extend({
  requestId: RequestIdSchema.optional(),
}).strict();
export type PutTenantEnvironmentsRequest = z.infer<typeof PutTenantEnvironmentsRequestSchema>;
const vaultWriteBase = {
  requestId: RequestIdSchema,
  idempotencyKey: IdempotencyKeySchema,
};
/** An RFC 9110 field name. */
export const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const CredentialHeaderNameSchema = z
  .string()
  .regex(HEADER_NAME_PATTERN, "A header name is an RFC 9110 token");
/** A credential header's value: no CR, LF or NUL. */
const CredentialHeaderValueSchema = z
  .string()
  .min(1)
  .refine((value) => !/[\r\n\0]/.test(value), "A header value has no CR, LF or NUL");
/** A `headers` credential's map (Q6): one or more headers sent on every request. */
const CredentialHeadersSchema = z
  .record(CredentialHeaderNameSchema, CredentialHeaderValueSchema)
  .refine((value) => Object.keys(value).length > 0, "At least one header is required")
  .refine(
    (value) => new Set(Object.keys(value).map((name) => name.toLowerCase())).size === Object.keys(value).length,
    "Header names are case-insensitive: each may appear once",
  );
/** A loopback host as a URL's `hostname` names it: plain `http` reaches only these. */
export const LOOPBACK_HOSTS = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;
/**
 * `via` (R2b C2, Q11): where this installation reaches the credential's server, such as a
 * gateway's endpoint for it. An absolute `https` URL (`http` only to a loopback host), with no
 * userinfo, query string or fragment. Credentials are still matched by the URL the manifest
 * names; `via` changes only where the request goes.
 */
export const CredentialViaSchema = z.string().superRefine((value, ctx) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: "custom", message: "via must be an absolute URL" });
    return;
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.test(url.hostname)))
    ctx.addIssue({ code: "custom", message: "via must be https (http only to a loopback host)" });
  if (url.username || url.password)
    ctx.addIssue({ code: "custom", message: "via may not carry userinfo" });
  if (url.search || value.includes("?"))
    ctx.addIssue({ code: "custom", message: "via may not carry a query string" });
  if (url.hash || value.includes("#"))
    ctx.addIssue({ code: "custom", message: "via may not carry a fragment" });
});
/**
 * The identity header (R2b C2, Q1–Q3): each request carries the session owner's subject in
 * `header`, for a gateway that keeps each person's accounts. A session with no person as its
 * owner (the reserved `installation`) sends none.
 */
export const CredentialIdentitySchema = z.object({ header: CredentialHeaderNameSchema }).strict();
export type CredentialIdentity = z.infer<typeof CredentialIdentitySchema>;
/** Where a credential's requests go, and whom they name. Neither is secret. */
const credentialRouting = {
  via: CredentialViaSchema.optional(),
  identity: CredentialIdentitySchema.optional(),
};
/** On rotate: absent keeps the current value, `null` removes it. */
const credentialRoutingChange = {
  via: CredentialViaSchema.nullable().optional(),
  identity: CredentialIdentitySchema.nullable().optional(),
};
export const RESERVED_ENVIRONMENT_NAMES: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "PWD",
  "SHELL",
  "USER",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "AWS_CA_BUNDLE",
]);
export function isReservedEnvironmentName(name: string): boolean {
  const upper = name.toUpperCase();
  return RESERVED_ENVIRONMENT_NAMES.has(upper) || upper.startsWith("NYLORUN_");
}
const EnvironmentNameSchema = z
  .string()
  .regex(ENVIRONMENT_NAME_PATTERN, "An environment variable name is a letter or _ followed by letters, digits or _")
  .refine((name) => !isReservedEnvironmentName(name), "That environment variable name is reserved");
/**
 * The value a sandbox sees for every `environment_secret` (R2c, D50): never the secret. Word
 * characters only, so CLIs that check a token's format before sending it (the Vercel CLI
 * refuses anything matching `\W`) still send the request egress-gate sets the header on.
 */
export const ENVIRONMENT_SECRET_SENTINEL = "nylorun_managed";
/**
 * How egress-gate writes an `environment_secret` into a request (R2c, D50): one header, set on
 * every request to a bound host. `format` is text with `{value}` once, optionally inside a
 * `{base64:…}` group, for example `Bearer {value}` (the default),
 * `Basic {base64:x-access-token:{value}}` or `{value}`.
 */
export const ENVIRONMENT_SECRET_DEFAULT_INJECT = { header: "Authorization", format: "Bearer {value}" } as const;
const BASE64_GROUP = /\{base64:((?:[^{}]|\{value\})*)\}/g;
export function isInjectFormat(format: string): boolean {
  if (/[\r\n\0]/.test(format)) return false;
  const values = format.match(/\{value\}/g)?.length ?? 0;
  const rest = format.replace(BASE64_GROUP, (_, inner: string) => inner.replace(/\{value\}/g, "")).replace(/\{value\}/g, "");
  return values === 1 && !/[{}]/.test(rest);
}
/** `format` with `{value}` replaced, and each `{base64:…}` group encoded. */
export function renderInjectFormat(format: string, value: string): string {
  return format
    .replace(BASE64_GROUP, (_, inner: string) => base64Utf8(inner.replace(/\{value\}/g, () => value)))
    .replace(/\{value\}/g, () => value);
}
function base64Utf8(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
export const EnvironmentSecretInjectSchema = z
  .object({
    header: CredentialHeaderNameSchema,
    format: z.string().min(1).refine(isInjectFormat, "format has {value} exactly once, optionally inside one {base64:…} group"),
  })
  .strict();
export type EnvironmentSecretInject = z.infer<typeof EnvironmentSecretInjectSchema>;
/** Exact host names an `environment_secret` may be sent to: no wildcards, no IP literals. */
const AllowedHostsSchema = z
  .array(
    z
      .string()
      .toLowerCase()
      .refine(
        (host) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) && !/^\d+(\.\d+){3}$/.test(host),
        "allowedHosts takes exact host names such as api.github.com: no wildcard, port or IP address",
      ),
  )
  .min(1)
  .refine((hosts) => new Set(hosts).size === hosts.length, "allowedHosts lists each host once");
/** At most the Tenant's Runtime limit `secretValueChars`, checked when it is written. */
const EnvironmentValueSchema = z
  .string()
  .min(1)
  .refine((value) => !/[\r\n\0]/.test(value), "A value has no CR, LF or NUL");

/**
 * The name of a credential for a tool (`bearer` or `headers`): a label of 1–64 characters.
 * An identifier's grammar is the protocol's (B15): it crosses the Runtime API, tokens and grants
 * and means the same in every installation, so its length is a constant of protocol 15, not a
 * setting.
 */
export const TOOL_SECRET_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
/**
 * `PUT /v1/agents/{agentId}/secrets/{name}` (D56): creates or replaces one credential
 * in the Environment's vault. For `environment_secret` and `environment_variable` the name is
 * the variable's name (a POSIX name, not reserved); for `bearer` and `headers` it is a label.
 * The same name and type keeps the credential and re-seals its value and binding; another type
 * replaces it. Values are write-only: no route reads them back. Two `environment_secret`
 * credentials bound to one host, or two `bearer`/`headers` credentials for one URL, are
 * `409 credential_conflict`.
 */
export const PutAgentSecretRequestSchema = z.discriminatedUnion("type", [
  z
    .object({
      requestId: RequestIdSchema.optional(),
      type: z.literal("environment_secret"),
      value: EnvironmentValueSchema,
      allowedHosts: AllowedHostsSchema,
      inject: EnvironmentSecretInjectSchema.optional(),
    })
    .strict(),
  z
    .object({
      requestId: RequestIdSchema.optional(),
      type: z.literal("environment_variable"),
      value: EnvironmentValueSchema,
    })
    .strict(),
  z
    .object({
      requestId: RequestIdSchema.optional(),
      type: z.literal("bearer"),
      url: z.string().min(1),
      value: z.string().min(1),
      ...credentialRouting,
    })
    .strict(),
  z
    .object({
      requestId: RequestIdSchema.optional(),
      type: z.literal("headers"),
      url: z.string().min(1),
      headers: CredentialHeadersSchema,
      ...credentialRouting,
    })
    .strict(),
]);
export type PutAgentSecretRequest = z.infer<typeof PutAgentSecretRequestSchema>;
/**
 * A secret write on an Environment whose manifest declares the secret's slot (D64): only the
 * value, `value` (or `headers` for a `headers` slot). Its type and binding come from the slot.
 */
export const PutAgentSecretValueRequestSchema = z
  .object({
    requestId: RequestIdSchema.optional(),
    value: z.string().min(1).optional(),
    headers: CredentialHeadersSchema.optional(),
  })
  .strict()
  .refine((body) => (body.value === undefined) !== (body.headers === undefined), {
    message: "Send value, or headers for a headers secret",
  });
export type PutAgentSecretValueRequest = z.infer<typeof PutAgentSecretValueRequestSchema>;
/** Whether `name` may name a secret of `type` (`PUT .../secrets/{name}`); a message when not. */
export function environmentSecretNameError(
  type: PutAgentSecretRequest["type"],
  name: string,
): string | undefined {
  if (type === "environment_secret" || type === "environment_variable") {
    if (!ENVIRONMENT_NAME_PATTERN.test(name))
      return "An environment variable name is a letter or _ followed by letters, digits or _";
    if (isReservedEnvironmentName(name)) return `${name} is a reserved environment variable name`;
    return undefined;
  }
  return TOOL_SECRET_NAME_PATTERN.test(name)
    ? undefined
    : "A credential name is 1-64 letters, digits, '.', '_' and '-'";
}

// --- Environment manifests (protocol 14, D63 to D65) -----------------------------------------

const slotBase = {
  /** Whether a session whose agent needs it may open without it. Default false. */
  required: z.boolean().optional(),
  /** At most the Tenant's Runtime limit `secretDescriptionChars`, checked when the manifest is put. */
  description: z.string().optional(),
};
/**
 * One secret an Environment of a kind needs (D64): its type and binding, never its value. The
 * value is written into each Environment's vault (`PUT /v1/agents/{id}/secrets/{name}`
 * with `{ value }`, or `{ headers }` for `headers`), and the binding comes from here.
 */
export const EnvironmentSecretSlotSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("environment_secret"),
      allowedHosts: AllowedHostsSchema,
      inject: EnvironmentSecretInjectSchema.optional(),
      ...slotBase,
    })
    .strict(),
  z.object({ type: z.literal("environment_variable"), ...slotBase }).strict(),
  z.object({ type: z.literal("bearer"), url: z.string().min(1), ...credentialRouting, ...slotBase }).strict(),
  z.object({ type: z.literal("headers"), url: z.string().min(1), ...credentialRouting, ...slotBase }).strict(),
]);
export type EnvironmentSecretSlot = z.infer<typeof EnvironmentSecretSlotSchema>;
/** A manifest's secret slots: at most the Tenant's Runtime limit `environmentSecretSlots`. */
export const EnvironmentSecretSlotsSchema = z
  .record(z.string(), EnvironmentSecretSlotSchema)
  .superRefine((slots, ctx) => {
    for (const name of Object.keys(slots)) {
      const error = environmentSecretNameError(slots[name]!.type, name);
      if (error) ctx.addIssue({ code: "custom", path: [name], message: error });
    }
  });
export type EnvironmentSecretSlots = z.infer<typeof EnvironmentSecretSlotsSchema>;

// --- Agent manifest v8 (protocol 16, track T2) ----------------------------------------------

/** The schema version of an agent manifest the Runtime saves at `/v1/agent-manifests/{name}`. */
export const AGENT_MANIFEST_V8_SCHEMA_VERSION = 8;
/** A skill of the harness section: v7's, and the secret slots its scripts read. */
const harnessSkillSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    files: z.record(z.string(), z.string()),
    plugin: pluginLabelSchema.optional(),
    secrets: z
      .array(z.string().regex(ENVIRONMENT_NAME_PATTERN, "A skill's secrets are environment variable names"))
      .optional(),
  })
  .strict()
  .superRefine((skill, ctx) => {
    const issue = skillFilesIssue(skill.files);
    if (issue) ctx.addIssue({ code: "custom", path: ["files"], message: `Skill '${skill.name}' ${issue}` });
  });
const harnessMcpServerFields = {
  name: modelFacingName("MCP server"),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  /** A `runtime.secrets` slot of type `bearer` or `headers` bound to `url`. */
  credential: z.string().min(1).optional(),
  ...mcpServerSettings,
};
const harnessMcpServerSchema = z.discriminatedUnion(
  "type",
  [
    z.object({ type: z.literal("streamable-http"), ...harnessMcpServerFields }).strict(),
    z.object({ type: z.literal("sse"), ...harnessMcpServerFields }).strict(),
  ],
  { error: (issue) => stdioIssue(issue.input) },
);
const harnessIdField = HarnessIdSchema.optional().meta({
  description: "The harness that runs the loop: `nylorun` (ours, the default) or a custom harness's id",
});
const harnessLoopField = definitionJson
  .optional()
  .meta({ description: "The harness's own settings, passed to it in turn.start; the Runtime never reads them" });
/**
 * `harness.memory` (track T5, D72): turns the Agent's memory on. Its `access` holds in every turn,
 * whoever starts it; `instructions` follow the engine's own memory rules.
 */
const harnessMemoryField = z
  .strictObject({
    access: z.enum(MEMORY_ACCESS).optional().meta({ description: "`read_write` (the default) or `read_only`" }),
    instructions: z
      .string()
      .max(MEMORY_INSTRUCTIONS_MAX)
      .optional()
      .meta({ description: "What this agent should remember, after the engine's own memory rules" }),
  })
  .optional()
  .meta({ description: "The Agent's memory: Markdown files under /memories it keeps across sessions (D72)" });
/** Fields the harness section refuses with where they went. */
const REMOVED_HARNESS_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  requires:
    "harness.requires left the API in agent manifest v8: the Runtime checks the harness against the runtime section when the manifest is saved. Keep requires in harness.manifest.json, where the CLI checks it",
  manifestSchemaVersion: "manifestSchemaVersion belongs at the top of the agent manifest, not in harness",
  name: "name belongs at the top of the agent manifest, not in harness",
  description: "description belongs at the top of the agent manifest, not in harness",
  metadata: "metadata belongs at the top of the agent manifest, not in harness",
  approval: "Tool approvals are the Tenant's tool policy (PUT /v1/tenant/tool-policy)",
});
const agentHarnessObject = z
  .strictObject(
    {
      id: harnessIdField,
      instructions: z.array(z.string()).optional(),
      tools: z.array(toolManifestSchema).optional(),
      skills: z.record(z.string(), harnessSkillSchema).optional(),
      mcpServers: z.record(z.string(), harnessMcpServerSchema).optional(),
      plugins: z.array(pluginLabelSchema).optional(),
      outputSchema: definitionJson.optional(),
      loop: harnessLoopField,
      memory: harnessMemoryField,
      functions: z.unknown().optional().meta({ description: "Reserved: Functions are not available yet" }),
    },
    { error: removedFieldError(REMOVED_HARNESS_FIELDS) },
  )
  .superRefine((harness, ctx) => {
    if (harness.functions !== undefined)
      ctx.addIssue({ code: "custom", path: ["functions"], message: "Functions are not available yet" });
    delegationIssues({ tools: harness.tools } as AgentManifest, (message) => ctx.addIssue({ code: "custom", message }));
    const names = new Set<string>();
    for (const tool of harness.tools ?? []) {
      if (tool.name.includes("__"))
        ctx.addIssue({
          code: "custom",
          message: `Tool '${tool.name}' must not contain '__', which names an MCP server's tools`,
        });
      if (names.has(tool.name)) ctx.addIssue({ code: "custom", message: "Tool names must be unique" });
      names.add(tool.name);
    }
    if (harness.skills && Object.keys(harness.skills).length === 0)
      ctx.addIssue({ code: "custom", message: "harness.skills must be omitted when the agent has no skills" });
    for (const [key, skill] of Object.entries(harness.skills ?? {}))
      if (key !== skill.name)
        ctx.addIssue({ code: "custom", message: `harness.skills key '${key}' must equal the skill name` });
    if (harness.mcpServers && Object.keys(harness.mcpServers).length === 0)
      ctx.addIssue({ code: "custom", message: "harness.mcpServers must be omitted when the agent has no servers" });
    for (const [key, server] of Object.entries(harness.mcpServers ?? {}))
      if (key !== server.name)
        ctx.addIssue({ code: "custom", message: `harness.mcpServers key '${key}' must equal the server name` });
  });
const workflowHarnessObject = z
  .object({
    kind: z.literal("workflow"),
    id: harnessIdField,
    inputSchema: definitionJson.optional(),
    outputSchema: definitionJson.optional(),
    root: workflowNodeSchema,
    agents: z.record(z.string().min(1), z.union([workflowManifestSchema, AgentManifestSchema])),
    plugins: z.array(pluginLabelSchema).optional(),
    loop: harnessLoopField,
  })
  .strict()
  .superRefine((flow, ctx) => {
    if (flow.id !== undefined && flow.id !== DEFAULT_HARNESS)
      ctx.addIssue({ code: "custom", path: ["id"], message: `A flow runs in our harness: harness.id must be ${DEFAULT_HARNESS} or left out` });
    for (const agentId of referencedAgents(flow.root))
      if (!(agentId in flow.agents))
        ctx.addIssue({
          code: "custom",
          path: ["agents"],
          message: `Agent '${agentId}' is used in the flow but not embedded in agents`,
        });
    for (const [key, agent] of Object.entries(flow.agents))
      if (agent.id !== key)
        ctx.addIssue({ code: "custom", path: ["agents", key], message: `Embedded agent '${agent.id}' must be keyed by its id` });
  });
/** What runs inside the loop of an agent: the `harness` section of agent manifest v8. */
export const AgentHarnessSectionSchema: z.ZodType<AgentHarnessSection> = agentHarnessObject.meta({
  id: "AgentHarnessSection",
});
/** A flow's `harness` section (`kind: "workflow"`). */
export const WorkflowHarnessSectionSchema: z.ZodType<WorkflowHarnessSection> = workflowHarnessObject.meta({
  id: "WorkflowHarnessSection",
});
/** The `harness` section: an agent's loop, or a flow (`kind: "workflow"`). */
export const HarnessSectionSchema = z.union([WorkflowHarnessSectionSchema, AgentHarnessSectionSchema]);
type _AgentHarnessDrift = AssertNoDrift<ManifestDrift<AgentHarnessSection, z.output<typeof agentHarnessObject>>>;
type _WorkflowHarnessDrift = AssertNoDrift<ManifestDrift<WorkflowHarnessSection, z.output<typeof workflowHarnessObject>>>;
type _HarnessSkillDrift = AssertNoDrift<ManifestDrift<HarnessSkill, z.output<typeof harnessSkillSchema>>>;
type _HarnessMcpServerDrift = AssertNoDrift<ManifestDrift<HarnessMcpServer, z.output<typeof harnessMcpServerSchema>>>;

/**
 * A trigger's id in `runtime.triggers` (track T4, D74): 1–64 letters, digits, `.`, `_` and `-`,
 * starting with a letter or digit. The map key; it names the trigger in routes and runs.
 */
export const TriggerIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, {
    message: "A trigger id is 1-64 letters, digits, '.', '_' and '-', starting with a letter or digit",
  })
  .meta({ description: "A trigger's id, such as `hourly-check`" });

/** The signature schemes a webhook trigger verifies (D75): Standard Webhooks only in T4. */
export const WEBHOOK_SCHEMES = ["standard-webhooks"] as const;

/**
 * One trigger of an agent manifest's `runtime.triggers` (track T4, D74): exactly one of
 * `schedule` (five-field cron, minute granularity, in `timezone`, an IANA name, default UTC), `at`
 * (one run at an RFC 3339 time with an offset) or `webhook` (a webhook endpoint verified with the
 * named scheme), plus the `session` each run goes to and the author's `prompt`.
 *
 * `session` is a session id of the Agent, opened on the trigger's first run if it does not
 * exist, or `"new"` for a new session per run (`run-<runId>`). The Runtime keeps no main session
 * (D71). The cron's smallest gap, the `at` time, the prompt's length and how many triggers a
 * manifest holds are checked against the Tenant's Runtime limits when it is saved.
 */
export const TriggerSchema = z
  .strictObject({
    schedule: z
      .string()
      .regex(/^\S+(\s+\S+){4}$/, { message: "schedule is five cron fields: minute hour day-of-month month day-of-week" })
      .optional(),
    timezone: z.string().min(1).optional(),
    at: z.iso.datetime({ offset: true, message: "at is an RFC 3339 time with an offset, such as 2026-11-01T09:00:00+05:30" }).optional(),
    webhook: z.enum(WEBHOOK_SCHEMES).optional(),
    session: z.string().min(1).max(200),
    prompt: z.string().min(1),
  })
  .superRefine((trigger, ctx) => {
    const kinds = [trigger.schedule, trigger.at, trigger.webhook].filter((value) => value !== undefined);
    if (kinds.length !== 1)
      ctx.addIssue({ code: "custom", message: "A trigger has exactly one of schedule, at or webhook" });
    if (trigger.timezone !== undefined && trigger.schedule === undefined)
      ctx.addIssue({ code: "custom", path: ["timezone"], message: "timezone goes with schedule" });
  })
  .meta({ id: "Trigger" });
export type Trigger = z.infer<typeof TriggerSchema>;
/** What a trigger is: the field it has, or `wake` for a session's own booking (D77). */
export const TRIGGER_KINDS = ["schedule", "at", "webhook", "wake"] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];
/** A trigger's kind, from its manifest entry. */
export function triggerKindOf(trigger: Trigger): Exclude<TriggerKind, "wake"> {
  return trigger.schedule !== undefined ? "schedule" : trigger.at !== undefined ? "at" : "webhook";
}

/**
 * A trigger's status on an Agent (D74): `active` fires, `paused` does not (`pausedReason`
 * `manual`, or `new` for one an upgrade added), `completed` is an `at` that ran.
 */
export const TRIGGER_STATUSES = ["active", "paused", "completed"] as const;
/** `GET /v1/agents/{id}/triggers`: one trigger, from its manifest entry and the Agent's state. */
export const TriggerViewSchema = z
  .object({
    id: z.string(),
    kind: z.enum(TRIGGER_KINDS),
    status: z.enum(TRIGGER_STATUSES),
    pausedReason: z.string().nullable(),
    schedule: z.string().optional(),
    timezone: z.string().optional(),
    at: z.string().optional(),
    /** The session each run goes to: a session id, or `new`. */
    session: z.string(),
    /** When it fires next, or `null` while paused or completed. */
    nextRunAt: z.string().nullable(),
    lastRunAt: z.string().nullable(),
    /**
     * A webhook trigger's endpoint (D75): `POST` Standard Webhooks deliveries to it. The origin is
     * the one this read reached.
     */
    webhookUrl: z.string().optional(),
    /** Whether a webhook trigger has a signing secret (`POST .../secret` makes one). */
    secretSet: z.boolean().optional(),
  })
  .strict();
export type TriggerView = z.infer<typeof TriggerViewSchema>;
export const TriggerListSchema = z.object({ triggers: z.array(TriggerViewSchema) }).strict();
/**
 * What a run came to (D74): `started` a turn, `queued` a message behind a running turn,
 * `skipped` (nothing started: `overlap`, `rate_limited`, `paused`) or `failed` (`queue_full`,
 * `session_conflict`, `agent_unavailable`).
 */
export const TRIGGER_RUN_STATUSES = ["started", "queued", "skipped", "failed"] as const;
/** One run: a trigger fired, or was run by hand. */
export const TriggerRunSchema = z
  .object({
    id: z.string(),
    triggerId: z.string(),
    kind: z.enum(TRIGGER_KINDS),
    /** When it was due; for a run by hand or a webhook, when it arrived. */
    dueAt: z.string(),
    firedAt: z.string(),
    /** Fired more than the Host's `triggers.lateGraceMs` after it was due (after downtime). */
    late: z.boolean(),
    status: z.enum(TRIGGER_RUN_STATUSES),
    reason: z.string().nullable(),
    sessionId: z.string().nullable(),
    turnId: z.string().nullable(),
    queuedMessageId: z.string().nullable(),
  })
  .strict();
export type TriggerRun = z.infer<typeof TriggerRunSchema>;
/** `GET /v1/agents/{id}/runs`: runs, newest first. */
export const TriggerRunPageSchema = z
  .object({ runs: z.array(TriggerRunSchema), nextCursor: z.string().nullable() })
  .strict();
export type TriggerRunPage = z.infer<typeof TriggerRunPageSchema>;
/**
 * `POST /v1/agents/{id}/triggers/{triggerId}/secret` (D75): a webhook trigger's new signing secret,
 * in the Standard Webhooks format (`whsec_` and 32 random bytes in base64), shown this once. It
 * replaces the one before at once.
 */
export const WebhookSecretResponseSchema = z
  .object({ triggerId: z.string(), webhookUrl: z.string(), secret: z.string() })
  .strict();
/** `POST /v1/webhooks/{endpointId}`: the run a delivery made, or the run a repeated delivery made. */
export const WebhookAcceptedResponseSchema = z
  .object({ runId: z.string(), status: z.enum(TRIGGER_RUN_STATUSES), reason: z.string().nullable() })
  .strict();
/** `POST /v1/agents/{id}/triggers/{triggerId}/run`: the run it made. */
export const RunTriggerResponseSchema = z.object({ run: TriggerRunSchema }).strict();

/**
 * One of an Agent's memories (track T5, D72), as `GET /v1/agents/{id}/memories` lists it: its
 * path under `/memories`, size, content hash (the precondition a `PUT` may send), the
 * `description` of its frontmatter when it has one, and its version, which every change bumps.
 */
export const MemorySummarySchema = z
  .object({
    path: z.string(),
    bytes: z.number().int().nonnegative(),
    contentSha256: z.string(),
    description: z.string().nullable(),
    version: z.number().int().positive(),
    updatedAt: z.string(),
  })
  .strict();
export type MemorySummary = z.infer<typeof MemorySummarySchema>;
/** `GET /v1/agents/{id}/memories`: memories by path. */
export const MemoryListSchema = z
  .object({ memories: z.array(MemorySummarySchema), nextCursor: z.string().nullable() })
  .strict();
export type MemoryList = z.infer<typeof MemoryListSchema>;
/** `GET /v1/agents/{id}/memories/{path}`: one memory with its content. */
export const MemorySchema = MemorySummarySchema.extend({ content: z.string() }).strict();
export type Memory = z.infer<typeof MemorySchema>;
/**
 * `PUT /v1/agents/{id}/memories/{path}`: the memory's whole content, creating it or replacing it.
 * With `contentSha256`, the write applies only while the memory's content still has that hash
 * (`409 memory_conflict` with the current text otherwise); an empty string requires that no
 * memory has the path.
 */
export const PutMemoryRequestSchema = z
  .object({
    content: z.string(),
    contentSha256: z.string().optional(),
  })
  .strict();
export type PutMemoryRequest = z.infer<typeof PutMemoryRequestSchema>;
/**
 * One change to a memory: what changed it (`create`, `str_replace`, `insert`, `delete`,
 * `rename`), the content it left (`null` for a delete), and who made it: `agent:<manifest>@<n>`
 * for a turn, with its session, turn and trigger run, or the principal of an API call. A rename's
 * version is on the new path and names the old one in `fromPath`.
 */
export const MemoryVersionSchema = z
  .object({
    id: z.string(),
    path: z.string(),
    fromPath: z.string().nullable(),
    operation: z.enum(MEMORY_OPERATIONS),
    bytes: z.number().int().nonnegative().nullable(),
    contentSha256: z.string().nullable(),
    actor: z.string(),
    sessionId: z.string().nullable(),
    turnId: z.string().nullable(),
    triggerRunId: z.string().nullable(),
    createdAt: z.string(),
  })
  .strict();
export type MemoryVersion = z.infer<typeof MemoryVersionSchema>;
/** `GET /v1/agents/{id}/memory_versions/{versionId}`: one version with the content it left. */
export const MemoryVersionDetailSchema = MemoryVersionSchema.extend({ content: z.string().nullable() })
  .strict();
export type MemoryVersionDetail = z.infer<typeof MemoryVersionDetailSchema>;
/** `GET /v1/agents/{id}/memory_versions`: versions, newest first. */
export const MemoryVersionPageSchema = z
  .object({ versions: z.array(MemoryVersionSchema), nextCursor: z.string().nullable() })
  .strict();
export type MemoryVersionPage = z.infer<typeof MemoryVersionPageSchema>;

/**
 * What the Runtime provides around the loop: the `runtime` section of agent manifest v8, with
 * environment manifest v1's fields but its identity and its `harness` (now `harness.id`).
 * `triggers` (track T4, D74) start the Agent's turns with no client connected; `selfWake` offers
 * the agent `schedule_wake`, which books its session's next turn (D77).
 */
const runtimeSectionObject = z
  .strictObject(
    {
      kind: z.enum(ENVIRONMENT_KINDS, {
        error: () => `runtime.kind is required: ${ENVIRONMENT_KINDS.join(", ")}`,
      }),
      image: runtimeFields.image,
      resources: runtimeFields.resources,
      storage: runtimeFields.storage,
      network: runtimeFields.network,
      lifecycle: runtimeFields.lifecycle,
      setup: runtimeFields.setup,
      files: runtimeFields.files,
      limits: runtimeFields.limits,
      secrets: EnvironmentSecretSlotsSchema.optional(),
      triggers: z
        .record(TriggerIdSchema, TriggerSchema)
        .optional()
        .meta({ description: "What starts the Agent's turns with no client connected, by trigger id (D74)" }),
      selfWake: z
        .boolean()
        .optional()
        .meta({ description: "Offer the agent schedule_wake: it books its session's next turn itself (D77)" }),
    },
    { error: removedFieldError(REMOVED_RUNTIME_SECTION_FIELDS) },
  )
  .meta({ id: "RuntimeSection" });
export const RuntimeSectionSchema = runtimeSectionObject;
export type RuntimeSection = z.infer<typeof RuntimeSectionSchema>;

/**
 * Agent manifest v8 (protocol 16, track T2): one versioned document with what runs inside the
 * agent loop (`harness`) and what the Runtime provides around it (`runtime`), saved at
 * `PUT /v1/agent-manifests/{name}`. Without `runtime`, an Agent made from it is kind `none`.
 * The Runtime also checks the two sections against each other when it is saved (`sectionGaps`).
 */
export const AgentManifestV8Schema = z
  .object({
    manifestSchemaVersion: z.literal(AGENT_MANIFEST_V8_SCHEMA_VERSION, {
      error: (issue) => agentManifestVersionIssue(issue.input),
    }),
    name: AgentManifestNameSchema,
    /** At most the Tenant's Runtime limit `manifestDescriptionChars`, checked when it is saved. */
    description: z.string().optional(),
    metadata: definitionJson.optional(),
    harness: HarnessSectionSchema,
    runtime: RuntimeSectionSchema.optional(),
  })
  .strict()
  .meta({ id: "AgentManifestV8" });
export type AgentManifestV8 = z.infer<typeof AgentManifestV8Schema>;

/**
 * `harness.manifest.json`, an authoring file `nylorun apply` and the SDK's `composeManifest`
 * read: the harness section, whose `skills`, `mcpServers` and `plugins` may be paths relative to
 * the file, with a `credentials` map from MCP server or HTTP tool names to `runtime.secrets`
 * slots, and `requires`, a portable contract the composer checks against the runtime section.
 * The API never sees it.
 */
export const HARNESS_MANIFEST_FILE_SCHEMA_VERSION = 1;
const pathField = (what: string) => z.string().min(1).meta({ description: `A path to ${what}, relative to this file` });
export const HarnessManifestFileSchema = z
  .object({
    $schema: z.string().optional(),
    id: harnessIdField,
    instructions: z.array(z.string()).optional(),
    tools: z.array(toolManifestSchema).optional(),
    skills: z
      .union([pathField("a folder of skill folders"), z.record(z.string(), harnessSkillSchema)])
      .optional(),
    mcpServers: z
      .union([pathField("an mcp.json file"), z.record(z.string(), harnessMcpServerSchema)])
      .optional(),
    plugins: z.array(z.union([pathField("an Agent Plugin folder"), pluginLabelSchema])).optional(),
    outputSchema: definitionJson.optional(),
    loop: harnessLoopField,
    memory: harnessMemoryField,
    /** MCP server or HTTP tool name → the `runtime.secrets` slot it authenticates with. */
    credentials: z.record(z.string().min(1), z.string().min(1)).optional(),
    /** What this harness needs of any runtime it is combined with; checked by the composer only. */
    requires: agentRequirementsSchema.optional(),
  })
  .strict();
export type HarnessManifestFile = z.infer<typeof HarnessManifestFileSchema>;
/** `runtime.manifest.json`: the runtime section as a file, often shared by many agents. */
export const RUNTIME_MANIFEST_FILE_SCHEMA_VERSION = 1;
export const RuntimeManifestFileSchema = runtimeSectionObject.extend({
  $schema: z.string().optional(),
  /** Also `{ path, from }`: a folder beside the file that the composer uploads by hash as `{ path, files }`. */
  files: z
    .array(
      z.union([
        EnvironmentFileSchema,
        z.object({ path: z.string().min(1), from: z.string().min(1) }).strict(),
      ]),
    )
    .optional(),
});
export type RuntimeManifestFile = z.infer<typeof RuntimeManifestFileSchema>;
/**
 * `agent.manifest.json`: an agent manifest v8 whose `harness` and `runtime` may each be a path to
 * an authoring file (or inline). The composer resolves both and sends one document.
 */
export const AgentManifestFileSchema = z
  .object({
    $schema: z.string().optional(),
    manifestSchemaVersion: z.literal(AGENT_MANIFEST_V8_SCHEMA_VERSION, {
      error: (issue) => agentManifestVersionIssue(issue.input),
    }),
    name: AgentManifestNameSchema,
    description: z.string().optional(),
    metadata: definitionJson.optional(),
    harness: z.union([pathField("a harness.manifest.json file"), HarnessManifestFileSchema, WorkflowHarnessSectionSchema]),
    runtime: z.union([pathField("a runtime.manifest.json file"), RuntimeManifestFileSchema]).optional(),
  })
  .strict();
export type AgentManifestFile = z.infer<typeof AgentManifestFileSchema>;


/** `PUT /v1/agent-manifests/{name}`: the manifest, whose `name` is the path's. */
export const PutAgentManifestRequestSchema = AgentManifestV8Schema.extend({
  requestId: RequestIdSchema.optional(),
}).strict();
export type PutAgentManifestRequest = z.infer<typeof PutAgentManifestRequestSchema>;
/** Who saved a version: the subject a request acted for, else `application`. */
export const AgentManifestSavedBySchema = z.object({ actor: z.string() }).strict();
/** One version of an agent manifest. */
export const AgentManifestViewSchema = z
  .object({
    name: z.string(),
    version: z.number().int().positive(),
    /** The hash of `manifest`: equal manifests have equal hashes. */
    hash: z.string(),
    manifest: AgentManifestV8Schema,
    savedBy: AgentManifestSavedBySchema,
    createdAt: z.string(),
    /** How many Agents were made from this version. */
    agents: z.number().int().nonnegative(),
  })
  .strict();
export type AgentManifestView = z.infer<typeof AgentManifestViewSchema>;
/** `GET /v1/agent-manifests`: each manifest's latest version, by name. */
export const ListAgentManifestsResponseSchema = z
  .object({ manifests: z.array(AgentManifestViewSchema) })
  .strict();
export type ListAgentManifestsResponse = z.infer<typeof ListAgentManifestsResponseSchema>;
/** `GET /v1/agent-manifests/{name}/versions`: every version, newest first. */
export const AgentManifestVersionsSchema = z
  .object({
    name: z.string(),
    latest: z.number().int().positive(),
    versions: z.array(
      z
        .object({
          version: z.number().int().positive(),
          hash: z.string(),
          savedBy: AgentManifestSavedBySchema,
          createdAt: z.string(),
          agents: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();
export type AgentManifestVersions = z.infer<typeof AgentManifestVersionsSchema>;
/** Something a save would do that the saver should know: never a refusal. */
export const AgentManifestWarningSchema = z
  .object({ code: z.string(), message: z.string() })
  .strict();
export type AgentManifestWarning = z.infer<typeof AgentManifestWarningSchema>;
/** One field a save changes, by its section and its path in it. */
export const AgentManifestChangeSchema = z
  .object({
    /** `harness`, `runtime`, or `manifest` for the top-level fields. */
    section: z.enum(["manifest", "harness", "runtime"]),
    path: z.string(),
    op: z.enum(["add", "remove", "replace"]),
    from: z.unknown().optional(),
    to: z.unknown().optional(),
  })
  .strict();
export type AgentManifestChange = z.infer<typeof AgentManifestChangeSchema>;
/**
 * `PUT /v1/agent-manifests/{name}?dryRun=true`: what saving it would do, with nothing saved.
 * `errors` lists every reason the Runtime would refuse it: the gaps between its sections, the
 * Tenant's limits, its files; a save with errors is refused. A save moves every Agent that tracks
 * the manifest (track T3): `moves` counts them by when the new version applies. `behind` counts
 * the Agents that stay on an older version: pinned ones, and tracking ones it cannot move.
 */
export const AgentManifestPlanSchema = z
  .object({
    name: z.string(),
    /** The latest version now, or `null` for a new manifest. */
    from: z.number().int().positive().nullable(),
    /** The version a save would answer: `from` when nothing changed. */
    to: z.number().int().positive(),
    unchanged: z.boolean(),
    changes: z.array(AgentManifestChangeSchema),
    warnings: z.array(AgentManifestWarningSchema),
    errors: z.array(z.string()),
    behind: z.number().int().nonnegative(),
    /** The tracking Agents a save moves: at once, at their pod's next start, once their secrets are set. */
    moves: z
      .object({
        now: z.number().int().nonnegative(),
        nextStart: z.number().int().nonnegative(),
        secrets: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type AgentManifestPlan = z.infer<typeof AgentManifestPlanSchema>;
/** `PUT /v1/agent-manifests/{name}`: the version saved (or the latest, unchanged). */
export const SaveAgentManifestResponseSchema = z
  .object({
    manifest: AgentManifestViewSchema,
    unchanged: z.boolean(),
    warnings: z.array(AgentManifestWarningSchema),
  })
  .strict();
export type SaveAgentManifestResponse = z.infer<typeof SaveAgentManifestResponseSchema>;
export const DeleteAgentManifestResponseSchema = z
  .object({ name: z.string(), deleted: z.boolean() })
  .strict();
export type DeleteAgentManifestResponse = z.infer<typeof DeleteAgentManifestResponseSchema>;
/**
 * `POST /v1/agents/{id}/fork` (Q15): copies an Agent, with its disk and vault, into a new one,
 * made from `manifest` (default the source's manifest at its latest version): how an Agent
 * changes what is fixed for its life (its kind, harness, storage or manifest). The source keeps
 * what it runs, its disk and its sessions.
 */
export const ForkAgentRequestSchema = z
  .object({
    requestId: RequestIdSchema.optional(),
    /** The new Agent's id. */
    id: AgentIdSchema,
    /** `name` or `name@n`; default the source's manifest name (tracking). */
    manifest: AgentManifestRefSchema.optional(),
    /** Where its disk starts: `latest` (a snapshot taken first; the default), a version, or `empty`. */
    disk: z.union([z.literal("latest"), z.literal("empty"), z.number().int().positive()]).optional(),
    /** `copy` (the default): the source's secrets the new manifest declares. */
    secrets: z.enum(["copy", "none"]).optional(),
    labels: EnvironmentLabelsSchema.optional(),
    owner: z.string().min(1).nullable().optional(),
    /** Answer the plan and make nothing. */
    dryRun: z.boolean().optional(),
  })
  .strict();
export type ForkAgentRequest = z.infer<typeof ForkAgentRequestSchema>;
/** What a fork does (or, with `dryRun`, would do). */
export const AgentForkPlanSchema = z
  .object({
    source: z.string(),
    id: z.string(),
    kind: z.enum(ENVIRONMENT_KINDS),
    /** The manifest version it is made from. */
    manifest: z.object({ name: z.string(), version: z.number().int().positive() }).strict(),
    /** The disk version it starts from: `latest` in a dry run (the snapshot is taken at the fork); `null` for an empty disk. */
    disk: z.union([z.number().int().positive(), z.literal("latest")]).nullable(),
    /** Whether the new manifest's setup runs on the copied disk: it differs from what the source runs. */
    setup: z.boolean(),
    secrets: z
      .object({
        /** Copied, by name. */
        copied: z.array(z.string()),
        /** The source's secrets the new manifest does not declare: left behind. */
        dropped: z.array(z.string()),
        /** Required slots of the new manifest no copied secret fills. */
        missing: z.array(z.string()),
      })
      .strict(),
    /** How what it runs differs from what the source runs. */
    changes: z.array(
      z.object({ path: z.string(), from: z.unknown().optional(), to: z.unknown().optional() }).strict(),
    ),
    /** The source's sessions: they stay on it. */
    sessions: z.number().int().nonnegative(),
    /** The source's memories (track T5): copied as they are now, each at version 1, with no history. */
    memories: z.number().int().nonnegative(),
  })
  .strict();
export type AgentForkPlan = z.infer<typeof AgentForkPlanSchema>;
/** `POST /v1/agents/{id}/fork`: the new Agent and the plan it ran, or with `dryRun` the plan only. */
export const ForkAgentResponseSchema = z.union([
  z.object({ dryRun: z.literal(true), plan: AgentForkPlanSchema }).strict(),
  z.object({ agent: AgentViewSchema, plan: AgentForkPlanSchema }).strict(),
]);
export type ForkAgentResponse = z.infer<typeof ForkAgentResponseSchema>;
/**
 * `PUT /v1/agents/{id}?dryRun=true` on an existing Agent (track T3): what moving it to the
 * version `manifest` names would do, with nothing changed. `applies`: `none` (it runs that
 * version), `now` (turns that start from here run it), `next_start` (a runtime change: its pod's
 * next start applies it), `secrets` (it waits for a value of each of `missingSecrets`), or
 * `refused` (`refusals` names each fixed field it would change: `409 agent_fixed_field`).
 */
export const AgentMovePlanSchema = z
  .object({
    agent: z.string(),
    manifest: z.string(),
    /** The version it runs now, and the one it would run. */
    from: z.number().int().positive(),
    to: z.number().int().positive(),
    /** How it names its manifest after the move. */
    tracking: z.enum(["tracking", "pinned"]),
    applies: z.enum(["none", "now", "next_start", "secrets", "refused"]),
    /** How the version differs from the one it runs, by section. */
    changes: z.array(
      z
        .object({
          section: z.enum(["manifest", "harness", "runtime"]),
          path: z.string(),
          op: z.enum(["add", "remove", "replace"]),
          from: z.unknown().optional(),
          to: z.unknown().optional(),
        })
        .strict(),
    ),
    /** Required secrets of the version with no value the version can use. */
    missingSecrets: z.array(z.string()),
    /** Its secrets the version does not declare: kept, and unused while it runs the version. */
    dormantSecrets: z.array(z.string()),
    /** What is fixed for its life that the version would change: kind, harness, storage. */
    refusals: z.array(
      z.object({ field: z.string(), from: z.unknown().optional(), to: z.unknown().optional() }).strict(),
    ),
    /** Its sessions: each takes the version at its next turn once it applies. */
    sessions: z.number().int().nonnegative(),
  })
  .strict();
export type AgentMovePlan = z.infer<typeof AgentMovePlanSchema>;
/**
 * `POST /v1/agents/{id}/restart` (track T3): applies a pending version now. A running pod stops,
 * so the next turn starts it on the version (a stopped one starts at once); `retry` first moves
 * it to the version that failed to start (`failedVersion`) again.
 */
export const RestartAgentRequestSchema = z
  .object({ requestId: RequestIdSchema.optional(), retry: z.boolean().optional() })
  .strict();
export type RestartAgentRequest = z.infer<typeof RestartAgentRequestSchema>;
export const PutAgentDryRunResponseSchema = z
  .object({ dryRun: z.literal(true), plan: AgentMovePlanSchema })
  .strict();
export type PutAgentDryRunResponse = z.infer<typeof PutAgentDryRunResponseSchema>;
/**
 * What a model may read (protocol 12): `text` always; `image`, `pdf`, `office` (Word, Excel,
 * PowerPoint), `audio` and `video` when its catalog entry or the operator says so. In this order.
 */
export const MODEL_INPUTS = ["text", "image", "pdf", "office", "audio", "video"] as const;
export const ModelInputSchema = z.enum(MODEL_INPUTS);
export type ModelInput = z.infer<typeof ModelInputSchema>;
/**
 * The defaults of a custom endpoint's `contextWindow` and `maxTokens` settings (and the window
 * assumed for a model the Runtime knows nothing of): small, since an early compaction beats a
 * failed call.
 */
export const CUSTOM_MODEL_SETTING_DEFAULTS = Object.freeze({ contextWindow: 32_768, maxTokens: 8_192 });
/**
 * What the Runtime cannot learn from a custom OpenAI-compatible endpoint (Model Calls §7):
 * its context window and output limit (default `CUSTOM_MODEL_SETTING_DEFAULTS`), whether it
 * reasons, what it reads (`inputs`; default text only) and pi-ai `compat` settings
 * (`thinkingFormat`, `thinkingTokenBudgetField`, `chatTemplateKwargs`, …).
 */
export const CustomModelSettingsSchema = z
  .object({
    contextWindow: z.number().int().min(1).optional(),
    maxTokens: z.number().int().min(1).optional(),
    reasoning: z.boolean().optional(),
    inputs: z.array(ModelInputSchema).optional(),
    compat: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type CustomModelSettings = z.infer<typeof CustomModelSettingsSchema>;
export const PutHostModelRequestSchema = z
  .object({
    ...vaultWriteBase,
    provider: z.string().min(1),
    model: z.string().min(1),
    baseUrl: z.string().min(1).optional(),
    settings: CustomModelSettingsSchema.optional(),
    auth: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("api_key"),
          key: z.string().min(1),
          env: z.record(z.string(), z.string()).optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal("oauth"),
          refresh: z.string().min(1),
          access: z.string().min(1),
          expires: z.number(),
        })
        .passthrough(),
    ]),
  })
  .strict();
export type PutHostModelRequest = z.infer<typeof PutHostModelRequestSchema>;
export type HostModelView =
  | { readonly configured: false }
  | {
      readonly configured: true;
      readonly provider: string;
      readonly model: string;
      readonly authType: "api_key" | "oauth";
      readonly baseUrl?: string;
      readonly settings?: CustomModelSettings;
    };
export const SelectHostModelRequestSchema = z
  .object({
    ...vaultWriteBase,
    provider: z.string().min(1),
    model: z.string().min(1),
    baseUrl: z.string().min(1).optional(),
  })
  .strict();
export type SelectHostModelRequest = z.infer<
  typeof SelectHostModelRequestSchema
>;
export type HostModelProviderInfo = z.infer<typeof HostModelProviderInfoSchema>;
export const ENVIRONMENT_SECRET_TYPES = [
  "bearer",
  "headers",
  "environment_secret",
  "environment_variable",
] as const;
/**
 * One credential of an Environment's vault, never its value: what it is bound to (the server
 * `url` for `bearer` and `headers`; the hosts and header for `environment_secret`).
 */
export const AgentSecretViewSchema = z
  .object({
    name: z.string(),
    type: z.enum(ENVIRONMENT_SECRET_TYPES),
    binding: z
      .object({
        url: z.string().optional(),
        allowedHosts: z.array(z.string()).optional(),
        inject: EnvironmentSecretInjectSchema.optional(),
      })
      .strict(),
    /** A `headers` credential's header names (lower case), never their values. */
    headerNames: z.array(z.string()).optional(),
    via: z.string().optional(),
    identity: CredentialIdentitySchema.optional(),
    createdAt: z.string(),
    rotatedAt: z.string().optional(),
  })
  .strict();
export type AgentSecretView = z.infer<typeof AgentSecretViewSchema>;
export const ListAgentSecretsResponseSchema = z
  .object({ secrets: z.array(AgentSecretViewSchema) })
  .strict();
export type ListAgentSecretsResponse = z.infer<typeof ListAgentSecretsResponseSchema>;
/** The MCP transports a preview speaks: a manifest's remote server types. */
export const MCP_PREVIEW_TYPES = ["streamable-http", "sse"] as const;
/**
 * `POST /v1/tenant/mcp/preview` (R2b C12): what a remote MCP server offers, before an agent
 * names it. The Runtime connects with the credential for `url` in the vault of Agent `agentId`
 * (none without one), lists the tools and closes the connection; it never calls a tool.
 */
export const McpPreviewRequestSchema = z
  .object({
    requestId: RequestIdSchema.optional(),
    /** The server's URL, as a manifest would name it: an absolute `http` or `https` URL. */
    url: z.string().min(1).superRefine((value, ctx) => {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        ctx.addIssue({ code: "custom", message: "url must be an absolute URL" });
        return;
      }
      if (url.protocol !== "https:" && url.protocol !== "http:")
        ctx.addIssue({ code: "custom", message: "url must be http or https" });
      if (url.username || url.password)
        ctx.addIssue({ code: "custom", message: "url may not carry userinfo" });
    }),
    /** The transport, as a manifest declares it. Default `streamable-http`. */
    type: z.enum(MCP_PREVIEW_TYPES).optional(),
    /**
     * The server name the agent will use: it prefixes the tools' model names. Default: the URL
     * host's name before its top-level domain (`linear` for `mcp.linear.app`).
     */
    name: modelFacingName("MCP server").optional(),
    /** The Environment whose vault's credential for `url` to send. Default: none is sent. */
    agentId: AgentIdSchema.optional(),
  })
  .strict();
export type McpPreviewRequest = z.infer<typeof McpPreviewRequestSchema>;
/** One tool a preview found. */
export const McpPreviewToolSchema = z
  .object({
    /** The server's own name for the tool. */
    serverToolName: z.string(),
    /**
     * What the model would call it as Nylorun's engine names MCP tools (R2b C6); absent when the
     * engine leaves the tool out (its input schema is not one it can use). A harness of your own
     * names tools itself.
     */
    modelName: z.string().optional(),
    description: z.string().optional(),
    /** The server's annotations of the tool (`readOnlyHint`, `destructiveHint`, `title`, …). */
    annotations: z.record(z.string(), z.unknown()).optional(),
    /** The size of the tool's input schema as JSON: what it costs the model's context. */
    schemaBytes: z.number().int().nonnegative(),
  })
  .strict();
export type McpPreviewTool = z.infer<typeof McpPreviewToolSchema>;
/**
 * A preview (R2b C12). A server that answered `401` is `authRequired`, with its RFC 9728
 * protected-resource metadata when it publishes any: it needs a person's sign-in or a key the
 * Environment's vault does not hold, so reach it with a key or through a gateway (`via`).
 */
export const McpPreviewSchema = z
  .object({
    /** The server name the model names were made with. */
    name: z.string(),
    url: z.string(),
    type: z.enum(MCP_PREVIEW_TYPES),
    /** True when a credential of the Environment's vault was sent. */
    credentialSent: z.boolean(),
    /** The server's `initialize` answer: its name, version and title. */
    serverInfo: z.record(z.string(), z.unknown()).optional(),
    /** The server's instructions from `initialize`. */
    instructions: z.string().optional(),
    tools: z.array(McpPreviewToolSchema),
    /** Tools Nylorun's engine names otherwise than `server__tool` (R2b C6). */
    renamed: z.array(z.object({ serverToolName: z.string(), name: z.string() }).strict()),
    authRequired: z
      .object({
        /** Where the server's protected-resource metadata was read from. */
        resourceMetadataUrl: z.string().optional(),
        /** The metadata (RFC 9728): `resource`, `authorization_servers`, `scopes_supported`, … */
        resourceMetadata: z.record(z.string(), z.unknown()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type McpPreview = z.infer<typeof McpPreviewSchema>;
/**
 * `POST /v1/tenant/credential-coverage`: which credential each of an Agent's remote MCP servers
 * and HTTP tools (those of the manifest version it runs) would get in its sessions, decided as the
 * session's tool calls decide it (by URL) from the Agent's vault. It reads no secret and calls no
 * server.
 */
export const CredentialCoverageRequestSchema = z
  .object({
    requestId: RequestIdSchema.optional(),
    agentId: AgentIdSchema,
  })
  .strict();
export type CredentialCoverageRequest = z.infer<typeof CredentialCoverageRequestSchema>;
/** A credential coverage names: where it is, never its value. */
export const CoverageCredentialSchema = z
  .object({
    agentId: z.string(),
    /** The secret's name in the Agent's vault. */
    name: z.string(),
    /** Where the credential sends the requests instead of the URL (a gateway). */
    via: z.string().optional(),
  })
  .strict();
export type CoverageCredential = z.infer<typeof CoverageCredentialSchema>;
/**
 * What a session would send for one URL an agent declares:
 * - `covered`: the Environment's vault holds a credential for it (`credential`);
 * - `missing`: it holds none: an MCP server is called without a credential (a public server
 *   needs none), an HTTP tool fails with `http.credential`.
 */
export const COVERAGE_STATUSES = ["covered", "missing"] as const;
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];
/** One remote MCP server or HTTP tool credential an agent declares. */
export const CredentialCoverageEntrySchema = z
  .object({
    kind: z.enum(["mcp", "http"]),
    /** The agent that declares it: absent for the agent itself, else a subagent or a flow's agent. */
    agentId: z.string().optional(),
    /** A flow's HTTP stage or HTTP verifier: its stage key. */
    stage: z.string().optional(),
    /** The MCP server's name, or the HTTP tool's (or stage's) name. */
    name: z.string(),
    /** The server's name, or the HTTP tool's `credential`. */
    serverName: z.string(),
    /** The URL a credential must be bound to, as the vault compares it. */
    url: z.string(),
    /** True when the call fails without a credential (an HTTP tool's `credential`). */
    required: z.boolean(),
    status: z.enum(COVERAGE_STATUSES),
    /** The credential the session would send, when `covered`. */
    credential: CoverageCredentialSchema.optional(),
    /** What the session would do, in a sentence. */
    message: z.string(),
  })
  .strict();
export type CredentialCoverageEntry = z.infer<typeof CredentialCoverageEntrySchema>;
export const CredentialCoverageSchema = z
  .object({
    agentId: z.string(),
    /** True when every entry is `covered`. */
    complete: z.boolean(),
    /** One per declared MCP server and HTTP tool credential: the agent's, then its agents'. */
    entries: z.array(CredentialCoverageEntrySchema),
  })
  .strict();
export type CredentialCoverage = z.infer<typeof CredentialCoverageSchema>;
const commandBase = {
  requestId: RequestIdSchema,
  idempotencyKey: IdempotencyKeySchema,
};
/**
 * What a message to a busy session does (protocol 17, D76): `queue` waits for the running turn to
 * end and starts the next one; `reject` is refused with `409 session_busy`. A protocol 17 client's
 * default is `queue`, a protocol 16 client's `reject`.
 */
export const MessageDeliverySchema = z.enum(["queue", "reject"]);
export type MessageDelivery = z.infer<typeof MessageDeliverySchema>;
const messageBase = {
  ...commandBase,
  type: z.literal("message"),
  /** Optional turn manifest (Loop patch); validated as a variant of the pinned agent. */
  manifest: AgentManifestSchema.optional(),
  delivery: MessageDeliverySchema.optional(),
};
/**
 * One part of a user message (protocol 6): text, or a file by artifact id. A file part without
 * `version` means the artifact's latest version when the message is accepted; the Runtime pins
 * it then. The model reads an image as an image, a text file as text, and refuses other files.
 */
export const MessagePartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().min(1) }).strict(),
  z
    .object({
      type: z.literal("file"),
      artifactId: z.string().min(1),
      version: z.number().int().positive().optional(),
    })
    .strict(),
]);
export type MessagePart = z.infer<typeof MessagePartSchema>;
/**
 * Exactly one of `content`, `data` or `parts` (protocol 6). Optional `manifest` for per-turn
 * agent patches.
 */
export const MessageEventBodySchema = z.union([
  z
    .object({
      ...messageBase,
      content: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...messageBase,
      data: jsonValue,
    })
    .strict(),
  z
    .object({
      ...messageBase,
      /** At most the Tenant's Runtime limit `messageParts`, checked when the message is accepted. */
      parts: z.array(MessagePartSchema).min(1),
    })
    .strict(),
]);
/** What one effect came to: its value, and the agent state it changes. */
export const EffectOutcomeSchema = z
  .object({
    value: z.unknown(),
    statePatch: jsonObject.optional(),
  })
  .strict();
export type EffectOutcome = z.infer<typeof EffectOutcomeSchema>;
export const SessionCommandSchema = z.union([
  MessageEventBodySchema,
  z
    .object({
      ...commandBase,
      type: z.literal("approve"),
      interactionId: z.string().min(1),
      approved: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      type: z.literal("respond"),
      interactionId: z.string().min(1),
      value: z.unknown(),
    })
    .strict(),
  z
    .object({
      ...commandBase,
      type: z.literal("cancel"),
      reason: z.string().optional(),
    })
    .strict(),
]);
export const SessionEventBodySchema = SessionCommandSchema;
export type SessionCommand = z.infer<typeof SessionCommandSchema>;
export type SessionEventBody = SessionCommand;
export type MessageEventBody = z.infer<typeof MessageEventBodySchema>;
/** The envelope every session event carries (`nylorun.event/2`, Durable Streams §9.5). */
export const EVENT_SCHEMA = "nylorun.event/2";
/**
 * Who wrote an event (track R4, R4.9): the writer says so, not the event's type. `client` is a
 * command over the Runtime API (its `principal` says who sent it), `core` is core's own logic
 * (settle, sweeps, the flow host, exports, the tools core serves), `harness` is what a harness
 * reported (`source.id` is its harness id, `runId` its run), and the gates are themselves.
 * `loop` and `api` are what events written before R4 say.
 */
export const EventSourceKindSchema = z.enum([
  "client",
  "core",
  "model-gate",
  "tool-gate",
  "egress-gate",
  "sandboxes",
  "edge",
  "init",
  "controller",
  "loop",
  "supervisor",
  "harness",
  "evidence",
  "operator",
  "human",
  "api",
]);
export type EventSourceKind = z.infer<typeof EventSourceKindSchema>;
/**
 * How far an event can be trusted, by who could forge it. `observed`: the Runtime saw it itself
 * (commands, the tools core serves, gate records, core's settle). `claimed`: a harness reported
 * it (an assistant message, a tool result it ran, its turn's end), so it is the harness's claim;
 * the Model Gate's usage row is the measured record of the same model call.
 */
export const EvidenceClassSchema = z.enum([
  "observed",
  "measured",
  "attested",
  "claimed",
  "asserted",
]);
export type EvidenceClass = z.infer<typeof EvidenceClassSchema>;
/** A command's sender (R4.9): from the request's credential, never from its body. */
export const EventPrincipalSchema = z
  .object({
    /** `trigger`: core, for an Agent's trigger (track T4); its id is the trigger's. */
    kind: z.enum(["application", "subject", "flow-host", "core", "trigger"]),
    id: z.string(),
  })
  .strict();
export type EventPrincipal = z.infer<typeof EventPrincipalSchema>;

/**
 * Who wrote an event, as its writer says (R4.9). Absent, core wrote it and saw it (`core`,
 * `observed`).
 */
export interface EventWriter {
  readonly source: { readonly kind: EventSourceKind; readonly id: string };
  readonly evidence?: EvidenceClass;
  /** The run the event was written in. */
  readonly runId?: string;
  readonly principal?: EventPrincipal;
}

/**
 * The envelope fields. Not strict: a client strips fields it does not know, so the envelope
 * can grow without a protocol bump.
 */
const eventEnvelope = {
  schema: z.literal(EVENT_SCHEMA),
  eventId: z.string(),
  tenantId: z.string().min(1),
  sessionId: z.string(),
  /** The run the event belongs to; null until runs exist. */
  runId: z.string().nullable(),
  turnId: z.string().nullable(),
  /** The session's restore incarnation; 0 until restores exist. */
  incarnation: z.number().int().nonnegative(),
  /** The session's ownership epoch when the event was written. */
  epoch: z.number().int().nonnegative(),
  /** Position in the session's log, from 0, in commit order. */
  seq: z.number().int().nonnegative(),
  /** `base64url(sessionId:seq)`: resume from here with `Last-Event-ID` or `?cursor=`. */
  cursor: z.string(),
  /** When the event was written (ISO 8601). */
  time: z.string(),
  /** The version of the event type's payload schema. */
  schemaVersion: z.number().int().positive(),
  source: z.object({ kind: EventSourceKindSchema, id: z.string() }),
  evidence: EvidenceClassSchema,
  /** Who sent a command (`command.*`, a cancel's `turn.cancelled`), from its credential (R4.9). */
  principal: EventPrincipalSchema.optional(),
  trace: z
    .object({
      traceId: z.string(),
      spanId: z.string(),
      parentSpanId: z.string().optional(),
    })
    .optional(),
  visibility: z.enum(["public", "internal", "restricted"]),
  retention: z.enum(["full", "metadata"]),
};
/**
 * Any session event: the envelope with an open `type` and `payload`. Clients read an event of
 * a type they do not know as this; `SessionEventSchema` types the known ones.
 */
export const LiveEventSchema = z.object({
  ...eventEnvelope,
  type: z.string().min(1),
  payload: z.unknown(),
});
/** Any session event (`SessionEvent` when its type is known). */
export type LiveEvent = z.infer<typeof LiveEventSchema>;
export const AcceptedResponseSchema = z.object({
  status: z.literal("accepted"),
  turnId: z.string().nullable(),
  cursor: z.string().nullable(),
  requestId: z.string(),
});
export type AcceptedResponse = z.infer<typeof AcceptedResponseSchema>;
/**
 * A message the session queued because a turn runs or waits (protocol 17): it starts the next
 * turn when this one ends. `position` counts from 1, the first to go.
 */
export const QueuedResponseSchema = z.object({
  status: z.literal("queued"),
  queuedMessageId: z.string(),
  position: z.number().int().positive(),
  cursor: z.string().nullable(),
  requestId: z.string(),
});
export type QueuedResponse = z.infer<typeof QueuedResponseSchema>;
/** What a session command answers: accepted, or, for a message, queued. */
export const CommandResponseSchema = z.union([AcceptedResponseSchema, QueuedResponseSchema]);
export type CommandResponse = z.infer<typeof CommandResponseSchema>;
export const RejectedResponseSchema = z.object({
  status: z.literal("rejected"),
  code: z.enum(ERROR_CODES),
  message: z.string(),
  details: z.unknown().optional(),
  activeTurnId: z.string().optional(),
  requestId: z.string().optional(),
});
export type RejectedResponse = z.infer<typeof RejectedResponseSchema>;
/** The agent a call belongs to. Set on work for an agent used as a tool; absent for the root. */
export const AgentRefSchema = z
  .object({
    id: z.string().min(1),
    path: z.string().min(1),
    delegationId: z.string().min(1).optional(),
  })
  .strict();

/**
 * Transcript events (Host feature `transcript-events`): the log entries a chat UI
 * renders. They are part of the event catalog (`EVENT_CATALOG`); `parseTranscriptEvent`
 * types the ones a client reads. Objects pass unknown fields through, so a newer
 * Host can add fields without breaking older clients.
 */
const eventAgent = { agent: AgentRefSchema.passthrough().optional() };
const toolIds = {
  /** The model's tool call id. */
  callId: z.string().min(1),
  /** The harness invocation of the call; interactions refer to it. */
  invocationId: z.string().min(1),
};
/**
 * When a gate served a call (R7.1): its own start and end, as it measured them. Absent when no
 * gate measured the call (a fixture model, a sandbox or core-served tool, a call refused before
 * it was sent).
 */
export const GateTimesSchema = z
  .object({ startedAt: z.string(), endedAt: z.string() })
  .passthrough();
/**
 * What the Model Gate's meter recorded for a model call (R7.1), from the usage ledger: the
 * tokens and cost the Runtime counts, beside the `usage` the harness reported. `cachedTokens`
 * and `costUsd` are absent when zero.
 */
export const MeteredUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    cachedTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
  })
  .passthrough();
/**
 * The timing of a model call's outcome (R7.1), on `message.assistant`, `model.failed` and
 * `context.compacted`. `durationMs` is the journal's window, from the intent to the outcome;
 * `gate`, `firstTokenMs` and `meteredUsage` are the meter's, absent when no gate metered the
 * call.
 */
const modelOutcomeFacts = {
  /** The model call's effect id. */
  effectId: z.string().min(1).optional(),
  /** From the intent to the outcome, as the journal saw them. */
  durationMs: z.number().int().nonnegative().optional(),
  gate: GateTimesSchema.optional(),
  /** From the gate's start of the call to the provider's first stream event. */
  firstTokenMs: z.number().int().nonnegative().optional(),
  meteredUsage: MeteredUsageSchema.optional(),
};
/**
 * `message.assistant`: one completed model step. `invocationId` is the model call's.
 * `model`, `finishReason` and `usage` are present when the provider reported them. A step that
 * said nothing (no text, no tool calls, as a structured answer) has `text: ""` and no tool
 * calls: it is in the log for its timing, and is never a message (`isEmptyAssistantMessage`).
 */
export const AssistantMessagePayloadSchema = z
  .object({
    invocationId: z.string().min(1),
    text: z.string(),
    model: z
      .object({ provider: z.string(), model: z.string() })
      .passthrough()
      .optional(),
    finishReason: z.string().optional(),
    usage: z.record(z.string(), z.number()).optional(),
    toolCalls: z.array(
      z
        .object({
          callId: z.string().min(1),
          name: z.string().min(1),
          input: z.unknown(),
        })
        .passthrough()
    ),
    ...modelOutcomeFacts,
    ...eventAgent,
  })
  .passthrough();
/** True when a `message.assistant` said nothing: no text and no tool calls (R7.1). */
export function isEmptyAssistantMessage(payload: {
  readonly text?: unknown;
  readonly toolCalls?: readonly unknown[];
}): boolean {
  return (
    (typeof payload.text !== "string" || payload.text === "") &&
    (payload.toolCalls?.length ?? 0) === 0
  );
}
/**
 * `model.failed`: a model call that failed in a known way (Model Calls §6.4). The turn
 * then fails with `model.<code>`, or recovers.
 */
export const ModelFailedPayloadSchema = z
  .object({
    invocationId: z.string().min(1).optional(),
    code: z.string().min(1),
    message: z.string(),
    retryable: z.boolean(),
    ...modelOutcomeFacts,
    ...eventAgent,
  })
  .passthrough();
/**
 * `context.compacted`: the harness summarized older history to fit the model's window
 * (Model Calls §8), and said so with the transcript edit that replaced it (`kind: "compaction"`,
 * protocol 15). Token counts are the harness's estimates; `invocationId` and the model facts are
 * the last summary call's. Written once per compaction, when the segment's edit is recorded.
 */
export const ContextCompactedPayloadSchema = z
  .object({
    invocationId: z.string().min(1).optional(),
    trigger: z.enum(["threshold", "overflow"]),
    tokensBefore: z.number().int().nonnegative(),
    tokensAfter: z.number().int().nonnegative(),
    ...modelOutcomeFacts,
    ...eventAgent,
  })
  .passthrough();
/** How a tool call ended (R5.1): the tool answered, the Runtime ended it, or a cancel did. */
export const TOOL_CALL_STATUSES = ["completed", "failed", "cancelled"] as const;
/**
 * Where a tool call ran (R5.1), its effect's target kind (protocol 15): an MCP server, an HTTP
 * tool's URL, the session's sandbox, the harness that runs the turn (`harness`: a tool it runs
 * in its own process, such as our engine's skill, artifact and `tool_search` tools), or the
 * Runtime itself (`runtime`: `schedule_wake`, track T4).
 */
export const TOOL_CALL_KINDS = ["mcp", "http", "sandbox", "harness", "runtime"] as const;
/**
 * What the Tenant's tool policy did with a tool call (R5 step 2), when it did more than allow
 * it: `deny` refused it unsent; `ask` held it for a person, who approved it (`approvedBy`, when
 * known) or denied it.
 */
export const ToolPolicyFactSchema = z
  .object({
    decision: z.enum(["ask", "deny"]),
    reason: z.string(),
    approvedBy: z.string().optional(),
  })
  .passthrough();
/**
 * `tool.completed`: how one tool call ended, written once per call (R5.1). `status`
 * `completed`: the tool answered, with its output or the tool error it reported (`error`).
 * `failed`: the Runtime ended the call (`tool.disabled`, `tool.unavailable`, `tool.denied`, or
 * `tool.interrupted` for a call a crash interrupted, which may have run). `cancelled`: the turn
 * was cancelled while the call ran; it may have run. `attempts` above 1: the call was sent again
 * after a crash, with the same key.
 */
export const ToolCompletedPayloadSchema = z
  .object({
    ...toolIds,
    /** The tool call's effect id (R7.1). */
    effectId: z.string().min(1).optional(),
    /** The name the model called the tool by, as its harness named it: for display. */
    toolName: z.string().min(1),
    status: z.enum(TOOL_CALL_STATUSES).optional(),
    kind: z.enum(TOOL_CALL_KINDS).optional(),
    /** The MCP server, or the HTTP tool's URL host. */
    server: z.string().min(1).optional(),
    /**
     * The tool's identity (protocol 15): an MCP tool's own name on `server`, or the HTTP tool's
     * declared name. Tool policy and approval key on it.
     */
    tool: z.string().min(1).optional(),
    /**
     * The skill the call ran: `load_skill` and `read_skill_resource` name it, and a sandbox tool
     * whose input names its folder, `/skills/<name>@<hash>/`, ran its files.
     */
    skill: z.string().min(1).optional(),
    /** The Agent Plugin that brought the call's MCP server or skill. */
    plugin: pluginLabelSchema.optional(),
    /** How many times the call was sent: 0 when the Runtime refused it, above 1 after a crash re-sent it. */
    attempts: z.number().int().nonnegative().optional(),
    /** From the first send to the outcome; absent when the call never ran. */
    durationMs: z.number().int().nonnegative().optional(),
    /**
     * The Tool Gate's own start and end of the call's last send (R7.1): an MCP or HTTP tool
     * through the gateway. Absent for a sandbox or core-served tool.
     */
    gate: GateTimesSchema.optional(),
    policy: ToolPolicyFactSchema.optional(),
    output: z.unknown().optional(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        /**
         * With `credential_rejected` (R2b C1): the MCP server, or the HTTP tool's `credential`,
         * whose server answered `401`.
         */
        server: z.string().optional(),
        /** An MCP tool error (R2b C7): true when calling again may work, as for `mcp.unreachable`. */
        retryable: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    /**
     * How many credential values the Runtime replaced with `[redacted]` in `output` or `error`
     * (R2b C8): the server echoed what it was sent. Absent when none.
     */
    redacted: z.number().int().positive().optional(),
    ...eventAgent,
  })
  .passthrough();
export const EffectUncertainPayloadSchema = z
  .object({ effectId: z.string().min(1), message: z.string().optional() })
  .passthrough();
/**
 * How a turn that ended went (R7.1), on `turn.completed`, `turn.failed` and `turn.cancelled`:
 * `durationMs` from the turn's start to its end, waits for a person included, so the turn's span
 * holds every crossing in it; `pausedMs`, how much of that it waited paused; `totals` from the
 * usage ledger (`steps`: the model calls the gate metered). Absent on a turn
 * that started before the Runtime recorded them.
 */
const turnEndFacts = {
  durationMs: z.number().int().nonnegative().optional(),
  pausedMs: z.number().int().nonnegative().optional(),
  /** The session's Agent. */
  agentId: z.string().optional(),
  /** The agent manifest version the session runs (protocol 16): the agent the turn's span names. */
  manifest: z.object({ name: z.string(), version: z.number().int() }).passthrough().optional(),
  totals: z
    .object({
      steps: z.number().int().nonnegative(),
      tokens: z.number().int().nonnegative(),
      costUsd: z.number().nonnegative(),
    })
    .passthrough()
    .optional(),
};
export const TurnCompletedPayloadSchema = z
  .object({ output: z.unknown(), ...turnEndFacts })
  .passthrough();
export const TurnPausedPayloadSchema = z
  .object({
    interactions: z.array(
      z
        .object({
          invocationId: z.string().min(1),
          /** The model's tool call id, when an agent's tool call asked. */
          callId: z.string().min(1).optional(),
          interaction: z
            .object({ id: z.string().min(1), kind: z.string() })
            .passthrough(),
          status: z.string().optional(),
        })
        .passthrough()
    ),
  })
  .passthrough();
/** Either `{ error: { code, message } }` or, when a segment threw, `{ message }`. */
export const TurnFailedPayloadSchema = z
  .object({
    error: z
      .object({ code: z.string().optional(), message: z.string().optional() })
      .passthrough()
      .optional(),
    message: z.string().optional(),
    ...turnEndFacts,
  })
  .passthrough();
export const TurnCancelledPayloadSchema = z
  .object({ reason: z.string().optional(), ...turnEndFacts })
  .passthrough();
/**
 * `message.queued` (protocol 17): a message arrived while the session's turn ran or waited, and
 * waits in its queue. `position` counts from 1; the message's `command.message` is written when
 * a turn takes it.
 */
export const MessageQueuedPayloadSchema = z
  .object({ queuedMessageId: z.string(), position: z.number().int().positive(), requestId: z.string() })
  .passthrough();
/**
 * `wake.booked` (track T4, D77): the session's agent booked its next turn with `schedule_wake`,
 * at `at`, replacing any booking before. `wake.cancelled`: it cancelled its booking.
 */
export const WakeBookedPayloadSchema = z
  .object({ at: z.string(), note: z.string(), effectId: z.string(), replaced: z.boolean() })
  .passthrough();
export const WakeCancelledPayloadSchema = z.object({ effectId: z.string() }).passthrough();
/** `queue.taken` (protocol 17): the turn that started with the queued messages, in order. */
export const QueueTakenPayloadSchema = z
  .object({ turnId: z.string(), queuedMessageIds: z.array(z.string()).min(1) })
  .passthrough();
/** Lifecycle of an agent used as a tool. `agent.delegationId` is the parent call's invocation. */
export const DelegationPayloadSchema = z
  .object({
    agent: AgentRefSchema.passthrough(),
    callId: z.string().optional(),
  })
  .passthrough();
const TRANSCRIPT_PAYLOADS = {
  "message.assistant": AssistantMessagePayloadSchema,
  "model.failed": ModelFailedPayloadSchema,
  "context.compacted": ContextCompactedPayloadSchema,
  "tool.completed": ToolCompletedPayloadSchema,
  "effect.uncertain": EffectUncertainPayloadSchema,
  "turn.completed": TurnCompletedPayloadSchema,
  "turn.paused": TurnPausedPayloadSchema,
  "turn.failed": TurnFailedPayloadSchema,
  "turn.cancelled": TurnCancelledPayloadSchema,
  "delegation.started": DelegationPayloadSchema,
  "delegation.completed": DelegationPayloadSchema,
} as const;
export type TranscriptEventType = keyof typeof TRANSCRIPT_PAYLOADS;
export const TRANSCRIPT_EVENT_TYPES = Object.keys(
  TRANSCRIPT_PAYLOADS
) as readonly TranscriptEventType[];

/** `command.message`: the message a client sent, as accepted. */
export const CommandMessagePayloadSchema = z
  .object({
    ...commandBase,
    type: z.literal("message"),
    content: z.string().optional(),
    data: jsonValue.optional(),
    /** Text and file parts (protocol 6), as sent: a file part names an artifact, never bytes. */
    parts: z.array(MessagePartSchema).optional(),
    /** The turn manifest the message carried, if any. */
    manifest: z.unknown().optional(),
    delivery: MessageDeliverySchema.optional(),
    /** Set when the message waited in the session's queue (protocol 17): its id there. */
    queuedMessageId: z.string().optional(),
    /**
     * What sent it, when not a client (track T4): a trigger's run (`trigger`, with the trigger
     * and run ids), or the session's own booked wake (`self`).
     */
    cause: z
      .object({ kind: z.enum(["trigger", "self"]), triggerId: z.string(), runId: z.string() })
      .strict()
      .optional(),
    /**
     * The W3C trace context the message was sent with (R7.4): the turn's trace is the caller's,
     * and its root span the child of the caller's span.
     */
    trace: z
      .object({ traceparent: z.string(), tracestate: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
/** `command.approve`: an answer to an approval interaction. */
export const CommandApprovePayloadSchema = z
  .object({
    ...commandBase,
    type: z.literal("approve"),
    interactionId: z.string().min(1),
    approved: z.boolean(),
  })
  .passthrough();
/** `command.respond`: an answer to an input interaction. */
export const CommandRespondPayloadSchema = z
  .object({
    ...commandBase,
    type: z.literal("respond"),
    interactionId: z.string().min(1),
    value: z.unknown(),
  })
  .passthrough();
/** `environment.state`: the session's sandbox changed state. */
export const EnvironmentStatePayloadSchema = z
  .object({
    state: z.enum(["creating", "running", "stopped"]),
    backend: z.string(),
    isolation: z.string().optional(),
    image: z.string().optional(),
    network: z.unknown().optional(),
    reattach: z.boolean().optional(),
    lost: z.boolean().optional(),
    note: z.string().optional(),
    error: z.string().optional(),
  })
  .passthrough();
/**
 * `agent.attached`: the session was opened on its Agent (protocol 16; `environment.attached`
 * before). The Agent's own stream records the same attachment.
 */
export const AgentAttachedPayloadSchema = z
  .object({ agentId: z.string() })
  .passthrough();
/** `environment.exec`: one sandbox tool call finished. */
export const EnvironmentExecPayloadSchema = z
  .object({
    tool: z.string(),
    command: z.string().optional(),
    outcome: z.string(),
    code: z.string().optional(),
    durationMs: z.number().nonnegative(),
  })
  .passthrough();
/** `node.started`: a workflow tool node started. */
export const NodeStartedPayloadSchema = z
  .object({
    path: z.string(),
    kind: z.string(),
    key: z.string(),
    iterations: z.string().optional(),
  })
  .passthrough();
/**
 * `node.completed`: a flow's HTTP stage or HTTP verifier ended, or a tool stage the Runtime
 * refused to run (R7.1), named as its `node.started` names it. `status` reads as
 * `tool.completed`'s: `completed` when the stage's server answered (an error answer included),
 * `failed` when the Runtime ended it, `cancelled` when a cancel did. `gate` is the Tool Gate's
 * own start and end of its last send.
 */
export const NodeCompletedPayloadSchema = z
  .object({
    path: z.string(),
    kind: z.string(),
    key: z.string(),
    iterations: z.string().optional(),
    effectId: z.string().min(1),
    status: z.enum(TOOL_CALL_STATUSES),
    /** From the first send to the outcome; absent when the stage never ran. */
    durationMs: z.number().int().nonnegative().optional(),
    gate: GateTimesSchema.optional(),
  })
  .passthrough();
/** `node.agent`: a workflow node runs as a linked agent session. */
export const NodeAgentPayloadSchema = z
  .object({
    path: z.string(),
    iterations: z.string().optional(),
    sessionId: z.string(),
    turnId: z.string().nullable().optional(),
  })
  .passthrough();
/** `loop.iteration`: a Loop started its `n`th agent turn. */
export const LoopIterationPayloadSchema = z
  .object({
    path: z.string(),
    n: z.number().int(),
    sessionId: z.string().optional(),
    turnId: z.string().optional(),
    manifestHash: z.string().optional(),
  })
  .passthrough();
/** `loop.verified`: a Loop's verifier judged iteration `n`. */
export const LoopVerifiedPayloadSchema = z
  .object({
    path: z.string(),
    n: z.number().int(),
    pass: z.boolean(),
    feedback: z.string().optional(),
    data: z.unknown().optional(),
  })
  .passthrough();
/**
 * `transcript.updated` (internal; blueprint P0.3): the own loop's model-facing transcript after a
 * settled segment, as an edit of the previous one: keep its first `keep` entries, then append
 * `entries`; the result has `length` entries. `keep` is 0 for a snapshot (after compaction, or
 * for a session written before transcripts were recorded). Large edits are split into
 * consecutive events, each appending to the last. Entries are the engine's `TranscriptEntry`
 * values, checked by the Runtime when it folds them. Never served to clients.
 */
export const TranscriptUpdatedPayloadSchema = z
  .object({
    keep: z.number().int().nonnegative(),
    entries: z.array(z.unknown()),
    length: z.number().int().nonnegative(),
  })
  .passthrough();

/**
 * Where an artifact version's bytes came from: a client's upload, a harness over the artifact
 * seam (our engine's `save_artifact`, its tool results and its outputs folder), an Environment's
 * disk version (`snapshot`), or core's turn-end export of a sandbox's outputs, which versions
 * before protocol 15 name (`export`).
 */
export const ArtifactSourceSchema = z.enum(["upload", "engine", "export", "snapshot"]);
export type ArtifactSource = z.infer<typeof ArtifactSourceSchema>;
/**
 * What an artifact holds: one file, or a folder (F8.2), whose versions are manifests of paths to
 * content-addressed files.
 */
export const ArtifactKindSchema = z.enum(["file", "folder"]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;
/**
 * `artifact.created` and `artifact.version.created` (protocol 6): a file or folder artifact of the
 * session, or a new version of one, committed. Ids, sizes and hashes, never bytes. A folder's
 * `size` is the sum of its files' and its `sha256` is its manifest's.
 */
export const ArtifactVersionPayloadSchema = z
  .object({
    artifactId: z.string(),
    kind: ArtifactKindSchema,
    name: z.string(),
    contentType: z.string(),
    version: z.number().int().positive(),
    size: z.number().int().nonnegative(),
    sha256: z.string(),
    source: ArtifactSourceSchema,
    /** The tool call that saved it (`save_artifact`), when our engine did. */
    callId: z.string().optional(),
    /** A folder's number of files. */
    fileCount: z.number().int().nonnegative().optional(),
    /**
     * True when the listing and the bytes are the harness's claim (a turn-end export): the
     * Runtime stored what the harness holding the workspace supplied, without observing it.
     */
    claimed: z.boolean().optional(),
  })
  .passthrough();
/** `artifact.deleted`: the artifact and every version of it are gone. */
export const ArtifactDeletedPayloadSchema = z
  .object({ artifactId: z.string(), name: z.string() })
  .passthrough();
/**
 * Why the turn-end save of a session's outputs folder stored nothing although the sandbox had
 * outputs: our engine's claim (protocol 15), with the limit it met.
 */
export const ArtifactExportSkipReasonSchema = z.enum([
  "too_many_files",
  "file_too_large",
  "too_large",
  "tenant_total",
  /** Past the session's Environment's own total (its manifest's `limits.artifacts.totalBytes`). */
  "environment_total",
]);
export type ArtifactExportSkipReason = z.infer<typeof ArtifactExportSkipReasonSchema>;
/**
 * `artifact.export.skipped`: the turn's outputs were past a limit, so no folder version was
 * written. The turn itself completed.
 */
export const ArtifactExportSkippedPayloadSchema = z
  .object({
    /** The folder artifact the export writes: `outputs`. */
    name: z.string(),
    reason: ArtifactExportSkipReasonSchema,
    message: z.string(),
    /** The limit passed: files, or bytes. */
    limit: z.number().int().nonnegative().optional(),
    /** The file past the per-file limit (`file_too_large`). */
    path: z.string().optional(),
  })
  .passthrough();
/**
 * `artifact.export.failed`: the turn-end save of the outputs folder could not finish (the sandbox
 * or the artifact seam failed), as our engine claims it. The turn itself completed; the next turn
 * saves again.
 */
export const ArtifactExportFailedPayloadSchema = z
  .object({ name: z.string(), message: z.string() })
  .passthrough();

/** What readying one declared MCP server found (`mcp.discovered`). */
export const McpServerOutcomeSchema = z
  .object({
    /** The agent used as a tool that declares the server; absent for the session's root agent. */
    agentId: z.string().optional(),
    serverName: z.string(),
    /** The Agent Plugin that brought the server. */
    plugin: pluginLabelSchema.optional(),
    /** `refused`: the vault has no usable credential for it; `failed`: it could not be reached or listed. */
    outcome: z.enum(["connected", "refused", "failed"]),
    message: z.string(),
    /** The tools it added to the session that its `tools` settings leave enabled; 0 unless connected. */
    tools: z.number().int().nonnegative(),
    /** Listed tools the server's `tools` settings disable (R2b C9); absent when none. */
    disabled: z.number().int().positive().optional(),
    /**
     * Keys of the server's `tools` settings that name no tool it listed (R2b C9): a diagnostic,
     * since servers change their lists.
     */
    unknownTools: z.array(z.string()).optional(),
    /** The credentials a refusal names. */
    credentialIds: z.array(z.string()).optional(),
  })
  .passthrough();
export type McpServerOutcome = z.infer<typeof McpServerOutcomeSchema>;
/**
 * `mcp.discovered`: the session's first turn readied its MCP servers and pinned the tools they
 * offer, one outcome per declared server. A server that did not connect adds no tools for the
 * session's life, so this is where the model's missing tools show (also `mcpDiagnostics`).
 */
export const McpDiscoveredPayloadSchema = z
  .object({ servers: z.array(McpServerOutcomeSchema) })
  .passthrough();

/**
 * The event catalog (Durable Streams §9.5): every session event type, its payload schema, its
 * payload schema version and who writes it. A type not listed here cannot be written. A type
 * with `visibility: "internal"` is recorded and folded by the Runtime but never served to
 * clients (SSE, history, AG-UI and A2A skip it).
 *
 * Evolution: new types and new optional payload fields are additive (clients ignore types
 * they do not know, and payloads pass unknown fields through). A breaking payload change is a
 * new type or a protocol version, never an edit in place.
 */
export const EVENT_CATALOG = {
  "command.message": { payload: CommandMessagePayloadSchema, source: "api", version: 1 },
  "command.approve": { payload: CommandApprovePayloadSchema, source: "api", version: 1 },
  "command.respond": { payload: CommandRespondPayloadSchema, source: "api", version: 1 },
  "turn.completed": { payload: TurnCompletedPayloadSchema, source: "loop", version: 1 },
  "turn.paused": { payload: TurnPausedPayloadSchema, source: "loop", version: 1 },
  "turn.failed": { payload: TurnFailedPayloadSchema, source: "loop", version: 1 },
  "turn.cancelled": { payload: TurnCancelledPayloadSchema, source: "api", version: 1 },
  "message.queued": { payload: MessageQueuedPayloadSchema, source: "api", version: 1 },
  "queue.taken": { payload: QueueTakenPayloadSchema, source: "api", version: 1 },
  "wake.booked": { payload: WakeBookedPayloadSchema, source: "api", version: 1 },
  "wake.cancelled": { payload: WakeCancelledPayloadSchema, source: "api", version: 1 },
  "message.assistant": { payload: AssistantMessagePayloadSchema, source: "loop", version: 1 },
  "model.failed": { payload: ModelFailedPayloadSchema, source: "loop", version: 1 },
  "context.compacted": { payload: ContextCompactedPayloadSchema, source: "loop", version: 1 },
  "tool.completed": { payload: ToolCompletedPayloadSchema, source: "loop", version: 1 },
  "effect.uncertain": { payload: EffectUncertainPayloadSchema, source: "loop", version: 1 },
  "delegation.started": { payload: DelegationPayloadSchema, source: "loop", version: 1 },
  "delegation.completed": { payload: DelegationPayloadSchema, source: "loop", version: 1 },
  "mcp.discovered": { payload: McpDiscoveredPayloadSchema, source: "loop", version: 1 },
  "environment.state": { payload: EnvironmentStatePayloadSchema, source: "loop", version: 1 },
  "environment.exec": { payload: EnvironmentExecPayloadSchema, source: "loop", version: 1 },
  "agent.attached": { payload: AgentAttachedPayloadSchema, source: "api", version: 1 },
  "node.started": { payload: NodeStartedPayloadSchema, source: "loop", version: 1 },
  "node.completed": { payload: NodeCompletedPayloadSchema, source: "loop", version: 1 },
  "node.agent": { payload: NodeAgentPayloadSchema, source: "loop", version: 1 },
  "loop.iteration": { payload: LoopIterationPayloadSchema, source: "loop", version: 1 },
  "loop.verified": { payload: LoopVerifiedPayloadSchema, source: "api", version: 1 },
  "artifact.created": { payload: ArtifactVersionPayloadSchema, source: "api", version: 1 },
  "artifact.version.created": {
    payload: ArtifactVersionPayloadSchema,
    source: "api",
    version: 1,
  },
  "artifact.deleted": { payload: ArtifactDeletedPayloadSchema, source: "api", version: 1 },
  "artifact.export.skipped": {
    payload: ArtifactExportSkippedPayloadSchema,
    source: "api",
    version: 1,
  },
  "artifact.export.failed": {
    payload: ArtifactExportFailedPayloadSchema,
    source: "api",
    version: 1,
  },
  "transcript.updated": {
    payload: TranscriptUpdatedPayloadSchema,
    source: "loop",
    version: 1,
    visibility: "internal",
  },
} as const satisfies Record<
  string,
  {
    payload: z.ZodType;
    source: EventSourceKind;
    version: number;
    visibility?: "public" | "internal";
  }
>;
export type EventType = keyof typeof EVENT_CATALOG;
export const EVENT_TYPES = Object.keys(EVENT_CATALOG) as readonly EventType[];
/** Drops the index signatures `passthrough` adds, so plain interfaces are assignable. */
type Closed<T> = T extends readonly (infer U)[]
  ? Closed<U>[]
  : T extends object
  ? { [K in keyof T as string extends K ? never : K]: Closed<T[K]> }
  : T;
/**
 * The payload a writer passes for an event of `type` (checked again at runtime against the
 * catalog, unknown fields included).
 */
export type EventPayload<T extends EventType> = Closed<
  z.input<(typeof EVENT_CATALOG)[T]["payload"]>
>;
export function isEventType(type: string): type is EventType {
  return Object.hasOwn(EVENT_CATALOG, type);
}

type EventSchemaOf<T extends EventType> = z.ZodObject<
  typeof eventEnvelope & {
    type: z.ZodLiteral<T>;
    payload: (typeof EVENT_CATALOG)[T]["payload"];
  }
>;
function eventSchema<T extends EventType>(type: T): EventSchemaOf<T> {
  return z.object({
    ...eventEnvelope,
    type: z.literal(type),
    payload: EVENT_CATALOG[type].payload,
  }) as unknown as EventSchemaOf<T>;
}
/** One schema per event type, keyed by type (the OpenAPI components). */
export const EVENT_SCHEMAS = Object.fromEntries(
  EVENT_TYPES.map((type) => [type, eventSchema(type)])
) as { [T in EventType]: EventSchemaOf<T> };
/** A session event of a known type, discriminated on `type`. */
export const SessionEventSchema = z.discriminatedUnion(
  "type",
  EVENT_TYPES.map((type) => EVENT_SCHEMAS[type]) as unknown as [
    EventSchemaOf<EventType>,
    ...EventSchemaOf<EventType>[],
  ]
);
export type SessionEvent = {
  [T in EventType]: z.infer<EventSchemaOf<T>>;
}[EventType];
/** The session event of type `T`. */
export type SessionEventOf<T extends EventType> = Extract<SessionEvent, { type: T }>;
/**
 * Reads one event from the wire: typed when its type is in the catalog and it matches, else
 * the bare envelope (a newer Runtime's type, which a client ignores). Throws only when even
 * the envelope does not match.
 */
export function parseSessionEvent(value: unknown): SessionEvent | LiveEvent {
  const known = SessionEventSchema.safeParse(value);
  if (known.success) return known.data as SessionEvent;
  return LiveEventSchema.parse(value);
}
export const SessionItemsResponseSchema = z.object({
  items: z.array(SessionEventSchema),
  cursor: z.string().nullable(),
});
export type SessionItemsResponse = {
  items: (SessionEvent | LiveEvent)[];
  cursor: string | null;
};

export type TranscriptEvent = SessionEventOf<TranscriptEventType>;
/** Types a transcript event's payload; `undefined` for other types or a malformed payload. */
export function parseTranscriptEvent(
  event: LiveEvent
): TranscriptEvent | undefined {
  if (!Object.hasOwn(TRANSCRIPT_PAYLOADS, event.type)) return undefined;
  const parsed =
    TRANSCRIPT_PAYLOADS[event.type as TranscriptEventType].safeParse(
      event.payload
    );
  return parsed.success
    ? ({ ...event, payload: parsed.data } as TranscriptEvent)
    : undefined;
}
export const ProtocolRangeSchema = z
  .object({
    min: z.number().int(),
    max: z.number().int(),
    features: z.array(z.string()),
  })
  .strict();

export const HealthResponseSchema = z
  .object({
    status: z.literal("ok"),
    service: z.string(),
    version: z.string(),
    protocol: ProtocolRangeSchema,
    coreVersion: z.string(),
    hostId: z.string(),
    pid: z.number().int(),
  })
  .strict();
export const ReadyResponseSchema = z.object({
  status: z.enum(["ready", "not_ready"]),
  service: z.string(),
  checks: z.record(z.string(), z.boolean()),
  /** The open Tenant's harnesses: `connected` counts those on the Harness API listener. */
  harness: z
    .object({ mode: z.enum(["remote", "in-process"]), connected: z.number().int().nonnegative() })
    .optional(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type ReadyResponse = z.infer<typeof ReadyResponseSchema>;

export const ProtocolRejectedResponseSchema = z
  .object({
    status: z.literal("rejected"),
    code: z.literal("protocol_unsupported"),
    protocol: ProtocolRangeSchema,
  })
  .strict();
export type ProtocolRejectedResponse = z.infer<
  typeof ProtocolRejectedResponseSchema
>;

export const TenantEnvelopeSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    schemaVersion: z.number().int(),
  })
  .strict();
export type TenantEnvelope = z.infer<typeof TenantEnvelopeSchema>;

/**
 * Why a Host's Tenant is not open (`HostTenant.cause`): it could not be opened, and the Host
 * fails readiness until the cause is repaired and the Host restarted. `database-layout-old`:
 * the database was written by a Runtime from before one Tenant per installation; this release
 * starts fresh on a new database.
 */
export const TenantCauseSchema = z
  .object({
    code: z.enum([
      "kek-missing",
      "corrupt",
      "schema-too-new",
      "migration-failed",
      "envelope-invalid",
      "open-timeout",
      "open-failed",
      "database-layout-old",
    ]),
    message: z.string(),
    repair: z.string(),
  })
  .strict();
export type TenantCause = z.infer<typeof TenantCauseSchema>;

/**
 * The Host's one Tenant. `unavailable` while it opens, when opening it failed (`cause`), or
 * when it is closing.
 */
export const HostTenantSchema = z
  .object({
    /** Null until the Tenant row has been read (an old or newer database). */
    id: z.string().min(1).nullable(),
    name: z.string().nullable(),
    state: z.enum(["open", "unavailable"]),
    envelope: TenantEnvelopeSchema.nullable(),
    cause: TenantCauseSchema.optional(),
  })
  .strict();
export type HostTenant = z.infer<typeof HostTenantSchema>;

/** A stream relay's state (Durable Streams §7). */
export const StreamRelayStatusSchema = z
  .object({
    /** This process holds the replication slot (one process per slot does). */
    active: z.boolean(),
    /** Committed transactions not yet fully in S2. */
    pendingTxs: z.number().int().nonnegative(),
    /** Events queued for S2. */
    pendingRows: z.number().int().nonnegative(),
    /** The last position acknowledged to the slot. */
    confirmed: z.string().nullable(),
    /** Reconciliations of the record with S2 since start (a new or lost slot). */
    reconciliations: z.number().int().nonnegative(),
    lastError: z.string().nullable(),
    /** WAL bytes the slot holds that the relay has not confirmed, when known. */
    lagBytes: z.number().nonnegative().optional(),
  })
  .strict();
export type StreamRelayStatus = z.infer<typeof StreamRelayStatusSchema>;

/**
 * The Tenant's harnesses (F6.2): `in-process` runs one in core's process; `remote` waits for
 * harnesses on the Harness API listener. `workspace` says one that serves the Tenant's
 * workspaces is connected.
 */
export const HarnessStatusSchema = z
  .object({
    mode: z.enum(["in-process", "remote"]),
    connected: z.number().int().nonnegative(),
    workspace: z.boolean(),
  })
  .strict();
export type HarnessStatus = z.infer<typeof HarnessStatusSchema>;

/**
 * A key of the Tenant (`/v1/tenant/keys`, `nylorun-operate keys`), named by its id
 * (`APPLICATION_KEY_ID_PATTERN`), with its role. The Runtime keeps only its hash.
 */
export const OperatorKeySchema = z
  .object({
    id: z.string().min(1),
    role: z.string().min(1),
    /** When the current key was issued: created, or last rotated. */
    createdAt: z.string().min(1),
  })
  .strict();
export type OperatorKey = z.infer<typeof OperatorKeySchema>;
/** `GET /v1/tenant/keys`: the Tenant's keys, by id. */
export const ListOperatorKeysResponseSchema = z
  .object({ keys: z.array(OperatorKeySchema) })
  .strict();
export type ListOperatorKeysResponse = z.infer<typeof ListOperatorKeysResponseSchema>;
/** `PUT /v1/tenant/keys/{keyId}`: the new key, shown this once; `rotated` when it replaced one. */
export const PutOperatorKeyResponseSchema = OperatorKeySchema.extend({
  key: z.string().regex(/^[0-9a-f]{64}$/),
  rotated: z.boolean(),
}).strict();
export type PutOperatorKeyResponse = z.infer<typeof PutOperatorKeyResponseSchema>;
/** `DELETE /v1/tenant/keys/{keyId}`: the key no longer authenticates. */
export const DeleteOperatorKeyResponseSchema = z
  .object({ id: z.string().min(1), deleted: z.literal(true) })
  .strict();
export type DeleteOperatorKeyResponse = z.infer<typeof DeleteOperatorKeyResponseSchema>;

/**
 * `.nylorun/link.json`: the installation a Project uses. Format 3 names the local `tenant`
 * that `nylorun start` created or attached; `tenantId` is information only, since nothing in a
 * request selects a Tenant. Formats 0–2 are from older releases; they parse so readers can say
 * why they refuse them.
 */
export const ProjectLinkFileSchema = z
  .object({
    format: z
      .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
      .default(0),
    /** The local Tenant's name (format 3); absent for an installation that is not local. */
    tenant: z.string().min(1).optional(),
    hostUrl: z.string().min(1),
    hostId: z.string().min(1),
    tenantId: z.string().min(1).optional(),
  })
  .passthrough();
export type ProjectLinkFile = z.infer<typeof ProjectLinkFileSchema>;

/**
 * `.nylorun/credentials.json`: the Project's application key and, from protocol 8, its
 * management key. Still format 1: readers that predate the management key ignore it.
 */
export const ProjectCredentialsFileSchema = z
  .object({
    format: z.union([z.literal(0), z.literal(1)]).default(0),
    applicationKey: z.string().regex(/^[0-9a-f]{64}$/),
    principalId: z.string().min(1),
    managementKey: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    managementPrincipalId: z.string().min(1).optional(),
  })
  .passthrough();
export type ProjectCredentialsFile = z.infer<
  typeof ProjectCredentialsFileSchema
>;

export const HostModelViewSchema = z.union([
  z.object({ configured: z.literal(false) }).strict(),
  z
    .object({
      configured: z.literal(true),
      provider: z.string(),
      model: z.string(),
      authType: z.enum(["api_key", "oauth"]),
      baseUrl: z.string().optional(),
      settings: CustomModelSettingsSchema.optional(),
    })
    .strict(),
]);

export const TenantStatusSchema = z
  .object({
    tenant: TenantEnvelopeSchema,
    path: z.string().min(1),
    checks: z
      .object({
        store: z.boolean(),
        scheduler: z.boolean(),
        model: z.boolean(),
        schema: z.boolean(),
      })
      .strict(),
    model: HostModelViewSchema,
    /** The Tenant's Agents, by id. */
    agents: z.array(z.object({ agentId: z.string() }).strict()),
    counts: z
      .object({
        sessions: z.number().int().nonnegative(),
        runningSessions: z.number().int().nonnegative(),
        uncertainEffects: z.number().int().nonnegative(),
      })
      .strict(),
    sandbox: z
      .object({
        backend: z.string().nullable(),
        retained: z.number().int().nonnegative(),
      })
      .strict(),
    /** The Tenant's harnesses (F6.2). */
    harness: HarnessStatusSchema.optional(),
    /**
     * Durable Session Execution invocations of this Tenant that need an operator: paused
     * after exhausting retries, or backing off after failures. Absent when the execution
     * cannot report them; `error` when it could not be asked.
     */
    execution: z
      .object({
        stuckInvocations: z.array(
          z
            .object({
              id: z.string(),
              status: z.string(),
              service: z.string(),
              handler: z.string(),
              key: z.string(),
              retryCount: z.number().int().nonnegative(),
              lastFailure: z.string().optional(),
              modifiedAt: z.string().optional(),
            })
            .strict(),
        ),
        error: z.string().optional(),
      })
      .strict()
      .optional(),
    /**
     * This Tenant's Durable Streams: whether the service answers, its basin, the events
     * committed but not yet relayed, and how far the relay is behind.
     */
    streams: z
      .object({
        reachable: z.boolean(),
        basin: z
          .object({
            ready: z.boolean(),
            failures: z.number().int().nonnegative(),
            lastError: z.string().nullable(),
          })
          .strict(),
        /** The basin generation session streams are in (a reset moves to the next). */
        generation: z.number().int().nonnegative(),
        /** The Tenant's own relay; null when the Host's relay serves it. */
        relay: StreamRelayStatusSchema.nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type TenantStatus = z.infer<typeof TenantStatusSchema>;

const seedModelSchema = PutHostModelRequestSchema.omit({
  requestId: true,
  idempotencyKey: true,
});

export const SeedTenantConfigRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    sandbox: z
      .object({
        backend: z.enum(["auto", "virtual"]).optional(),
        /** Seeds Tenant setting `environments.config` when it is absent. */
        config: TenantEnvironmentsConfigSchema.optional(),
      })
      .strict()
      .optional(),
    model: seedModelSchema.optional(),
    /**
     * The Tenant's model calls use the Runtime's deterministic fixture model instead of its
     * host model, e.g. for the Tenant a smoke check resets (scripts/lib/stack-tenant.mjs). Stored
     * as Tenant setting `model.fixture`. Host feature `tenant-fixture-model`.
     */
    fixtureModel: z.literal(true).optional(),
  })
  .strict();
export type SeedTenantConfigRequest = z.infer<
  typeof SeedTenantConfigRequestSchema
>;

export const SeedTenantConfigResponseSchema = z
  .object({
    applied: z.array(z.string()),
    kept: z.array(z.string()),
  })
  .strict();
export type SeedTenantConfigResponse = z.infer<
  typeof SeedTenantConfigResponseSchema
>;

export const ResetTenantRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    scope: z.enum(["sessions", "agents", "all"]),
    activeWork: z.enum(["drain", "cancel"]),
  })
  .strict();
export type ResetTenantRequest = z.infer<typeof ResetTenantRequestSchema>;

/**
 * Acting for a subject (Host feature `subject-headers`): what an application principal may
 * narrow a request to. `sessions:own` reaches only the subject's own sessions; the others reach
 * Tenant-wide resources. `agents:write` creates, changes and deletes Agents and writes their
 * secrets (protocol 16; `environments:write` before); a token caller's reach only the ids its
 * Agent grants name. `agent-manifests:write` saves and deletes agent manifests.
 */
export const SUBJECT_SCOPES = [
  "agents:read",
  "agents:write",
  "sessions:own",
  "agent-manifests:write",
] as const;
export type SubjectScope = (typeof SUBJECT_SCOPES)[number];
/**
 * Retired scopes: `Nylorun-Scopes` may still name them (older clients do), and they grant
 * nothing. `vaults:own` left in protocol 7; `tenant:settings` in protocol 8, when the Tenant's
 * settings moved to the Management API, which no subject reaches.
 */
const RETIRED_SUBJECT_SCOPES: readonly string[] = ["vaults:own", "tenant:settings"];

/**
 * 1–200 visible ASCII characters; spaces only inside.
 * An identifier's grammar is the protocol's (B15): it crosses the Runtime API, tokens and grants
 * and means the same in every installation, so its length is a constant of protocol 15, not a
 * setting.
 */
const SUBJECT_PATTERN = /^[\x21-\x7e](?:[\x20-\x7e]{0,198}[\x21-\x7e])?$/;
/**
 * The owner of a session opened for no person: an MCP server's or HTTP tool's identity header
 * (R2b C2) names nobody for it. A reserved subject.
 */
export const INSTALLATION_OWNER = "installation";
/** Owner ids the Runtime uses itself: `host` (the model vault's) and `installation`. */
const RESERVED_SUBJECTS = new Set(["host", INSTALLATION_OWNER]);

/** A valid subject: 1–200 visible ASCII characters, not reserved by the Runtime. */
export function isSubject(value: unknown): value is string {
  return (
    typeof value === "string" &&
    SUBJECT_PATTERN.test(value) &&
    !RESERVED_SUBJECTS.has(value)
  );
}

/**
 * Validates `Nylorun-Subject` and `Nylorun-Scopes`. Returns the subject and its scopes, or a
 * message naming what is wrong. Scopes are required: the Runtime never grants a default.
 */
export function parseSubjectHeaders(
  subject: string,
  scopes: string | undefined
):
  | { ok: true; subject: string; scopes: ReadonlySet<SubjectScope> }
  | { ok: false; message: string } {
  if (!SUBJECT_PATTERN.test(subject))
    return {
      ok: false,
      message: "Nylorun-Subject must be 1-200 visible ASCII characters",
    };
  if (RESERVED_SUBJECTS.has(subject))
    return { ok: false, message: `Subject ${subject} is reserved` };
  const named = (scopes ?? "").split(" ").filter(Boolean);
  if (named.length === 0)
    return {
      ok: false,
      message: "Nylorun-Scopes is required with Nylorun-Subject",
    };
  const names = named.filter((name) => !RETIRED_SUBJECT_SCOPES.includes(name));
  if (names.includes("sandboxes:write") || names.includes("environments:write"))
    return {
      ok: false,
      message: "environments:write was renamed agents:write in protocol 16 (sandboxes:write before protocol 11)",
    };
  const unknown = names.filter(
    (name) => !(SUBJECT_SCOPES as readonly string[]).includes(name)
  );
  if (unknown.length > 0)
    return { ok: false, message: `Unknown scope ${unknown.join(", ")}` };
  return {
    ok: true,
    subject,
    scopes: new Set(names as SubjectScope[]),
  };
}

// --- token callers (Host feature `trusted-issuers`) ------------------------------------------

/**
 * Scopes a token caller (a trusted issuer's token) may carry: never `agent-manifests:write`.
 * `agents:write` reaches only the Agents its grants name.
 */
export const TOKEN_SCOPES = [
  "agents:read",
  "sessions:own",
  "agents:write",
] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];
/**
 * The `iss` of every token a Tenant's Runtime signs itself: capability links, run, host and
 * egress tokens.
 */
export function tenantTokenIssuer(tenantId: string): string {
  return `urn:nylorun:tenant:${tenantId}`;
}

/** The Agents a caller reaches: `*` for every one, or Agent grants (ids and `p/*` prefixes). */
const AgentAllowlistSchema = z.union([
  z.literal("*"),
  z.array(z.string().min(1)),
]);

export const SIGNING_KEY_STATES = ["standby", "current", "previous", "revoked"] as const;
export type SigningKeyState = (typeof SIGNING_KEY_STATES)[number];

/** A public JSON Web Key as the JWKS publishes it. */
export const PublicJwkSchema = z
  .object({
    kty: z.literal("EC"),
    crv: z.literal("P-256"),
    x: z.string(),
    y: z.string(),
    kid: z.string(),
    alg: z.literal("ES256"),
    use: z.literal("sig"),
  })
  .strict();
export type PublicJwk = z.infer<typeof PublicJwkSchema>;

export const SigningKeyViewSchema = z
  .object({
    id: z.string(),
    state: z.enum(SIGNING_KEY_STATES),
    alg: z.literal("ES256"),
    publicKey: PublicJwkSchema,
    createdAt: z.string(),
    activatedAt: z.string().nullable(),
    retiredAt: z.string().nullable(),
    revokedAt: z.string().nullable(),
  })
  .strict();
export type SigningKeyView = z.infer<typeof SigningKeyViewSchema>;

export const SigningKeyListSchema = z
  .object({ keys: z.array(SigningKeyViewSchema) })
  .strict();
export const JwksSchema = z.object({ keys: z.array(PublicJwkSchema) }).strict();
export type Jwks = z.infer<typeof JwksSchema>;

export const RotateSigningKeysRequestSchema = z
  .object({ requestId: RequestIdSchema, force: z.boolean().optional() })
  .strict();
export const RevokeSigningKeyRequestSchema = z
  .object({ requestId: RequestIdSchema })
  .strict();

// --- trusted issuers (Host feature `trusted-issuers`) --------------------------------------

/**
 * Scopes a trusted issuer's tokens may carry (`allowedScopes` in the identity file): the
 * token scopes, and `studio`, an operator scope no Runtime route requires (Studio
 * admits a person who holds it, Tenant-wide).
 */
export const ISSUER_SCOPES = [...TOKEN_SCOPES, "studio"] as const;
export type IssuerScope = (typeof ISSUER_SCOPES)[number];
/** Every scope a caller can hold: the subject scopes, and an issuer token's `studio`. */
export const CALLER_SCOPES = [...SUBJECT_SCOPES, "studio"] as const;
export type CallerScope = (typeof CALLER_SCOPES)[number];

/**
 * `GET /v1/me`: who the Runtime takes the caller to be, for any credential.
 *
 * - `via` is how the caller authenticated: `application:<principalId>` (an application key,
 *   acting as itself), `subject` (an application key acting for `Nylorun-Subject`) or
 *   `issuer:<name>` (a token from the identity file's issuer `name`).
 * - `subject` is the person the request acts for; absent for an application key alone.
 * - `scopes`: what the caller holds. An application key alone holds every subject scope.
 * - `agents`: the Agents it may reach: `*` for all, else a token caller's Agent grants (ids
 *   and `p/*` prefixes; empty reaches none).
 */
export const MeResponseSchema = z
  .object({
    subject: z
      .string()
      .optional()
      .meta({ description: "The person the request acts for; absent for an application key alone" }),
    scopes: z.array(z.enum(CALLER_SCOPES)),
    agents: AgentAllowlistSchema,
    via: z.string().meta({
      description:
        "How the caller authenticated: `application:<principalId>`, `management:<principalId>`, `subject` or `issuer:<name>`",
    }),
  })
  .strict();
export type MeResponse = z.infer<typeof MeResponseSchema>;

// --- origins ---------------------------------------------------------------------------------

/** True for a serialized web origin: `scheme://host[:port]`, lowercase, no path. */
export function isSerializedOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === "https:" || url.protocol === "http:") &&
    url.origin === value &&
    // Host names only: no wildcards or other characters URL parsing lets through.
    /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])$/.test(url.hostname)
  );
}

// Successful answers of the Runtime and Management APIs that had no schema of their own. With the
// request schemas above they describe every body the Runtime sends (its OpenAPI document).

/** `GET /v1/agents`: the Agents the caller reaches. */
export const ListAgentsResponseSchema = z
  .object({ agents: z.array(AgentViewSchema) })
  .strict();
export type ListAgentsResponse = z.infer<typeof ListAgentsResponseSchema>;

export const SESSION_STATUSES = [
  "idle",
  "runnable",
  "running",
  "waiting",
  "paused",
  "uncertain",
  "completed",
  "failed",
  "cancelled",
] as const;
export const SessionSummarySchema = z
  .object({
    id: z.string(),
    /** The Agent the session runs on. */
    agentId: z.string(),
    ownerUserId: z.string(),
    status: z.enum(SESSION_STATUSES),
    activeTurnId: z.string().nullable(),
  })
  .strict();
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
export const ListSessionsResponseSchema = z
  .object({ sessions: z.array(SessionSummarySchema) })
  .strict();
export type ListSessionsResponse = z.infer<typeof ListSessionsResponseSchema>;
/** `PUT` and `GET /v1/sessions/:id`. */
export const SessionViewSchema = z
  .object({
    id: z.string(),
    /** The Agent the session runs on (protocol 16). */
    agentId: z.string(),
    ownerUserId: z.string(),
    /**
     * The agent manifest version the session pinned when it opened: the one its Agent runs.
     * Absent for a session closed by protocol 16, opened from a definition.
     */
    manifest: z.object({ name: z.string(), version: z.number().int().positive() }).strict().nullable(),
    /** The hash of the loop manifest the session pinned. */
    manifestHash: z.string(),
    status: z.enum(SESSION_STATUSES),
    activeTurnId: z.string().nullable(),
    /** Messages waiting in the session's queue for the next turn (protocol 17). */
    queuedMessages: z.number().int().nonnegative(),
    /**
     * The harness that runs the session's turns, pinned when it opened (track R4): its
     * manifest's `harness.id`, else `nylorun`.
     */
    harness: z.string(),
    /**
     * Why the session takes no new turn, when it is closed: `protocol_16` for a session opened
     * before protocol 16 (from a definition), `protocol_13` for a session opened
     * before protocol 13, `protocol_11` for one opened before protocol 11 (a new turn is
     * `409 session_closed`; its history stays readable).
     */
    closedReason: z.string().optional(),
    mcpSnapshot: z.record(z.string(), z.unknown()).nullable(),
    mcpDiagnostics: z.array(z.record(z.string(), z.unknown())),
    /** What the session waits on: interactions, approvals, timers. */
    waits: z.unknown().optional(),
    error: z.string().optional(),
    uncertainEffects: z.array(
      z
        .object({
          effectId: z.string(),
          turnId: z.string(),
          kind: z.string(),
          error: z.unknown(),
        })
        .strict(),
    ),
  })
  .strict();
export type SessionView = z.infer<typeof SessionViewSchema>;

/** A sandbox tool call's answer (`POST …/sandbox/:tool`): its output, or why it failed. */
export const SandboxToolOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("completed"), output: z.unknown() }).strict(),
  z
    .object({ kind: z.literal("failed"), code: z.string(), message: z.string() })
    .strict(),
]);
export type SandboxToolOutcome = z.infer<typeof SandboxToolOutcomeSchema>;

export const ResetTenantResponseSchema = z.object({ ok: z.literal(true) }).strict();
export type ResetTenantResponse = z.infer<typeof ResetTenantResponseSchema>;
/**
 * `GET /v1/tenant/models`: public provider and model names, no credentials. Each model says what
 * it reads (`inputs`: its catalog's list and the operator's additions) and what the operator may
 * add (`addableInputs`, protocol 12).
 */
export const HostModelCatalogSchema = z
  .object({
    providers: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          models: z.array(
            z
              .object({
                id: z.string(),
                name: z.string(),
                inputs: z.array(ModelInputSchema),
                addableInputs: z.array(ModelInputSchema),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();
export type HostModelCatalog = z.infer<typeof HostModelCatalogSchema>;
export const HostModelProviderInfoSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    model: z.string(),
    authType: z.enum(["api_key", "oauth"]),
    baseUrl: z.string().optional(),
    settings: CustomModelSettingsSchema.optional(),
    /** What the provider's selected model reads (protocol 12); absent for a model unknown here. */
    inputs: z.array(ModelInputSchema).optional(),
    lastUpdated: z.string(),
    active: z.boolean(),
  })
  .strict();
/**
 * `PUT /v1/tenant/models/inputs`: the inputs one catalog model reads (protocol 12), replacing
 * what the operator added before. Its catalog's own inputs always stay; an empty list removes
 * the additions. A custom endpoint sets `settings.inputs` on `PUT /v1/tenant/model` instead.
 */
export const PutModelInputsRequestSchema = z
  .object({
    requestId: RequestIdSchema.optional(),
    provider: z.string().min(1),
    model: z.string().min(1),
    inputs: z.array(ModelInputSchema),
  })
  .strict();
export type PutModelInputsRequest = z.infer<typeof PutModelInputsRequestSchema>;
/** What one catalog model reads now: its catalog's inputs and the operator's additions. */
export const ModelInputsViewSchema = z
  .object({
    provider: z.string(),
    model: z.string(),
    inputs: z.array(ModelInputSchema),
  })
  .strict();
export type ModelInputsView = z.infer<typeof ModelInputsViewSchema>;
export const ListProvidersResponseSchema = z
  .object({ providers: z.array(HostModelProviderInfoSchema) })
  .strict();
export type ListProvidersResponse = z.infer<typeof ListProvidersResponseSchema>;
const SandboxResourcesLimitSchema = z
  .object({ cpus: z.number(), memoryMiB: z.number() })
  .strict();
/** A Tenant's Environment settings with every default applied (sizes in MiB). */
export const EffectiveSandboxConfigSchema = z
  .object({
    limits: z
      .object({
        network: z.array(z.string()),
        resources: SandboxResourcesLimitSchema,
        defaultResources: SandboxResourcesLimitSchema,
        idle: z.string(),
        /** The most Environments the Tenant may hold. */
        environments: z.number().int().nonnegative().optional(),
      })
      .strict(),
    /** Pods (Host feature `sandbox-pods`): the pod's stop grace. */
    lifecycle: z.object({ stopGrace: z.string() }).strict().optional(),
    /** Where each harness may run (D38). */
    placement: z
      .record(z.string(), z.object({ hosts: z.array(z.enum(PLACEMENT_HOSTS)) }).strict())
      .optional(),
  })
  .strict();
export type EffectiveSandboxConfig = z.infer<typeof EffectiveSandboxConfigSchema>;
const SandboxBackendNameSchema = z.enum(["virtual", "local"]);
const SandboxIsolationSchema = z.enum(["process", "container"]);
/** `GET` and `PUT /v1/tenant/sandbox`: the backend chosen, and the configuration in force. */
export const TenantSandboxViewSchema = z
  .object({
    preference: z.union([z.literal("auto"), SandboxBackendNameSchema]),
    backend: SandboxBackendNameSchema.nullable(),
    isolation: SandboxIsolationSchema.nullable(),
    reason: z.string(),
    probes: z.array(
      z
        .object({
          name: SandboxBackendNameSchema,
          available: z.boolean(),
          isolation: SandboxIsolationSchema,
          reason: z.string().optional(),
          version: z.string().optional(),
        })
        .strict(),
    ),
    defaultImage: z.string(),
    config: EffectiveSandboxConfigSchema,
    /**
     * The Tenant's cluster for pod sandboxes (`nylorun local sandbox enable`), as the sandboxes
     * service reports it; null without one, or when the service does not answer.
     */
    cluster: z
      .object({
        namespace: z.string(),
        context: z.string(),
        ready: z.boolean(),
        controllerVersion: z.string().optional(),
        networkPolicy: z.object({ enforced: z.boolean(), probedAt: z.string().optional() }).optional(),
      })
      .nullable()
      .optional(),
  })
  .strict();
export type TenantSandboxView = z.infer<typeof TenantSandboxViewSchema>;

/**
 * What a usage total or a budget covers: the whole Tenant, the Agents made from one agent manifest
 * (`manifest`, by its name; scope `agent` keyed a definition id before protocol 16), or one turn.
 */
export const ModelUsageScopeSchema = z.enum(["tenant", "manifest", "turn"]);
export type ModelUsageScope = z.infer<typeof ModelUsageScopeSchema>;

/** `GET /v1/tenant/usage`: which rows of the model usage ledger to total. */
export const ModelUsageQuerySchema = z
  .object({
    scope: ModelUsageScopeSchema.default("tenant"),
    /** The manifest's name or the turn id; required for those scopes. */
    id: z.string().min(1).optional(),
    /** The current UTC day or month, or every row. */
    period: z.enum(["day", "month", "total"]).default("total"),
  })
  .strict();
export type ModelUsageQuery = z.infer<typeof ModelUsageQuerySchema>;

/** The model calls the ledger recorded for one scope and period, and what they cost. */
export const ModelUsageTotalsSchema = z
  .object({
    scope: ModelUsageScopeSchema,
    id: z.string().optional(),
    period: z.enum(["day", "month", "total"]),
    /** When the period started (ISO); absent for `total`. */
    since: z.string().optional(),
    calls: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    /** pi-ai's catalog price; custom endpoints count as $0. */
    costUsd: z.number().nonnegative(),
  })
  .strict();
export type ModelUsageTotals = z.infer<typeof ModelUsageTotalsSchema>;

/**
 * A hard cap on model spend. Before each call the model gate checks the scope's spend (and its
 * calls in flight) against the cap; once it is reached the call fails with `budget_exhausted`
 * and the turn with `model.budget_exhausted`.
 */
export const ModelBudgetSchema = z
  .object({
    /**
     * `turn` caps every turn; `manifest` the sessions of every Agent made from one agent
     * manifest; `tenant` all of them.
     */
    scope: ModelUsageScopeSchema,
    /** The agent manifest's name; `manifest` only. */
    id: z.string().min(1).optional(),
    /** The UTC period spend counts over; `manifest` and `tenant` only. */
    period: z.enum(["day", "month"]).optional(),
    /** pi-ai's catalog price; custom endpoints count as $0, so cap them in tokens. */
    limitUsd: z.number().positive().optional(),
    limitTokens: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((budget, ctx) => {
    if (budget.limitUsd === undefined && budget.limitTokens === undefined)
      ctx.addIssue({ code: "custom", message: "A budget needs limitUsd, limitTokens or both" });
    if ((budget.scope === "manifest") !== (budget.id !== undefined))
      ctx.addIssue({ code: "custom", message: "A manifest budget names the agent manifest in id; other scopes take no id" });
    if ((budget.scope === "turn") === (budget.period !== undefined))
      ctx.addIssue({ code: "custom", message: "A turn budget takes no period; manifest and Tenant budgets need one" });
  });
export type ModelBudget = z.infer<typeof ModelBudgetSchema>;

/** `PUT /v1/tenant/budgets`: replaces every budget. An empty list removes them all. */
export const PutModelBudgetsRequestSchema = z
  .object({
    requestId: RequestIdSchema.optional(),
    /** At most the Tenant's Runtime limit `modelBudgets`, checked when they are put. */
    budgets: z.array(ModelBudgetSchema),
  })
  .strict()
  .superRefine((request, ctx) => {
    const seen = new Set<string>();
    for (const budget of request.budgets) {
      const key = `${budget.scope}:${budget.id ?? "*"}`;
      if (seen.has(key))
        ctx.addIssue({ code: "custom", message: `Two budgets for ${key}; set one per scope` });
      seen.add(key);
    }
  });
export type PutModelBudgetsRequest = z.infer<typeof PutModelBudgetsRequestSchema>;

export const ModelBudgetsSchema = z.object({ budgets: z.array(ModelBudgetSchema) }).strict();
export type ModelBudgets = z.infer<typeof ModelBudgetsSchema>;

/** What a tool policy rule does to a call it matches (R5 step 2). */
export const TOOL_POLICY_EFFECTS = ["allow", "ask", "deny"] as const;
/** A test of one field of a tool call's input; every test it sets must hold. */
export const ToolInputConditionSchema = z
  .object({
    equals: jsonValue.optional(),
    in: z.array(jsonValue).min(1).optional(),
    gt: z.number().optional(),
    gte: z.number().optional(),
    lt: z.number().optional(),
    lte: z.number().optional(),
    /**
     * A regular expression the field's string value must match: at most the Tenant's Runtime
     * limit `toolRuleTextChars`, checked when the policy is put.
     */
    matches: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((condition, ctx) => {
    if (Object.keys(condition).length === 0)
      ctx.addIssue({ code: "custom", message: "A condition sets at least one of equals, in, gt, gte, lt, lte or matches" });
    if (condition.matches !== undefined)
      try {
        new RegExp(condition.matches);
      } catch {
        ctx.addIssue({ code: "custom", path: ["matches"], message: `matches is not a regular expression: ${condition.matches}` });
      }
  });
export type ToolInputCondition = z.infer<typeof ToolInputConditionSchema>;
/**
 * One rule of the Tenant's tool policy (R5 step 2), applied at the Tool Gate to every MCP and
 * HTTP tool call of every harness. A rule matches a call when every selector it sets matches:
 * `tool` (the tool's identity: an MCP tool's own name on its server, or an HTTP tool's declared
 * name; never the name a harness gave the model; `*` for any run of characters), `server` (an MCP
 * server's name), `kind`, `agent` (the agent that calls it) and `when` (fields of the input, by
 * dotted path). The strictest matching rule decides: `deny` refuses the call before it is sent,
 * `ask` holds it until a person approves it on the session (`approve`), `allow` runs it. A call no
 * rule matches runs. Sandbox tools never cross the gate; their network side is egress policy.
 *
 * A `tool` with `__` in it is refused (protocol 15): no declared tool's name has one, so it can
 * only be an MCP tool's model-facing `server__tool` name. Name an MCP tool by `server` and `tool`.
 */
export const ToolRuleSchema = z
  .object({
    effect: z.enum(TOOL_POLICY_EFFECTS),
    // The selectors, and `when`'s paths, are at most the Tenant's Runtime limit
    // `toolRuleFieldChars` long; `reason` at most `toolRuleTextChars` (checked when put).
    tool: z.string().min(1).optional(),
    server: z.string().min(1).optional(),
    kind: z.enum(["mcp", "http"]).optional(),
    agent: z.string().min(1).optional(),
    when: z.record(z.string().min(1), ToolInputConditionSchema).optional(),
    /** Why the rule exists: shown with a held or denied call. */
    reason: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (rule.tool !== undefined && rule.tool.includes("__"))
      ctx.addIssue({
        code: "custom",
        path: ["tool"],
        message: `Name an MCP tool by \`server\` and \`tool\` (its own name on the server), not by a model-facing name such as '${rule.tool}'`,
      });
  });
export type ToolRule = z.infer<typeof ToolRuleSchema>;
/** `PUT /v1/tenant/tool-policy`: replaces every rule. An empty list allows every call. */
export const PutToolPolicyRequestSchema = z
  .object({
    requestId: RequestIdSchema.optional(),
    /** At most the Tenant's Runtime limit `toolRules`, checked when they are put. */
    rules: z.array(ToolRuleSchema),
  })
  .strict();
export type PutToolPolicyRequest = z.infer<typeof PutToolPolicyRequestSchema>;
/** The Tenant's tool policy; `updatedAt` is null until one is set. */
export const ToolPolicySchema = z
  .object({ rules: z.array(ToolRuleSchema), updatedAt: z.string().nullable() })
  .strict();
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;

/** A deleted resource. */
export const DeletedResponseSchema = z.object({ id: z.string() }).strict();
export type DeletedResponse = z.infer<typeof DeletedResponseSchema>;

/**
 * The last frame of a session stream the Runtime ends: `event: nylorun.closed`, when the
 * token caller's token expires.
 */
export const StreamClosedFrameSchema = z
  .object({ reason: z.enum(["token_expired"]) })
  .strict();
export type StreamClosedFrame = z.infer<typeof StreamClosedFrameSchema>;
/**
 * The `code` of an AG-UI `RUN_ERROR` the Runtime sends: a rejection's code, or `session_busy`
 * (another turn is running) or `runtime_error` (the Runtime failed). Never an HTTP body's code.
 */
export const AgUiRunErrorCodeSchema = z.enum([
  ...ERROR_CODES,
  "runtime_error",
]);
export type AgUiRunErrorCode = z.infer<typeof AgUiRunErrorCodeSchema>;

// --- Studio embedding (Studio design §8) ---------------------------------------------------

/**
 * A Tenant id as Studio's routes accept it.
 * An identifier's grammar is the protocol's (B15): it crosses the Runtime API, tokens and grants
 * and means the same in every installation, so its length is a constant of protocol 15, not a
 * setting.
 */
const STUDIO_TENANT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** `POST /_studio/login-tokens` body. No `tenant` mints a Host-wide token (the CLI's `{}`). */
export const StudioLoginTokenRequestSchema = z
  .object({
    tenant: z.string().regex(STUDIO_TENANT_ID, "must be a Tenant id").optional(),
    subject: z
      .string()
      .refine(isSubject, "must be 1–200 visible ASCII characters")
      .optional(),
  })
  .strict();
export type StudioLoginTokenRequest = z.infer<typeof StudioLoginTokenRequestSchema>;

export const StudioLoginTokenResponseSchema = z.object({
  /** Single-use, valid for two minutes. */
  token: z.string().min(1),
  /** The cookie login URL; refused for a token limited to a Tenant. */
  url: z.string().min(1),
  expiresAt: z.string().min(1),
  tenant: z.string().nullable(),
  subject: z.string().nullable(),
});
export type StudioLoginTokenResponse = z.infer<typeof StudioLoginTokenResponseSchema>;

/** `POST /_studio/sessions` body: the login token an embedder passed in `init`. */
export const StudioSessionRequestSchema = z.object({ token: z.string().min(1) }).strict();
export type StudioSessionRequest = z.infer<typeof StudioSessionRequestSchema>;

export const StudioSessionResponseSchema = z.object({
  /** Bearer for every `/_studio/*` request; kept in memory only. */
  sessionToken: z.string().min(1),
  tenant: z.string().nullable(),
  subject: z.string().nullable(),
  expiresAt: z.string().min(1),
});
export type StudioSessionResponse = z.infer<typeof StudioSessionResponseSchema>;

/** Message protocol versions this release speaks. */
export const STUDIO_EMBED_PROTOCOLS = [1] as const;
export const STUDIO_EMBED_MESSAGE_TYPE = "nylorun.studio";

const HEX_COLOR = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);

/** The embedder's theme. Unknown keys are dropped, not rejected. */
export const StudioThemeSchema = z.object({
  mode: z.enum(["light", "dark"]),
  accent: HEX_COLOR.optional(),
  background: HEX_COLOR.optional(),
  foreground: HEX_COLOR.optional(),
});
export type StudioTheme = z.infer<typeof StudioThemeSchema>;

const EMBED_ROUTE = z
  .string()
  .regex(/^\/tenants\/[^/?#\s]+(?:\/[^?#\s]*)?$/, "must be a Studio route under /tenants/");

const EXTERNAL_URL = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}, "must be an http or https URL");

function embed<const K extends string, S extends z.ZodRawShape>(kind: K, shape: S) {
  return z.object({
    type: z.literal(STUDIO_EMBED_MESSAGE_TYPE),
    protocol: z.number().int().positive(),
    kind: z.literal(kind),
    ...shape,
  });
}

/** Every message between an embedder and Studio (Studio design §8.8). */
export const StudioEmbedMessageSchema = z.discriminatedUnion("kind", [
  embed("ready", {
    protocols: z.array(z.number().int().positive()).min(1),
    studioVersion: z.string(),
  }),
  embed("init", {
    token: z.string().min(1),
    theme: StudioThemeSchema.optional(),
    route: EMBED_ROUTE.optional(),
  }),
  embed("token.refresh", { token: z.string().min(1) }),
  embed("theme.changed", { theme: StudioThemeSchema }),
  embed("navigate", { route: EMBED_ROUTE }),
  embed("session", {
    tenant: z.string().nullable(),
    subject: z.string().nullable(),
    expiresAt: z.string(),
  }),
  embed("token.expiring", { expiresAt: z.string().nullable() }),
  embed("route.changed", { route: z.string() }),
  embed("open.external", { url: EXTERNAL_URL }),
  /** Asks the embedding app to open this session in its own UI. */
  embed("open.session", { sessionId: z.string().min(1) }),
  embed("error", { code: z.string().min(1), message: z.string() }),
]);
export type StudioEmbedMessage = z.infer<typeof StudioEmbedMessageSchema>;
export type StudioEmbedKind = StudioEmbedMessage["kind"];

/** Schemes that never name an embedder. */
const NON_EMBEDDER_SCHEMES = new Set([
  "about",
  "blob",
  "data",
  "file",
  "filesystem",
  "javascript",
  "ws",
  "wss",
]);
const CUSTOM_ORIGIN =
  /^([a-z][a-z0-9+.-]*):\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(\d{1,5}))?$/;

/** True for one exact embedder origin: `https://…`, `http://…` or `<custom>://host[:port]`. */
export function isFrameAncestor(value: string): boolean {
  if (value.startsWith("http://") || value.startsWith("https://"))
    return isSerializedOrigin(value);
  const match = CUSTOM_ORIGIN.exec(value);
  if (!match) return false;
  if (NON_EMBEDDER_SCHEMES.has(match[1]!)) return false;
  return match[3] === undefined || Number(match[3]) <= 65535;
}

/**
 * Parses `NYLORUN_STUDIO_FRAME_ANCESTORS`: exact origins separated by whitespace. Wildcards,
 * keywords, scheme-only entries and paths are refused with the entry named. Empty gives `[]`.
 */
export function parseFrameAncestors(value: string): string[] {
  const entries = value.split(/\s+/).filter((entry) => entry !== "");
  for (const entry of entries)
    if (!isFrameAncestor(entry))
      throw new Error(
        `${entry} is not an exact origin. Use origins such as nylorun://localhost or https://app.example.com, with no wildcards or paths.`
      );
  return [...new Set(entries)];
}

// --- File artifacts (protocol 6, blueprint D35, F8.1) ----------------------------------------

/** The JWT `typ` of a capability link's token (RFC 8725 explicit typing). */
export const ARTIFACT_LINK_TOKEN_TYPE = "nylorun-artifact+jwt";
/**
 * How long a capability link lives when its request names no `expiresIn`: the request field's
 * default. A link lives no longer than any token the Runtime signs (the Host tuning's
 * `keys.tokenTtlMaxSeconds`, 900 s by default); a longer ask gets that.
 */
export const ARTIFACT_LINK_DEFAULT_TTL_SECONDS = 300;
/** A Tenant's limits when it sets none: 100 MiB per file, 10 GiB in all. */
export const ARTIFACT_FILE_BYTES_DEFAULT = 100 * 1024 * 1024;
export const ARTIFACT_TOTAL_BYTES_DEFAULT = 10 * 1024 * 1024 * 1024;
/**
 * The longest artifact name, in characters: the longest file name a workspace's file system takes
 * (`NAME_MAX`), since a name becomes one when the artifact is copied into a sandbox or downloaded.
 * A standard's constant, not a limit (B15).
 */
export const ARTIFACT_NAME_MAX = FILE_NAME_MAX;
/**
 * The longest path of a file in a folder artifact, in characters: the longest path a workspace's
 * file system takes (`PATH_MAX`), since the folder is unpacked there. A standard's constant.
 */
export const ARTIFACT_PATH_MAX = FILE_PATH_MAX;

/**
 * An artifact's labels. How many, and how long a key and a value may be, are the Tenant's Runtime
 * limits `artifactLabels`, `labelKeyChars` and `labelValueChars`, checked when they are set.
 */
export const ArtifactLabelsSchema = z.record(z.string().min(1), z.string());

/**
 * One version of an artifact: immutable once it exists. A folder version's `size` is the sum of
 * its files' sizes and its `sha256` is its manifest's.
 */
export const ArtifactVersionViewSchema = z
  .object({
    version: z.number().int().positive(),
    size: z.number().int().nonnegative(),
    sha256: z.string().meta({ description: "SHA-256 of the bytes (a folder: of its manifest), lowercase hex" }),
    contentType: z.string(),
    source: ArtifactSourceSchema,
    createdAt: z.string(),
  })
  .strict();
export type ArtifactVersionView = z.infer<typeof ArtifactVersionViewSchema>;

/**
 * An artifact: an id, a name and numbered versions, its bytes in the Object store. A file's
 * version is its bytes; a folder's (F8.2) is a manifest of paths to content-addressed files.
 */
export const ArtifactViewSchema = z
  .object({
    artifactId: z.string(),
    kind: ArtifactKindSchema,
    name: z.string(),
    contentType: z.string().meta({ description: "The latest version's media type" }),
    /** The session it belongs to; absent for a Tenant-wide artifact an application made. */
    sessionId: z.string().optional(),
    /**
     * The Agent whose disk versions it holds (R2d step 3); absent otherwise. Such an artifact
     * changes only through `/v1/agents/{id}/snapshot` and its versions routes.
     */
    agentId: z.string().optional(),
    latestVersion: z.number().int().positive(),
    labels: z.record(z.string(), z.string()).optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    /** Every version, oldest first (`GET /v1/artifacts/{id}` only). */
    versions: z.array(ArtifactVersionViewSchema).optional(),
  })
  .strict();
export type ArtifactView = z.infer<typeof ArtifactViewSchema>;

export const ListArtifactsResponseSchema = z
  .object({ artifacts: z.array(ArtifactViewSchema) })
  .strict();
export type ListArtifactsResponse = z.infer<typeof ListArtifactsResponseSchema>;

/** Paged metadata only; read the artifact separately for its version history and bytes. */
export const ArtifactListItemSchema = ArtifactViewSchema.omit({ versions: true });
export type ArtifactListItem = z.infer<typeof ArtifactListItemSchema>;
export const ArtifactPageSchema = z
  .object({ artifacts: z.array(ArtifactListItemSchema), nextCursor: z.string().nullable() })
  .strict();
export type ArtifactPage = z.infer<typeof ArtifactPageSchema>;

/** What an upload answers: the artifact, and the version the upload created. */
export const UploadArtifactResponseSchema = z
  .object({ artifact: ArtifactViewSchema, version: ArtifactVersionViewSchema })
  .strict();
export type UploadArtifactResponse = z.infer<typeof UploadArtifactResponseSchema>;

/**
 * `PUT /v1/files/sha256:{hex}`: a definition file the Runtime holds (track R2 M4), named by the
 * SHA-256 of its bytes. `201` stored it, `200` already had it.
 */
export const DefinitionFileViewSchema = z
  .object({
    sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    size: z.number().int().nonnegative(),
  })
  .strict();
export type DefinitionFileView = z.infer<typeof DefinitionFileViewSchema>;

export const DeleteArtifactResponseSchema = z
  .object({ artifactId: z.string(), deleted: z.boolean() })
  .strict();
export type DeleteArtifactResponse = z.infer<typeof DeleteArtifactResponseSchema>;

/** `POST /v1/artifacts/{id}/links`: a capability link to one version. */
export const CreateArtifactLinkRequestSchema = z
  .object({
    requestId: RequestIdSchema.optional(),
    /** The version to open. Default: the latest. */
    version: z.number().int().positive().optional(),
    /** Seconds until the link stops working. Default 300; a link lives at most the Host's `keys.tokenTtlMaxSeconds` (900 s by default). */
    expiresIn: z.number().int().min(1).optional(),
    /**
     * A folder's file, by its path in the folder: the link opens that one file. Without it, a
     * folder's link opens its zip.
     */
    file: z.string().min(1).max(ARTIFACT_PATH_MAX).optional(),
  })
  .strict();
export type CreateArtifactLinkRequest = z.infer<typeof CreateArtifactLinkRequestSchema>;

/** A capability link: `GET` its path on the Runtime with no credential, until it expires. */
export const ArtifactLinkSchema = z
  .object({
    /** `/v1/artifact-links/<token>`, on the Runtime that minted it. */
    path: z.string(),
    artifactId: z.string(),
    version: z.number().int().positive(),
    /** The folder's file the link opens; absent for a file artifact, or a folder's zip. */
    file: z.string().optional(),
    expiresAt: z.string(),
  })
  .strict();
export type ArtifactLink = z.infer<typeof ArtifactLinkSchema>;

// --- Folder artifacts (protocol 6, F8.2) -------------------------------------------------------

/** The media type of a folder artifact and of its manifests. */
export const FOLDER_CONTENT_TYPE = "application/vnd.nylorun.folder+json";
/** The manifest format a folder version is stored as. */
export const FOLDER_MANIFEST_FORMAT = "nylorun.folder.v1";
/**
 * The manifest format of an Environment's disk versions (R2d step 3): v1's entries, plus file
 * modes and modification times, symbolic links and empty directories. Readers accept both.
 */
export const FOLDER_MANIFEST_FORMAT_V2 = "nylorun.folder.v2";
/** The folder artifact our engine saves a session's outputs to at each turn's end, one per session. */
export const OUTPUTS_ARTIFACT_NAME = "outputs";

/**
 * One file of a folder: its path in the folder (`/`-separated, relative), size, hash and type.
 * In a v2 manifest an entry may also be a symbolic link (`type: "link"`, its `target`) or an
 * empty directory (`type: "dir"`), with no bytes (`size` 0, `sha256` and `contentType` empty),
 * and any entry may carry its `mode` and `mtimeMs`.
 */
export const FolderEntrySchema = z
  .object({
    path: z.string().min(1).max(ARTIFACT_PATH_MAX),
    size: z.number().int().nonnegative(),
    sha256: z.string().meta({ description: "SHA-256 of the file's bytes, lowercase hex" }),
    contentType: z.string(),
    /** v2: absent for a file. */
    type: z.enum(["link", "dir"]).optional(),
    /** v2: the permission bits (`0o755` is 493). */
    mode: z.number().int().nonnegative().max(0o7777).optional(),
    /** v2: the modification time, ms since the epoch. */
    mtimeMs: z.number().nonnegative().optional(),
    /** v2: a link's target, as stored on the disk. */
    target: z.string().max(LINK_TARGET_MAX).optional(),
  })
  .strict();
export type FolderEntry = z.infer<typeof FolderEntrySchema>;

/**
 * A folder version as stored: the files, sorted by path, each naming its content-addressed
 * bytes by SHA-256. The one manifest format for folders, reused by P5's snapshots.
 */
export const FolderManifestSchema = z
  .object({
    format: z.enum([FOLDER_MANIFEST_FORMAT, FOLDER_MANIFEST_FORMAT_V2]),
    entries: z.array(FolderEntrySchema),
  })
  .strict();
export type FolderManifest = z.infer<typeof FolderManifestSchema>;

/** `GET /v1/artifacts/{id}/versions/{n|latest}/tree`: a folder version's files. */
export const ArtifactTreeSchema = z
  .object({
    artifactId: z.string(),
    version: z.number().int().positive(),
    /** Every file, sorted by path. */
    entries: z.array(FolderEntrySchema),
  })
  .strict();
export type ArtifactTree = z.infer<typeof ArtifactTreeSchema>;

/** `GET /v1/artifacts/{id}/versions/{n|latest}/diff?from=m`: what changed between two versions. */
export const ArtifactDiffSchema = z
  .object({
    artifactId: z.string(),
    /** The version compared against; absent when there is none (version 1, no `from`). */
    from: z.number().int().positive().optional(),
    to: z.number().int().positive(),
    /** Files only in `to`, sorted by path. */
    added: z.array(FolderEntrySchema),
    /** Files only in `from`. */
    removed: z.array(FolderEntrySchema),
    /** Files in both whose bytes or media type differ. */
    changed: z.array(
      z.object({ path: z.string(), from: FolderEntrySchema, to: FolderEntrySchema }).strict(),
    ),
  })
  .strict();
export type ArtifactDiff = z.infer<typeof ArtifactDiffSchema>;

/** A Tenant's artifact limits, stored as Tenant setting `artifacts.config`. */
export const TenantArtifactsConfigSchema = z
  .object({
    limits: z
      .object({
        /** The largest file one upload may store, in bytes. Default 100 MiB. */
        fileBytes: z.number().int().positive().optional(),
        /** The most bytes every artifact version together may hold. Default 10 GiB. */
        totalBytes: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type TenantArtifactsConfig = z.infer<typeof TenantArtifactsConfigSchema>;
/** `PUT /v1/tenant/artifacts`: replaces the Tenant's artifact configuration. */
export const PutTenantArtifactsRequestSchema = TenantArtifactsConfigSchema.extend({
  requestId: RequestIdSchema.optional(),
}).strict();
export type PutTenantArtifactsRequest = z.infer<typeof PutTenantArtifactsRequestSchema>;
export const TenantArtifactsViewSchema = z
  .object({
    limits: z.object({ fileBytes: z.number().int(), totalBytes: z.number().int() }).strict(),
    /**
     * Bytes the artifacts store now: every file version, plus each distinct file of the folders
     * once (folders share content-addressed files).
     */
    usedBytes: z.number().int().nonnegative(),
  })
  .strict();
export type TenantArtifactsView = z.infer<typeof TenantArtifactsViewSchema>;

/**
 * A Tenant's skill limits, stored as Tenant setting `skills.config`: the most bytes one skill's
 * files may hold together. Unset, it is `SKILL_TOTAL_BYTES_DEFAULT` (2 GiB).
 */
export const TenantSkillsConfigSchema = z
  .object({
    limits: z
      .object({
        /** The most bytes one skill's files may hold together. Default 2 GiB. */
        totalBytes: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type TenantSkillsConfig = z.infer<typeof TenantSkillsConfigSchema>;
/** `PUT /v1/tenant/skills`: replaces the Tenant's skill configuration. */
export const PutTenantSkillsRequestSchema = TenantSkillsConfigSchema.extend({
  requestId: RequestIdSchema.optional(),
}).strict();
export type PutTenantSkillsRequest = z.infer<typeof PutTenantSkillsRequestSchema>;
export const TenantSkillsViewSchema = z
  .object({ limits: z.object({ totalBytes: z.number().int() }).strict() })
  .strict();
export type TenantSkillsView = z.infer<typeof TenantSkillsViewSchema>;

/**
 * A Tenant's Runtime limits (harness boundary S0), stored as Tenant setting `limits.config`: what
 * one record entry, model call, model file, tool answer, harness state and Harness API chunk may
 * hold. Each limit left out is its default (`RUNTIME_LIMIT_DEFAULTS`); none may pass its ceiling
 * (`RUNTIME_LIMIT_CEILINGS`, a `400` naming it).
 */
export const TenantLimitsConfigSchema = z
  .object({ limits: RuntimeLimitsSchema.partial().strict().optional() })
  .strict();
export type TenantLimitsConfig = z.infer<typeof TenantLimitsConfigSchema>;
/** `PUT /v1/tenant/limits`: replaces the Tenant's Runtime limits. */
export const PutTenantLimitsRequestSchema = TenantLimitsConfigSchema.extend({
  requestId: RequestIdSchema.optional(),
}).strict();
export type PutTenantLimitsRequest = z.infer<typeof PutTenantLimitsRequestSchema>;
/** The Runtime limits in force: the Tenant's, with the default for each it leaves out. */
export const TenantLimitsViewSchema = z.object({ limits: RuntimeLimitsSchema }).strict();
export type TenantLimitsView = z.infer<typeof TenantLimitsViewSchema>;

/** Opt-in session reads (Host feature `session-reads`). */
export const SessionListItemSchema = SessionSummarySchema.extend({
  lastTurnId: z.string().nullable(),
  createdAt: z.string().nullable(),
  lastEventAt: z.string().nullable(),
}).strict();
export type SessionListItem = z.infer<typeof SessionListItemSchema>;
export const SessionPageSchema = z
  .object({ sessions: z.array(SessionListItemSchema), nextCursor: z.string().nullable() })
  .strict();
export type SessionPage = z.infer<typeof SessionPageSchema>;
export const SessionManifestViewSchema = z
  .object({
    sessionId: z.string(),
    /** The Agent the session runs on. */
    agentId: z.string(),
    /** The agent manifest version it pinned; `null` for a session closed by protocol 16. */
    definition: z.object({ name: z.string(), version: z.number().int().positive() }).strict().nullable(),
    manifestHash: z.string(),
    /** The loop manifest it pinned: that version's harness section, as the harness runs it. */
    manifest: z.record(z.string(), z.unknown()),
  })
  .strict();
export type SessionManifestView = z.infer<typeof SessionManifestViewSchema>;
export const HistoryPageSchema = SessionItemsResponseSchema.extend({ tail: z.boolean() });
export type HistoryPage = z.infer<typeof HistoryPageSchema>;
const usageNumbers = {
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
};
export const SessionUsageTotalsSchema = z
  .object({
    sessionId: z.string(),
    turnId: z.string().nullable(),
    asOf: z.string(),
    ...usageNumbers,
    calls: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
    unpricedCalls: z.number().int().nonnegative(),
    unreportedCalls: z.number().int().nonnegative(),
    unknownQualityCalls: z.number().int().nonnegative(),
  })
  .strict();
export type SessionUsageTotals = z.infer<typeof SessionUsageTotalsSchema>;
export const ModelCallSchema = z
  .object({
    id: z.string(),
    /**
     * The model effect the call served: the effect id its harness sent as `Idempotency-Key`
     * (track R4), so a call is joined to the journal.
     */
    effectId: z.string(),
    sessionId: z.string(),
    turnId: z.string(),
    /** The agent manifest the calling agent came from (protocol 16; `agentId` before). */
    manifestName: z.string(),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    at: z.string(),
    outcome: z.enum(["completed", "failed"]),
    usage: z
      .object({
        ...usageNumbers,
        duplicate: z.boolean(),
        tokensReported: z.boolean().nullable(),
        costKnown: z.boolean().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type ModelCall = z.infer<typeof ModelCallSchema>;
export const ModelCallsPageSchema = z
  .object({ calls: z.array(ModelCallSchema), nextCursor: z.string().nullable(), asOf: z.string() })
  .strict();
export type ModelCallsPage = z.infer<typeof ModelCallsPageSchema>;
export const ModelCallExportPageSchema = z
  .object({
    calls: z.array(ModelCallSchema),
    next: z.string().nullable(),
    caughtUp: z.boolean(),
    asOf: z.string(),
  })
  .strict();
export type ModelCallExportPage = z.infer<typeof ModelCallExportPageSchema>;
/**
 * One tool call of a session (R5.2), read from the effect journal: what ran, with what input,
 * how many sends, and how it ended. `invoking` while it runs. `uncertain` only for a call
 * recorded before R5. The output is in the session's log (`tool.completed`).
 */
export const ToolCallSchema = z
  .object({
    effectId: z.string(),
    turnId: z.string(),
    callId: z.string().nullable(),
    /** The name the model called it by: for display. */
    toolName: z.string().nullable(),
    kind: z.enum(TOOL_CALL_KINDS).nullable(),
    server: z.string().nullable(),
    /** Its identity (see `tool.completed`): an MCP tool's name on `server`, an HTTP tool's declared name. */
    tool: z.string().nullable(),
    /** The skill the call ran (see `tool.completed`). */
    skill: z.string().nullable(),
    /** The Agent Plugin that brought its MCP server or skill. */
    plugin: pluginLabelSchema.nullable(),
    /** `held`: the Tool Gate holds it for a person's approval (R5 step 2). */
    status: z.enum(["invoking", "held", ...TOOL_CALL_STATUSES, "uncertain"]),
    attempts: z.number().int().nonnegative(),
    input: z.unknown(),
    error: z.object({ code: z.string(), message: z.string() }).strict().nullable(),
    startedAt: z.string().nullable(),
    settledAt: z.string().nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type ToolCall = z.infer<typeof ToolCallSchema>;
export const ToolCallsPageSchema = z
  .object({ calls: z.array(ToolCallSchema), nextCursor: z.string().nullable(), asOf: z.string() })
  .strict();
export type ToolCallsPage = z.infer<typeof ToolCallsPageSchema>;
/** One OTLP attribute (R7.5): a key and an `AnyValue` (`stringValue`, `intValue`, …). */
export const OtlpKeyValueSchema = z
  .object({ key: z.string(), value: z.record(z.string(), z.unknown()) })
  .passthrough();
/**
 * One span as OTLP/HTTP JSON encodes it (R7.5): hex ids, times in nanoseconds as decimal strings,
 * `kind` (1 internal, 3 client) and `status.code` (0 unset, 1 ok, 2 error) as numbers.
 */
export const OtlpSpanSchema = z
  .object({
    traceId: z.string(),
    spanId: z.string(),
    parentSpanId: z.string().optional(),
    name: z.string(),
    kind: z.number().int(),
    startTimeUnixNano: z.string(),
    endTimeUnixNano: z.string(),
    attributes: z.array(OtlpKeyValueSchema),
    status: z.object({ code: z.number().int(), message: z.string().optional() }).passthrough(),
  })
  .passthrough();
export type OtlpSpan = z.infer<typeof OtlpSpanSchema>;
/**
 * A turn's trace (R7.5, feature `traces`): the OTLP `ExportTraceServiceRequest` JSON the Runtime
 * posts to a collector, built from the turn's log rows. One resource, one scope.
 */
export const TurnTraceSchema = z
  .object({
    resourceSpans: z.array(
      z
        .object({
          resource: z.object({ attributes: z.array(OtlpKeyValueSchema) }).passthrough(),
          scopeSpans: z.array(
            z
              .object({
                scope: z.object({ name: z.string(), version: z.string().optional() }).passthrough(),
                spans: z.array(OtlpSpanSchema),
              })
              .passthrough(),
          ),
        })
        .passthrough(),
    ),
  })
  .passthrough();
export type TurnTrace = z.infer<typeof TurnTraceSchema>;
export const AgentPageSchema = z
  .object({ agents: z.array(AgentViewSchema), nextCursor: z.string().nullable() })
  .strict();
export type AgentPage = z.infer<typeof AgentPageSchema>;
