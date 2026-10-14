/** Public wire contracts only. Never import checkpoint or engine modules here. */
import { z } from "zod";
import type { AgentManifest, McpServerManifest } from "./types/manifest.js";
import type { JsonObject, JsonValue } from "./types/shared.js";
import type { WorkflowLoopVerify, WorkflowManifest, WorkflowNode } from "./types/workflow.js";
import {
  SANDBOX_NETWORK_PRESETS,
  SANDBOX_TOOL_NAMES,
  isSandboxHostPattern,
  parseSandboxDuration,
  parseSandboxSize,
} from "./utils/sandbox.js";
import {
  REMOVED_MANIFEST_FIELDS,
  manifestVersionIssue,
  workflowVersionIssue,
} from "./definition/removed.js";
import { RUNTIME_TOOL_NAMES } from "./utils/runtime-tools.js";
import { DELEGATE_INPUT_SCHEMA, DELEGATE_NAME_PATTERN } from "./definition/delegate.js";
import { stdioMcpRefusal } from "./definition/mcp.js";
import {
  APPROVAL_MODES,
  HTTP_TOOL_MAX_TIMEOUT_MS,
  HTTP_TOOL_METHODS,
  httpUrlIssue,
} from "./definition/http-tool.js";
import { canonical } from "./utils/canonical.js";
import { DEFAULT_HARNESS, HARNESS_ID_PATTERN, isHarnessId } from "./utils/harness-id.js";
export { DEFAULT_HARNESS, HARNESS_ID_PATTERN, isHarnessId };
import { DEFINITION_FILE_MAX_BYTES, skillFilesIssue } from "./utils/definition-files.js";
export type { AgentManifest } from "./types/manifest.js";
export type { WorkflowManifest } from "./types/workflow.js";
export { PROTOCOL_VERSION, ERROR_CODES } from "./compatibility.js";
export {
  DEFINITION_FILE_MAX_BYTES,
  SKILL_FILES_MAX,
  definitionFilesOf,
  isDefinitionFileHash,
} from "./utils/definition-files.js";
export type { ErrorCode } from "./compatibility.js";
import { ERROR_CODES, isArtifactId } from "./compatibility.js";
export const RequestIdSchema = z.string().min(1);
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
        cpus: z.number().int().min(1).max(64).optional(),
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
      const issue = httpUrlIssue(url);
      if (issue) ctx.addIssue({ code: "custom", message: issue });
    }),
    method: z.enum(HTTP_TOOL_METHODS).optional(),
    credential: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().max(HTTP_TOOL_MAX_TIMEOUT_MS).optional(),
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
  });
/** A manifest naming a removed field is refused with what replaces it. */
const removedFieldError =
  (removedFields: Readonly<Record<string, string>>) =>
  (issue: { code?: string; keys?: readonly string[] }) => {
    if (issue.code !== "unrecognized_keys") return undefined;
    const removed = issue.keys?.find((key) => removedFields[key] !== undefined);
    return removed === undefined ? undefined : removedFields[removed];
  };
/** What the Runtime adds to a session's agent; only the Runtime writes it. */
const runtimeManifestSchema = z
  .object({
    sandbox: sandboxManifestSchema.optional(),
    tools: z.array(toolManifestSchema).optional(),
    instructions: z.array(z.string()).optional(),
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
      runtime: runtimeManifestSchema.optional(),
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
      if (RUNTIME_TOOL_NAMES.has(tool.name))
        ctx.addIssue({
          code: "custom",
          message: `Tool '${tool.name}' takes the name of a tool the Runtime serves; rename it`,
        });
      if (tool.name.includes("__"))
        ctx.addIssue({
          code: "custom",
          message: `Tool '${tool.name}' must not contain '__', which names an MCP server's tools`,
        });
    }
    for (const tool of [...(manifest.tools ?? []), ...(manifest.runtime?.tools ?? [])]) {
      if (names.has(tool.name))
        ctx.addIssue({ code: "custom", message: "Tool names must be unique" });
      names.add(tool.name);
    }
    for (const tool of manifest.runtime?.tools ?? [])
      if (!RUNTIME_TOOL_NAMES.has(tool.name))
        ctx.addIssue({
          code: "custom",
          message: `runtime.tools holds only the tools the Runtime serves, not '${tool.name}'`,
        });
    if (manifest.runtime?.sandbox !== undefined) {
      const pinned = new Set((manifest.runtime.tools ?? []).map((tool) => tool.name));
      for (const name of SANDBOX_TOOL_NAMES)
        if (!pinned.has(name))
          ctx.addIssue({
            code: "custom",
            message: `runtime.sandbox comes with the sandbox tools; runtime.tools has no '${name}'`,
          });
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
/** Agents used as tools: one level deep, `{ task }` input, one shared sandbox spec. */
function delegationIssues(manifest: AgentManifest, issue: (message: string) => void): void {
  const sandboxes = new Set<string>();
  const addSandbox = (agent: AgentManifest) => {
    if (agent.runtime?.sandbox) sandboxes.add(canonical(agent.runtime.sandbox));
  };
  addSandbox(manifest);
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
    if ("kind" in child) {
      // A flow agent runs in its own linked session; its leaves may delegate in turn.
      if (child.sandbox !== undefined && Object.keys(child.sandbox).length > 0)
        sandboxes.add(canonical(child.sandbox));
      continue;
    }
    if (child.tools?.some((item) => item.agent !== undefined))
      issue(`'${child.id}' delegates to another agent; nested delegation is not supported yet`);
    addSandbox(child);
  }
  if (sandboxes.size > 1)
    issue("An agent and the agents it uses as tools must declare identical sandboxes");
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
          .strict(),
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
/** Registry document: agent (no `kind`, or legacy) or workflow (`kind: "workflow"`). */
export const DefinitionDocumentSchema = z.union([
  AgentManifestSchema,
  WorkflowManifestSchema,
]);
export type DefinitionDocument = AgentManifest | WorkflowManifest;
export const PutAgentRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    /** Agent or workflow document. Registry `kind` is carried on the document. */
    manifest: DefinitionDocumentSchema,
    implementationVersion: z.string().min(1),
  })
  .strict();
export type PutAgentRequest = z.infer<typeof PutAgentRequestSchema>;
const hostPatternSchema = z.string().refine(isSandboxHostPattern, {
  message: "network.allowedHosts entries must be host names such as api.github.com or *.example.com",
});
const durationSchema = (name: string) =>
  z.string().refine((value) => parseSandboxDuration(value) !== undefined, {
    message: `${name} must be a duration such as 30s, 15m or 1h`,
  });
const resourcesSchema = z
  .object({
    cpus: z.number().int().min(1).max(64).optional(),
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
 * An Environment id: 1–200 characters, one or more `/`-separated segments of letters, digits,
 * `.`, `_` and `-`, each starting with a letter or digit (`user-42`, `users/alice/web`). Ids are
 * hierarchical so a grant can name a family of them (`users/alice/*`).
 */
const ENVIRONMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
export const ENVIRONMENT_ID_MAX_LENGTH = 200;

export function isEnvironmentId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= ENVIRONMENT_ID_MAX_LENGTH &&
    ENVIRONMENT_ID_PATTERN.test(value)
  );
}

/** An Environment grant: an exact Environment id, or a prefix ending in `/*` (`team-a/*`). */
export function isEnvironmentGrant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return value.endsWith("/*") ? isEnvironmentId(value.slice(0, -2)) : isEnvironmentId(value);
}

/**
 * Whether `grants` (a token caller's Environment grants) reach Environment `id`: an exact entry,
 * or a prefix entry `p/*` for any id below `p/`. No grants reach no Environment.
 */
export function environmentGranted(grants: readonly string[] | undefined, id: string): boolean {
  for (const grant of grants ?? []) {
    if (grant.endsWith("/*")) {
      if (id.startsWith(grant.slice(0, -1))) return true;
    } else if (grant === id) return true;
  }
  return false;
}

export const EnvironmentIdSchema = z
  .string()
  .refine(isEnvironmentId, {
    message:
      "An Environment id is up to 200 characters: /-separated segments of letters, digits, '.', '_' and '-'",
  })
  .meta({ description: "An Environment id, such as `user-42` or `users/alice/web`" });
export const EnvironmentGrantSchema = z.string().refine(isEnvironmentGrant, {
  message: "An Environment grant is an Environment id, or a prefix ending in /* such as team-a/*",
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

const LABEL_KEY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,61}[A-Za-z0-9])?$/;
const LABEL_VALUE_PATTERN = /^[\x20-\x7e]{0,256}$/;
export const ENVIRONMENT_LABELS_MAX = 32;
/** The developer's own key-value pairs; the Runtime stores and filters them, never reads them. */
export const EnvironmentLabelsSchema = z
  .record(
    z.string().regex(LABEL_KEY_PATTERN, {
      message: "Label keys are 1-63 letters, digits, '.', '_', '/' and '-'",
    }),
    z.string().regex(LABEL_VALUE_PATTERN, {
      message: "Label values are up to 256 printable ASCII characters",
    }),
  )
  .refine((labels) => Object.keys(labels).length <= ENVIRONMENT_LABELS_MAX, {
    message: `At most ${ENVIRONMENT_LABELS_MAX} labels`,
  });
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

/** The most setup commands and input files an Environment's recipe holds (step 2). */
export const ENVIRONMENT_SETUP_MAX = 16;
/** A setup command's longest timeout (default 10m). */
export const ENVIRONMENT_SETUP_TIMEOUT_MAX_MS = 30 * 60_000;
const absoluteWorkspacePath = (name: string) =>
  z
    .string()
    .min(1)
    .max(1024)
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
    command: z.string().min(1).max(4096),
    /** Where it runs. Default `/workspace`. */
    cwd: absoluteWorkspacePath("cwd").optional(),
    /** Default 10m, at most 30m. */
    timeout: durationSchema("timeout")
      .refine((value) => (parseSandboxDuration(value) ?? 0) <= ENVIRONMENT_SETUP_TIMEOUT_MAX_MS, {
        message: "timeout is at most 30m",
      })
      .optional(),
  })
  .strict();
export type EnvironmentSetupCommand = z.infer<typeof EnvironmentSetupCommandSchema>;
/**
 * One input file (pods only): a version of a Tenant-wide artifact, copied in when the pod's disk
 * is made or reset, before the setup commands. A file artifact is written at `path`; a folder
 * artifact is unpacked under it.
 */
export const EnvironmentFileSchema = z
  .object({
    artifactId: z.string().refine(isArtifactId, { message: "artifactId must be an artifact id" }),
    version: z.number().int().positive(),
    path: absoluteWorkspacePath("path"),
  })
  .strict();
export type EnvironmentFile = z.infer<typeof EnvironmentFileSchema>;

/**
 * `PUT /v1/environments/{environmentId}`: creates the Environment and its vault, or finds the
 * one with this id, so "get or create" is one call. On an existing one the fields sent are
 * compared: `kind` and `storage` are fixed (a difference is `409`), `labels` replace its labels,
 * and any other difference changes its recipe and bumps its `version`. Image and resources
 * reach a pod when it next starts from stopped; `network.allowedHosts` applies within seconds.
 * A `PUT` that changes nothing answers the view unchanged.
 */
export const PutEnvironmentRequestSchema = z
  .object({
    requestId: RequestIdSchema.optional(),
    /** Default `virtual`. `pod` needs sandbox pods (`nylorun local sandbox enable`). Fixed. */
    kind: z.enum(ENVIRONMENT_KINDS).optional(),
    labels: EnvironmentLabelsSchema.optional(),
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
    /**
     * The harness that runs the Environment's sessions (track R4): `nylorun` (ours, the default)
     * or the id of a custom harness. A pod Environment whose harness is not ours runs its
     * `image` as the harness: the image's own entrypoint, with nothing copied in. Each session
     * pins the harness when it opens; a session whose Environment's harness changed later fails
     * its next turn with `harness_mismatch`.
     */
    harness: HarnessIdSchema.optional(),
    /**
     * The owner guard: when set, only sessions of this owner may name the Environment (checked
     * when a session opens and at every turn start). `null` clears it.
     */
    ownerUserId: z.string().min(1).nullable().optional(),
    lifecycle: EnvironmentLifecycleSchema.optional(),
    /**
     * Pods only (Host feature `environment-setup`): commands run when the disk is made or reset,
     * before any turn. A change applies at the next reset.
     */
    setup: z.array(EnvironmentSetupCommandSchema).max(ENVIRONMENT_SETUP_MAX).optional(),
    /** Pods only: artifact versions copied in when the disk is made or reset, before `setup`. */
    files: z.array(EnvironmentFileSchema).max(ENVIRONMENT_SETUP_MAX).optional(),
    /**
     * Only when the `PUT` creates the Environment (Host feature `environment-disk-versions`): its
     * disk starts from this version of another Environment's disk. Its vault starts empty.
     */
    from: z
      .object({
        environment: EnvironmentIdSchema,
        version: z.union([z.number().int().positive(), z.literal("latest")]),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PutEnvironmentRequest = z.infer<typeof PutEnvironmentRequestSchema>;

/** An Environment's recipe, resolved against the Tenant's limits. */
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
  })
  .strict();
export type EnvironmentRecipe = z.infer<typeof EnvironmentRecipeSchema>;

/** A session that names an Environment, as the Environment's view lists it. */
export const EnvironmentSessionSchema = z
  .object({ id: z.string(), activeTurnId: z.string().nullable() })
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
export const EnvironmentPodViewSchema = z
  .object({
    desired: z.enum(POD_DESIRED),
    observed: z.enum(POD_OBSERVED),
    /** Bumped by every reset: each generation has its own volume. */
    volumeGeneration: z.number().int().nonnegative(),
    /** Bumped each time a pod joins; a host token of an older epoch is refused. */
    hostEpoch: z.number().int().nonnegative(),
    /** Why it failed, or was lost. */
    reason: z.string().optional(),
  })
  .strict();
export type EnvironmentPodView = z.infer<typeof EnvironmentPodViewSchema>;

/**
 * The compute states an Environment reports today: `ready` until a tool first runs in a virtual
 * one, then `creating`, `running` or `stopped`. An open set: clients must accept values they do
 * not know (a later release may add one, such as `cold`).
 */
export const ENVIRONMENT_STATES = ["ready", "creating", "running", "stopped"] as const;

/** `PUT` and `GET /v1/environments/{environmentId}`. */
export const EnvironmentViewSchema = z
  .object({
    id: z.string(),
    kind: z.enum(ENVIRONMENT_KINDS),
    labels: z.record(z.string(), z.string()),
    /** What the app asked for, resolved against the Tenant's limits. */
    recipe: EnvironmentRecipeSchema,
    /** Bumped by every recipe change. */
    version: z.number().int().positive(),
    /** The recipe version the current pod (or virtual workspace) runs. */
    appliedVersion: z.number().int().positive(),
    /** The owner guard, or `null`. */
    ownerUserId: z.string().nullable(),
    /** See `ENVIRONMENT_STATES`: an open set. */
    state: z.string().meta({ description: "ready, creating, running or stopped; an open set" }),
    /** Kind `pod`: what the Runtime wants of the pod and what it last saw. */
    pod: EnvironmentPodViewSchema.optional(),
    /** When it was last used: a turn, a recipe change, a secret write, a stop or a reset. */
    lastUsedAt: z.string(),
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
          .optional(),
      })
      .strict()
      .optional(),
    /** Sessions that name it (acting for a subject, only the subject's own). */
    sessions: z.array(EnvironmentSessionSchema),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type EnvironmentView = z.infer<typeof EnvironmentViewSchema>;

/** `POST /v1/environments/{id}/snapshot`: a new version of the Environment's disk. */
export const EnvironmentSnapshotSchema = z
  .object({
    environmentId: z.string(),
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
export type EnvironmentSnapshot = z.infer<typeof EnvironmentSnapshotSchema>;
/** `POST /v1/environments/{id}/restore`: which version of its disk to put back. */
export const RestoreEnvironmentRequestSchema = z
  .object({
    requestId: RequestIdSchema.optional(),
    version: z.union([z.number().int().positive(), z.literal("latest")]),
  })
  .strict();
export type RestoreEnvironmentRequest = z.infer<typeof RestoreEnvironmentRequestSchema>;
export const EnvironmentRestoreSchema = z
  .object({
    environmentId: z.string(),
    restored: z.number().int().positive(),
    /**
     * `done` once the version is back (a virtual Environment); `pending` while a pod's new volume
     * is seeded (`disk.operation` in the view until it ends; turns wait for it).
     */
    status: z.enum(["done", "pending"]),
    volumeGeneration: z.number().int().nonnegative().optional(),
  })
  .strict();
export type EnvironmentRestore = z.infer<typeof EnvironmentRestoreSchema>;
/** `GET /v1/environments/{id}/versions`: its disk versions, newest first. */
export const EnvironmentVersionsSchema = z
  .object({
    environmentId: z.string(),
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
export type EnvironmentVersions = z.infer<typeof EnvironmentVersionsSchema>;

export const ListEnvironmentsResponseSchema = z
  .object({ environments: z.array(EnvironmentViewSchema) })
  .strict();
export type ListEnvironmentsResponse = z.infer<typeof ListEnvironmentsResponseSchema>;

export const DeleteEnvironmentResponseSchema = z
  .object({ id: z.string(), deleted: z.boolean() })
  .strict();
export type DeleteEnvironmentResponse = z.infer<typeof DeleteEnvironmentResponseSchema>;

/**
 * One connection a pod Environment opened through egress-gate (track R7, Q6): written when it
 * closes, or at once when the gate refused it. The session log of the turn holding the
 * Environment when it opened gets it as `egress.connection`; with no turn holding it, the
 * Environment's own stream gets it as `environment.egress` (Q7).
 *
 * `startedAt` is the gate's clock at CONNECT and `durationMs` runs from there to the close, so
 * the span is the gate's own measurement. `bytesUp` is what the sandbox sent, `bytesDown` what it
 * got. `mode: "credential"` is a host an `environment_secret` is bound to (R2c): the gate read
 * each request (`requests`) and set a credential on it (`credentialIds`, ids only). It never
 * carries a header value, a URL path or a body.
 */
export const EgressConnectionPayloadSchema = z
  .object({
    environmentId: z.string(),
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
  })
  .passthrough();

/** The schema id of an Environment's lifecycle events (its stream in the record). */
export const ENVIRONMENT_EVENT_SCHEMA = "nylorun.environment-event/1";
export const ENVIRONMENT_EVENT_TYPES = [
  "environment.created",
  "environment.attached",
  "environment.detached",
  "environment.deleted",
  // Kind `pod` (Host feature `sandbox-pods`).
  "environment.running",
  "environment.suspended",
  "environment.relaunched",
  "environment.lost",
  "environment.reset",
  "environment.failed",
  // egress-gate, while no turn holds the Environment (R7, Q7).
  "environment.egress",
] as const;
export type EnvironmentEventType = (typeof ENVIRONMENT_EVENT_TYPES)[number];
/** The payload of each Environment lifecycle event. */
export const ENVIRONMENT_EVENT_PAYLOADS = {
  "environment.created": z
    .object({ kind: z.enum(ENVIRONMENT_KINDS), labels: z.record(z.string(), z.string()) })
    .passthrough(),
  "environment.attached": z.object({ sessionId: z.string() }).passthrough(),
  "environment.detached": z
    .object({ sessionId: z.string(), reason: z.enum(["reset"]) })
    .passthrough(),
  /** Deleted by a `DELETE`, or by the sweep once `lifecycle.deleteAfter` passed (`reason`). */
  "environment.deleted": z
    .object({ reason: z.enum(["delete", "deleteAfter"]).optional() })
    .passthrough(),
  /** A pod joined and serves the Environment. */
  "environment.running": z.object({ hostEpoch: z.number().int() }).passthrough(),
  /** Stopped (`POST .../stop`, or idle): the volume is kept; the next turn starts it again. */
  "environment.suspended": z.object({ reason: z.enum(["stop", "idle"]) }).passthrough(),
  /** Its pod was replaced (same volume): the old pod's host token no longer works. */
  "environment.relaunched": z.object({ hostEpoch: z.number().int() }).passthrough(),
  /** Its volume or node is gone: turns are refused until a reset. */
  "environment.lost": z.object({ reason: z.string() }).passthrough(),
  /** Reset: a new pod on a new, empty volume. */
  "environment.reset": z.object({ volumeGeneration: z.number().int() }).passthrough(),
  /** The pod did not become ready. */
  "environment.failed": z.object({ reason: z.string() }).passthrough(),
  /** A connection through egress-gate while no turn held the Environment (`egress.connection`'s payload). */
  "environment.egress": EgressConnectionPayloadSchema,
} as const satisfies Record<EnvironmentEventType, z.ZodType>;
export type EnvironmentEventPayload<T extends EnvironmentEventType> = z.infer<
  (typeof ENVIRONMENT_EVENT_PAYLOADS)[T]
>;
/** One lifecycle event on an Environment's stream, numbered from 0. */
export const EnvironmentEventSchema = z
  .object({
    schema: z.literal(ENVIRONMENT_EVENT_SCHEMA),
    eventId: z.string(),
    tenantId: z.string(),
    environmentId: z.string(),
    seq: z.number().int().nonnegative(),
    time: z.string(),
    type: z.enum(ENVIRONMENT_EVENT_TYPES),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type EnvironmentEvent = z.infer<typeof EnvironmentEventSchema>;
export const ListEnvironmentEventsResponseSchema = z
  .object({ events: z.array(EnvironmentEventSchema) })
  .strict();

export const PutSessionRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    agentId: z.string().min(1),
    ownerUserId: z.string().min(1),
    info: jsonObject.optional(),
    /**
     * The Environment the session runs in: its sandbox, and its vault's credentials for the
     * session's shell, MCP servers and HTTP tools. Omitted: no sandbox and no credentials.
     * Fixed once the session exists.
     */
    environment: EnvironmentIdSchema.optional(),
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
        environments: z.number().int().min(0).max(100_000).optional(),
      })
      .strict()
      .optional(),
    /** Pods: how long a pod has to stop. Read at every timer. */
    lifecycle: z
      .object({
        /** The pod's grace period to stop, at most 30s. Default 10s. */
        stopGrace: durationSchema("lifecycle.stopGrace")
          .refine((value) => (parseSandboxDuration(value) ?? 0) <= 30_000, {
            message: "lifecycle.stopGrace is at most 30s",
          })
          .optional(),
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
/**
 * An environment variable name a shell secret or plain variable may take (R2c, D50): a POSIX
 * name. Names the sandbox needs for itself (the proxy, the trust store, `PATH`, `HOME`) and
 * `NYLORUN_*` are reserved.
 */
export const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
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
/** The value a sandbox sees for every `environment_secret` (R2c, D50): never the secret. */
export const ENVIRONMENT_SECRET_SENTINEL = "nylorun-managed";
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
  .max(32)
  .refine((hosts) => new Set(hosts).size === hosts.length, "allowedHosts lists each host once");
const EnvironmentValueSchema = z
  .string()
  .min(1)
  .max(8192)
  .refine((value) => !/[\r\n\0]/.test(value), "A value has no CR, LF or NUL");

/** The name of a credential for a tool (`bearer` or `headers`): a label of 1–64 characters. */
export const TOOL_SECRET_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
/**
 * `PUT /v1/environments/{environmentId}/secrets/{name}` (D56): creates or replaces one credential
 * in the Environment's vault. For `environment_secret` and `environment_variable` the name is
 * the variable's name (a POSIX name, not reserved); for `bearer` and `headers` it is a label.
 * The same name and type keeps the credential and re-seals its value and binding; another type
 * replaces it. Values are write-only: no route reads them back. Two `environment_secret`
 * credentials bound to one host, or two `bearer`/`headers` credentials for one URL, are
 * `409 credential_conflict`.
 */
export const PutEnvironmentSecretRequestSchema = z.discriminatedUnion("type", [
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
export type PutEnvironmentSecretRequest = z.infer<typeof PutEnvironmentSecretRequestSchema>;
/** Whether `name` may name a secret of `type` (`PUT .../secrets/{name}`); a message when not. */
export function environmentSecretNameError(
  type: PutEnvironmentSecretRequest["type"],
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
/**
 * What a model may read (protocol 12): `text` always; `image`, `pdf`, `office` (Word, Excel,
 * PowerPoint), `audio` and `video` when its catalog entry or the operator says so. In this order.
 */
export const MODEL_INPUTS = ["text", "image", "pdf", "office", "audio", "video"] as const;
export const ModelInputSchema = z.enum(MODEL_INPUTS);
export type ModelInput = z.infer<typeof ModelInputSchema>;
/**
 * What the Runtime cannot learn from a custom OpenAI-compatible endpoint (Model Calls §7):
 * its context window and output limit, whether it reasons, what it reads (`inputs`; default text
 * only) and pi-ai `compat` settings (`thinkingFormat`, `thinkingTokenBudgetField`,
 * `chatTemplateKwargs`, …).
 */
export const CustomModelSettingsSchema = z
  .object({
    contextWindow: z.number().int().min(1024).optional(),
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
export const EnvironmentSecretViewSchema = z
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
export type EnvironmentSecretView = z.infer<typeof EnvironmentSecretViewSchema>;
export const ListEnvironmentSecretsResponseSchema = z
  .object({ secrets: z.array(EnvironmentSecretViewSchema) })
  .strict();
export type ListEnvironmentSecretsResponse = z.infer<typeof ListEnvironmentSecretsResponseSchema>;
/** The MCP transports a preview speaks: a manifest's remote server types. */
export const MCP_PREVIEW_TYPES = ["streamable-http", "sse"] as const;
/**
 * `POST /v1/tenant/mcp/preview` (R2b C12): what a remote MCP server offers, before an agent
 * names it. The Runtime connects with the credential for `url` in the vault of `environmentId`
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
    environmentId: EnvironmentIdSchema.optional(),
  })
  .strict();
export type McpPreviewRequest = z.infer<typeof McpPreviewRequestSchema>;
/** One tool a preview found. */
export const McpPreviewToolSchema = z
  .object({
    /** The server's own name for the tool. */
    serverToolName: z.string(),
    /**
     * What the model would call it (R2b C6); absent when the Runtime leaves the tool out (its
     * input schema is not one the Runtime can use).
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
    /** The server's instructions from `initialize`, cut to 2,000 characters. */
    instructions: z.string().optional(),
    tools: z.array(McpPreviewToolSchema),
    /** Tools the model knows by another name than `server__tool` (R2b C6). */
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
 * `POST /v1/tenant/credential-coverage`: which credential each of a saved agent's remote MCP
 * servers and HTTP tools would get in a session that names `environmentId`, decided as the
 * session's tool calls decide it (by URL). It reads no secret and calls no server.
 */
export const CredentialCoverageRequestSchema = z
  .object({
    requestId: RequestIdSchema.optional(),
    /** A saved agent or flow agent. */
    agentId: z.string().min(1),
    /** The Environment the session would name. Default: none (every entry is `missing`). */
    environmentId: EnvironmentIdSchema.optional(),
  })
  .strict();
export type CredentialCoverageRequest = z.infer<typeof CredentialCoverageRequestSchema>;
/** A credential coverage names: where it is, never its value. */
export const CoverageCredentialSchema = z
  .object({
    environmentId: z.string(),
    /** The secret's name in the Environment's vault. */
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
    environmentId: z.string().nullable(),
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
const messageBase = {
  ...commandBase,
  type: z.literal("message"),
  /** Optional turn manifest (Loop patch); validated as a variant of the pinned agent. */
  manifest: AgentManifestSchema.optional(),
};
/** The most parts one message may carry (protocol 6). */
export const MAX_MESSAGE_PARTS = 32;
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
      parts: z.array(MessagePartSchema).min(1).max(MAX_MESSAGE_PARTS),
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
    kind: z.enum(["application", "subject", "flow-host", "core"]),
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
 * `context.compacted`: the engine summarized older history to fit the model's window
 * (Model Calls §8). Token counts are estimates. `partial: true`: one summary call of several,
 * in the log for its timing; only the last one (without `partial`) replaced the history.
 */
export const ContextCompactedPayloadSchema = z
  .object({
    invocationId: z.string().min(1).optional(),
    trigger: z.enum(["threshold", "overflow"]),
    tokensBefore: z.number().int().nonnegative(),
    tokensAfter: z.number().int().nonnegative(),
    partial: z.literal(true).optional(),
    ...modelOutcomeFacts,
    ...eventAgent,
  })
  .passthrough();
/** How a tool call ended (R5.1): the tool answered, the Runtime ended it, or a cancel did. */
export const TOOL_CALL_STATUSES = ["completed", "failed", "cancelled"] as const;
/** Where a tool call ran (R5.1): a remote MCP server, an HTTP tool, the sandbox, or core. */
export const TOOL_CALL_KINDS = ["mcp", "http", "sandbox", "platform"] as const;
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
    toolName: z.string().min(1),
    status: z.enum(TOOL_CALL_STATUSES).optional(),
    kind: z.enum(TOOL_CALL_KINDS).optional(),
    /** The MCP server, or the HTTP tool's URL host. */
    server: z.string().min(1).optional(),
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
  /** The session's agent. */
  agentId: z.string().optional(),
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
 * `environment.attached`: the session was opened on an Environment (`environment`). The
 * Environment's own stream records the same attachment.
 */
export const EnvironmentAttachedPayloadSchema = z
  .object({ environmentId: z.string() })
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
 * Where an artifact version's bytes came from: a client's upload, our engine's `save_artifact`,
 * or the turn-end export of a sandbox's outputs (F8.2), whose listing and bytes the harness
 * holding the workspace supplied.
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
/** Why a turn-end export stored nothing although the sandbox had outputs (F8.2). */
export const ArtifactExportSkipReasonSchema = z.enum([
  "too_many_files",
  "file_too_large",
  "too_large",
  "tenant_total",
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
 * `artifact.export.failed`: the turn-end export could not finish (the sandbox or the Object store
 * failed). The turn itself completed; the next turn exports again.
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
    /** `refused`: the vault has no usable credential for it; `failed`: it could not be reached or listed. */
    outcome: z.enum(["connected", "refused", "failed"]),
    message: z.string(),
    /** The tools it added to the session; 0 unless connected. */
    tools: z.number().int().nonnegative(),
    /**
     * Of those, the tools out of the model's tool list, which it finds with `tool_search` and runs
     * with `tool_call` (R2b C10); absent when none is.
     */
    deferred: z.number().int().positive().optional(),
    /** Listed tools the server's `tools` settings disable (R2b C9); absent when none. */
    disabled: z.number().int().positive().optional(),
    /**
     * Keys of the server's `tools` settings that name no tool it listed (R2b C9): a diagnostic,
     * since servers change their lists.
     */
    unknownTools: z.array(z.string()).optional(),
    /** The credentials a refusal names. */
    credentialIds: z.array(z.string()).optional(),
    /**
     * Tools the model knows by another name (R2b C6): `server__tool` with characters outside
     * `[A-Za-z0-9_-]` replaced by `_`, and shortened to 64 with a hash, or suffixed with the hash
     * when that collides. The server is still called by `serverToolName`.
     */
    renamed: z
      .array(z.object({ serverToolName: z.string(), name: z.string() }).passthrough())
      .optional(),
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
  "environment.attached": { payload: EnvironmentAttachedPayloadSchema, source: "api", version: 1 },
  "egress.connection": { payload: EgressConnectionPayloadSchema, source: "egress-gate", version: 1 },
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
    /** The registered agents. */
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
    scope: z.enum(["sessions", "environments", "all"]),
    activeWork: z.enum(["drain", "cancel"]),
  })
  .strict();
export type ResetTenantRequest = z.infer<typeof ResetTenantRequestSchema>;

/**
 * Acting for a subject (Host feature `subject-headers`): what an application principal may
 * narrow a request to. `sessions:own` reaches only the subject's own sessions; the others reach
 * Tenant-wide resources. `environments:write` creates, changes and deletes Environments and
 * writes their secrets (protocol 11); a token caller's reach only the ids its Environment
 * grants name.
 */
export const SUBJECT_SCOPES = [
  "agents:read",
  "agents:write",
  "sessions:own",
  "environments:write",
] as const;
export type SubjectScope = (typeof SUBJECT_SCOPES)[number];
/**
 * Retired scopes: `Nylorun-Scopes` may still name them (older clients do), and they grant
 * nothing. `vaults:own` left in protocol 7; `tenant:settings` in protocol 8, when the Tenant's
 * settings moved to the Management API, which no subject reaches.
 */
const RETIRED_SUBJECT_SCOPES: readonly string[] = ["vaults:own", "tenant:settings"];

/** 1–200 visible ASCII characters; spaces only inside. */
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
  if (names.includes("sandboxes:write"))
    return {
      ok: false,
      message: "sandboxes:write was renamed environments:write in protocol 11",
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
 * Scopes a token caller (a trusted issuer's token) may carry: never `agents:write`.
 */
export const TOKEN_SCOPES = [
  "agents:read",
  "sessions:own",
  "environments:write",
] as const;
/** The most Environment grants one token caller carries. */
export const TOKEN_ENVIRONMENT_GRANTS_MAX = 16;
export type TokenScope = (typeof TOKEN_SCOPES)[number];
/**
 * The longest a token the Runtime signs itself lives, in seconds (capability links): rotating
 * signing keys revokes the previous key once the longest token it may have signed has expired.
 */
export const TOKEN_TTL_MAX_SECONDS = 900;
/**
 * The `iss` of every token a Tenant's Runtime signs itself: capability links, run, host and
 * egress tokens.
 */
export function tenantTokenIssuer(tenantId: string): string {
  return `urn:nylorun:tenant:${tenantId}`;
}

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
 * - `agents`: the agents it may reach, `*` for all.
 * - `environments`: the Environment grants of a token caller (empty reaches none); absent for
 *   an application key, alone or acting for a subject, which no grant limits.
 */
export const MeResponseSchema = z
  .object({
    subject: z
      .string()
      .optional()
      .meta({ description: "The person the request acts for; absent for an application key alone" }),
    scopes: z.array(z.enum(CALLER_SCOPES)),
    agents: AgentAllowlistSchema,
    environments: z
      .array(z.string())
      .optional()
      .meta({
        description:
          "A token caller's Environment grants (empty reaches none); absent when no grant limits the caller",
      }),
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

/** `GET /v1/agents` with an application key: every definition, manifest included. */
export const AgentDefinitionViewSchema = z
  .object({
    agentId: z.string(),
    manifest: z.record(z.string(), z.unknown()),
    manifestHash: z.string(),
    implementationVersion: z.string(),
  })
  .strict();
export type AgentDefinitionView = z.infer<typeof AgentDefinitionViewSchema>;
export const ListAgentsResponseSchema = z
  .object({ agents: z.array(AgentDefinitionViewSchema) })
  .strict();
export type ListAgentsResponse = z.infer<typeof ListAgentsResponseSchema>;
/** `GET /v1/agents` with a token caller's credential: the allowed agents' names only. */
export const PublicAgentSchema = z
  .object({
    agentId: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
  })
  .strict();
export type PublicAgent = z.infer<typeof PublicAgentSchema>;
export const ListPublicAgentsResponseSchema = z
  .object({ agents: z.array(PublicAgentSchema) })
  .strict();
export type ListPublicAgentsResponse = z.infer<typeof ListPublicAgentsResponseSchema>;
export const PutAgentResponseSchema = z
  .object({
    agentId: z.string(),
    manifestHash: z.string(),
    implementationVersion: z.string(),
  })
  .strict();
export type PutAgentResponse = z.infer<typeof PutAgentResponseSchema>;

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
    agentId: z.string(),
    ownerUserId: z.string(),
    manifestHash: z.string(),
    /**
     * The hash of the definition the session was opened from (R2b C11). `manifestHash` differs
     * from it when the Runtime pinned its `runtime` block on the definition: a sandbox's tools,
     * the artifact tools and the skill tools. Compare this one with the registered
     * definition's hash. Absent for a session opened before this release.
     */
    definitionHash: z.string().optional(),
    implementationVersion: z.string(),
    status: z.enum(SESSION_STATUSES),
    activeTurnId: z.string().nullable(),
    /**
     * The Environment the session names, and its recipe version when the session opened (for
     * reading only); `null` without one.
     */
    environment: z
      .object({ id: z.string(), version: z.number().int().positive() })
      .strict()
      .nullable(),
    /**
     * The harness that runs the session's turns, pinned when it opened (track R4): its
     * Environment's harness, else `nylorun`.
     */
    harness: z.string(),
    /**
     * Why the session takes no new turn, when it is closed: `protocol_13` for a session opened
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

/** What a usage total or a budget covers: the whole Tenant, one agent, or one turn. */
export const ModelUsageScopeSchema = z.enum(["tenant", "agent", "turn"]);
export type ModelUsageScope = z.infer<typeof ModelUsageScopeSchema>;

/** `GET /v1/tenant/usage`: which rows of the model usage ledger to total. */
export const ModelUsageQuerySchema = z
  .object({
    scope: ModelUsageScopeSchema.default("tenant"),
    /** The agent or turn id; required for those scopes. */
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
    /** `turn` caps every turn; `agent` one agent's sessions; `tenant` all of them. */
    scope: ModelUsageScopeSchema,
    /** The agent's id; `agent` only. */
    id: z.string().min(1).optional(),
    /** The UTC period spend counts over; `agent` and `tenant` only. */
    period: z.enum(["day", "month"]).optional(),
    /** pi-ai's catalog price; custom endpoints count as $0, so cap them in tokens. */
    limitUsd: z.number().positive().optional(),
    limitTokens: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((budget, ctx) => {
    if (budget.limitUsd === undefined && budget.limitTokens === undefined)
      ctx.addIssue({ code: "custom", message: "A budget needs limitUsd, limitTokens or both" });
    if ((budget.scope === "agent") !== (budget.id !== undefined))
      ctx.addIssue({ code: "custom", message: "An agent budget names the agent in id; other scopes take no id" });
    if ((budget.scope === "turn") === (budget.period !== undefined))
      ctx.addIssue({ code: "custom", message: "A turn budget takes no period; agent and Tenant budgets need one" });
  });
export type ModelBudget = z.infer<typeof ModelBudgetSchema>;

/** `PUT /v1/tenant/budgets`: replaces every budget. An empty list removes them all. */
export const PutModelBudgetsRequestSchema = z
  .object({
    requestId: RequestIdSchema.optional(),
    budgets: z.array(ModelBudgetSchema).max(100),
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
    /** A regular expression the field's string value must match. */
    matches: z.string().min(1).max(500).optional(),
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
 * `tool` (the name the model calls it by, `*` for any run of characters), `server` (an MCP
 * server's name), `kind`, `agent` (the agent that calls it) and `when` (fields of the input, by
 * dotted path). The strictest matching rule decides: `deny` refuses the call before it is sent,
 * `ask` holds it until a person approves it on the session (`approve`), `allow` runs it. A call no
 * rule matches runs. Sandbox tools never cross the gate; their network side is egress policy.
 */
export const ToolRuleSchema = z
  .object({
    effect: z.enum(TOOL_POLICY_EFFECTS),
    tool: z.string().min(1).max(200).optional(),
    server: z.string().min(1).max(200).optional(),
    kind: z.enum(["mcp", "http"]).optional(),
    agent: z.string().min(1).max(200).optional(),
    when: z.record(z.string().min(1).max(200), ToolInputConditionSchema).optional(),
    /** Why the rule exists: shown with a held or denied call. */
    reason: z.string().min(1).max(500).optional(),
  })
  .strict();
export type ToolRule = z.infer<typeof ToolRuleSchema>;
/** `PUT /v1/tenant/tool-policy`: replaces every rule. An empty list allows every call. */
export const PutToolPolicyRequestSchema = z
  .object({ requestId: RequestIdSchema.optional(), rules: z.array(ToolRuleSchema).max(200) })
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
  "session_busy",
  "runtime_error",
]);
export type AgUiRunErrorCode = z.infer<typeof AgUiRunErrorCodeSchema>;

// --- Studio embedding (Studio design §8) ---------------------------------------------------

/** A Tenant id as Studio's routes accept it. */
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
  .max(2048)
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
/** A capability link lives no longer than any token the Runtime signs (`TOKEN_TTL_MAX_SECONDS`). */
export const ARTIFACT_LINK_MAX_TTL_SECONDS = TOKEN_TTL_MAX_SECONDS;
export const ARTIFACT_LINK_DEFAULT_TTL_SECONDS = 300;
/** A Tenant's limits when it sets none: 100 MiB per file, 10 GiB in all. */
export const ARTIFACT_FILE_BYTES_DEFAULT = 100 * 1024 * 1024;
export const ARTIFACT_TOTAL_BYTES_DEFAULT = 10 * 1024 * 1024 * 1024;
/** The longest artifact name, in characters. */
export const ARTIFACT_NAME_MAX = 255;
/** The longest path of a file in a folder artifact, in characters. */
export const ARTIFACT_PATH_MAX = 1024;

/** Labels: up to 32, keys 1–63 characters, values up to 256. */
export const ArtifactLabelsSchema = z
  .record(z.string().min(1).max(63), z.string().max(256))
  .refine((labels) => Object.keys(labels).length <= 32, { message: "At most 32 labels" });

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
     * The Environment whose disk versions it holds (R2d step 3); absent otherwise. Such an
     * artifact changes only through `/v1/environments/{id}/snapshot` and its versions routes.
     */
    environmentId: z.string().optional(),
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
    size: z.number().int().nonnegative().max(DEFINITION_FILE_MAX_BYTES),
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
    /** Seconds until the link stops working. Default 300, at most 900. */
    expiresIn: z.number().int().min(1).max(ARTIFACT_LINK_MAX_TTL_SECONDS).optional(),
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
/** The folder artifact a session's turn-end export writes, one per session. */
export const OUTPUTS_ARTIFACT_NAME = "outputs";
/** The most files one turn-end export stores; past it the export is skipped. */
export const EXPORT_MAX_FILES = 10_000;
/** The most bytes one turn-end export stores (before dedupe); past it the export is skipped. */
export const EXPORT_MAX_BYTES = 1024 * 1024 * 1024;

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
    target: z.string().max(4096).optional(),
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

/** Opt-in session reads (Host feature `session-reads`). */
export const SessionListItemSchema = SessionSummarySchema.extend({
  lastTurnId: z.string().nullable(),
  environmentId: z.string().nullable(),
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
    agentId: z.string(),
    manifestHash: z.string(),
    implementationVersion: z.string(),
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
    agentId: z.string(),
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
    toolName: z.string().nullable(),
    kind: z.enum(TOOL_CALL_KINDS).nullable(),
    server: z.string().nullable(),
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
export const EnvironmentPageSchema = z
  .object({ environments: z.array(EnvironmentViewSchema), nextCursor: z.string().nullable() })
  .strict();
export type EnvironmentPage = z.infer<typeof EnvironmentPageSchema>;
