/** Public wire contracts only. Never import checkpoint or engine modules here. */
import { z } from "zod";
import type { AgentManifest } from "./types/manifest.js";
import type { JsonValue } from "./types/shared.js";
import type { WorkflowManifest, WorkflowNodeV2 } from "./types/workflow.js";
import {
  SANDBOX_NETWORK_PRESETS,
  SANDBOX_TOOL_NAMES,
  isSandboxHostPattern,
  parseSandboxDuration,
  parseSandboxSize,
} from "./utils/sandbox.js";
import { hookListIssue } from "./definition/hooks.js";
import { DELEGATE_INPUT_SCHEMA } from "./definition/delegate.js";
import { canonical } from "./utils/canonical.js";
export type { AgentManifest } from "./types/manifest.js";
export type { WorkflowManifest } from "./types/workflow.js";
export { PROTOCOL_VERSION, ERROR_CODES } from "./compatibility.js";
export type { ErrorCode } from "./compatibility.js";
import { ERROR_CODES } from "./compatibility.js";
export const RequestIdSchema = z.string().min(1);
export const IdempotencyKeySchema = z.string().min(1).max(256);
const jsonObject = z.record(z.string(), z.unknown());
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
const mcpServerSchema = z.discriminatedUnion("type", [
  z
    .object({
      name: z.string().min(1),
      type: z.literal("stdio"),
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
      cwd: z.string().optional(),
    })
    .strict(),
  z
    .object({
      name: z.string().min(1),
      type: z.literal("streamable-http"),
      url: z.string().min(1),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
  z
    .object({
      name: z.string().min(1),
      type: z.literal("sse"),
      url: z.string().min(1),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
]);
const skillManifestSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
  })
  .strict();
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
const toolManifestSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    inputSchema: jsonObject,
    outputSchema: jsonObject.optional(),
    agent: z
      .lazy(() => z.union([workflowV2ManifestSchema, AgentManifestSchema]))
      .meta({ id: "ToolAgentManifest" })
      .optional(),
  })
  .strict();
const hookPointSchema = z
  .object({
    at: z.enum(["before", "after"]),
    scope: z.enum(["turn", "step"]),
  })
  .strict();
export const AgentManifestSchema = z
  .object({
    manifestSchemaVersion: z.literal(4),
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    metadata: jsonObject.optional(),
    outputSchema: jsonObject.optional(),
    capabilities: z.array(
      z
        .object({
          id: z.string().min(1),
          type: z.enum(["agent", "agent-plugin"]),
          name: z.string().min(1).optional(),
          description: z.string().optional(),
          metadata: jsonObject.optional(),
          instructions: z.array(z.string()).optional(),
          skills: z.record(z.string(), skillManifestSchema).optional(),
          tools: z.array(toolManifestSchema).optional(),
          mcpServers: z.record(z.string(), mcpServerSchema).optional(),
          sandbox: sandboxManifestSchema.optional(),
          hooks: z
            .array(hookPointSchema)
            .optional()
            .superRefine((hooks, ctx) => {
              const issue = hooks === undefined ? undefined : hookListIssue(hooks);
              if (issue) ctx.addIssue({ code: "custom", message: issue });
            }),
        })
        .strict()
    ),
    runtime: z.object({}).strict().optional(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    delegationIssues(manifest as AgentManifest, (message) =>
      ctx.addIssue({ code: "custom", message })
    );
    const ids = new Set<string>();
    const names = new Set<string>();
    const servers = new Set<string>();
    const skills = new Set<string>();
    let sandboxes = 0;
    for (const capability of manifest.capabilities) {
      if (capability.sandbox) {
        sandboxes += 1;
        if (sandboxes > 1)
          ctx.addIssue({
            code: "custom",
            message: "At most one capability may declare a sandbox",
          });
        const declared = new Set((capability.tools ?? []).map((tool) => tool.name));
        for (const name of SANDBOX_TOOL_NAMES)
          if (!declared.has(name))
            ctx.addIssue({
              code: "custom",
              message: `Sandbox capability '${capability.id}' must declare the built-in '${name}' tool`,
            });
      }
      if (ids.has(capability.id))
        ctx.addIssue({ code: "custom", message: "Duplicate capability id" });
      ids.add(capability.id);
      for (const tool of capability.tools ?? []) {
        if (names.has(tool.name))
          ctx.addIssue({
            code: "custom",
            message: "Tool names must be unique",
          });
        names.add(tool.name);
      }
      if (capability.skills && Object.keys(capability.skills).length === 0)
        ctx.addIssue({
          code: "custom",
          message: "skills must be omitted when a capability declares no skills",
        });
      for (const [key, skill] of Object.entries(capability.skills ?? {})) {
        if (key !== skill.name)
          ctx.addIssue({
            code: "custom",
            message: `skills key '${key}' must equal the skill name`,
          });
        if (skills.has(skill.name))
          ctx.addIssue({
            code: "custom",
            message: `Duplicate skill '${skill.name}'`,
          });
        skills.add(skill.name);
      }
      if (capability.mcpServers && Object.keys(capability.mcpServers).length === 0)
        ctx.addIssue({
          code: "custom",
          message: "mcpServers must be omitted when a capability declares no servers",
        });
      for (const [key, server] of Object.entries(capability.mcpServers ?? {})) {
        if (key !== server.name)
          ctx.addIssue({
            code: "custom",
            message: `mcpServers key '${key}' must equal the server name`,
          });
        if (servers.has(server.name))
          ctx.addIssue({
            code: "custom",
            message: `Duplicate MCP server '${server.name}'`,
          });
        servers.add(server.name);
      }
    }
  }) as unknown as z.ZodType<AgentManifest>;
/** Agents used as tools: one level deep, `{ task }` input, one shared sandbox spec. */
function delegationIssues(manifest: AgentManifest, issue: (message: string) => void): void {
  const sandboxes = new Set<string>();
  const addSandboxes = (agent: AgentManifest) => {
    for (const capability of agent.capabilities)
      if (capability.sandbox) sandboxes.add(canonical(capability.sandbox));
  };
  addSandboxes(manifest);
  for (const capability of manifest.capabilities)
    for (const tool of capability.tools ?? []) {
      const child = tool.agent;
      if (!child) continue;
      if ("kind" in child) {
        // A flow agent runs in its own linked session; its leaves may delegate in turn.
        if (tool.name !== child.id)
          issue(`Tool '${tool.name}' must be named after the agent it runs ('${child.id}')`);
        if (!child.description?.trim() || tool.description !== child.description)
          issue(`Agent tool '${tool.name}' must carry the agent's non-empty description`);
        if (canonical(tool.inputSchema) !== canonical(DELEGATE_INPUT_SCHEMA))
          issue(`Agent tool '${tool.name}' must take the standard { task } input`);
        if (tool.outputSchema !== undefined)
          issue(`Agent tool '${tool.name}' must not declare outputSchema; the agent's outputSchema applies`);
        if (child.sandbox !== undefined && Object.keys(child.sandbox).length > 0)
          sandboxes.add(canonical(child.sandbox));
        continue;
      }
      if (tool.name !== child.id)
        issue(`Tool '${tool.name}' must be named after the agent it runs ('${child.id}')`);
      if (!child.description?.trim() || tool.description !== child.description)
        issue(`Agent tool '${tool.name}' must carry the agent's non-empty description`);
      if (canonical(tool.inputSchema) !== canonical(DELEGATE_INPUT_SCHEMA))
        issue(`Agent tool '${tool.name}' must take the standard { task } input`);
      if (tool.outputSchema !== undefined)
        issue(`Agent tool '${tool.name}' must not declare outputSchema; the agent's outputSchema applies`);
      for (const inner of child.capabilities)
        if (inner.tools?.some((item) => item.agent !== undefined))
          issue(`'${child.id}' delegates to another agent; nested delegation is not supported yet`);
      addSandboxes(child);
    }
  if (sandboxes.size > 1)
    issue("An agent and the agents it uses as tools must declare identical sandboxes");
}
const absolutePath = z.string().min(1).refine(
  (value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value),
  { message: "plugin root must be an absolute path" },
);
const workflowFnRefSchema = z.object({ fn: z.literal(true) }).strict();
const workflowNodeSchema: z.ZodTypeAny = z.lazy(() =>
  z.union([
    z.object({ agent: z.string().min(1) }).strict(),
    z
      .object({
        tool: z
          .object({
            name: z.string().min(1),
            description: z.string().optional(),
            inputSchema: jsonObject.optional(),
            outputSchema: jsonObject.optional(),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        chain: z
          .object({
            id: z.string().min(1),
            steps: z.array(workflowNodeSchema).min(1),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        switch: z
          .object({
            id: z.string().min(1),
            on: workflowFnRefSchema,
            cases: z.record(z.string(), workflowNodeSchema),
            default: workflowNodeSchema.optional(),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        parallel: z
          .object({
            id: z.string().min(1),
            branches: z.record(z.string(), workflowNodeSchema),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        map: z
          .object({
            id: z.string().min(1),
            over: workflowFnRefSchema,
            each: workflowNodeSchema,
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        loop: z
          .object({
            id: z.string().min(1),
            run: workflowNodeSchema,
            verify: z.union([
              workflowFnRefSchema,
              z.object({ agent: z.string().min(1) }).strict(),
              z
                .object({
                  slot: z
                    .object({
                      id: z.string().min(1).optional(),
                      input: workflowFnRefSchema.optional(),
                      run: workflowNodeSchema,
                    })
                    .strict(),
                })
                .strict(),
            ]),
            decide: workflowFnRefSchema,
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        slot: z
          .object({
            id: z.string().min(1).optional(),
            input: workflowFnRefSchema.optional(),
            run: workflowNodeSchema,
          })
          .strict(),
      })
      .strict(),
  ])
).meta({ id: "WorkflowNode" });
const workflowV1ManifestSchema = z
  .object({
    kind: z.literal("workflow"),
    workflowSchemaVersion: z.literal(1),
    id: z.string().min(1),
    root: workflowNodeSchema,
    sandbox: sandboxManifestSchema.optional(),
  })
  .strict();
// v2 (Flow Agents): `id` and `input` on any node, no slots, embedded agents.
const workflowNodeOptionsV2 = {
  id: z.string().min(1).optional(),
  input: workflowFnRefSchema.optional(),
};
const workflowAgentNodeV2Schema = z
  .object({ agent: z.string().min(1), ...workflowNodeOptionsV2 })
  .strict();
const workflowNodeV2Schema: z.ZodTypeAny = z.lazy(() =>
  z.union([
    workflowAgentNodeV2Schema,
    z
      .object({
        tool: z
          .object({
            name: z.string().min(1),
            description: z.string().optional(),
            inputSchema: jsonObject.optional(),
            outputSchema: jsonObject.optional(),
          })
          .strict(),
        ...workflowNodeOptionsV2,
      })
      .strict(),
    z.object({ chain: z.array(workflowNodeV2Schema).min(1), ...workflowNodeOptionsV2 }).strict(),
    z
      .object({
        switch: z
          .object({
            on: workflowFnRefSchema,
            cases: z.record(z.string(), workflowNodeV2Schema),
            default: workflowNodeV2Schema.optional(),
          })
          .strict(),
        ...workflowNodeOptionsV2,
      })
      .strict(),
    z
      .object({
        parallel: z
          .record(z.string(), workflowNodeV2Schema)
          .refine((branches) => Object.keys(branches).length > 0, {
            message: "parallel needs at least one branch",
          }),
        ...workflowNodeOptionsV2,
      })
      .strict(),
    z
      .object({
        map: z.object({ each: workflowNodeV2Schema }).strict(),
        ...workflowNodeOptionsV2,
      })
      .strict(),
    z
      .object({
        loop: z
          .object({
            run: workflowNodeV2Schema,
            verify: z.union([workflowFnRefSchema, workflowAgentNodeV2Schema]),
            max: z.number().int().positive().optional(),
            decide: workflowFnRefSchema.optional(),
          })
          .strict()
          .refine((loop) => loop.max !== undefined || loop.decide !== undefined, {
            message: "loop needs max or decide",
          }),
        ...workflowNodeOptionsV2,
      })
      .strict(),
  ])
).meta({ id: "WorkflowNodeV2" });
const workflowV2ManifestSchema: z.ZodTypeAny = z.lazy(() =>
  z
    .object({
      kind: z.literal("workflow"),
      workflowSchemaVersion: z.literal(2),
      id: z.string().min(1),
      name: z.string().min(1).optional(),
      description: z.string().optional(),
      metadata: jsonObject.optional(),
      inputSchema: jsonObject.optional(),
      outputSchema: jsonObject.optional(),
      sandbox: sandboxManifestSchema.optional(),
      root: workflowNodeV2Schema,
      agents: z.record(
        z.string().min(1),
        z.union([workflowV2ManifestSchema, AgentManifestSchema])
      ),
    })
    .strict()
    .superRefine((manifest, ctx) => {
      for (const agentId of referencedAgents(manifest.root as WorkflowNodeV2)) {
        if (!(agentId in manifest.agents))
          ctx.addIssue({
            code: "custom",
            path: ["agents"],
            message: `Agent '${agentId}' is used in the flow but not embedded in agents`,
          });
      }
      for (const [key, agent] of Object.entries(manifest.agents as Record<string, { id: string }>)) {
        if (agent.id !== key)
          ctx.addIssue({
            code: "custom",
            path: ["agents", key],
            message: `Embedded agent '${agent.id}' must be keyed by its id`,
          });
      }
    })
).meta({ id: "WorkflowV2Manifest" });
function referencedAgents(node: WorkflowNodeV2): string[] {
  const out: string[] = [];
  const visit = (child: WorkflowNodeV2): void => {
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
export const WorkflowManifestSchema = z.union([
  workflowV1ManifestSchema,
  workflowV2ManifestSchema,
]) as unknown as z.ZodType<WorkflowManifest>;
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
    pluginRoots: z.record(z.string(), absolutePath).optional(),
  })
  .strict();
export type PutAgentRequest = z.infer<typeof PutAgentRequestSchema>;
export const CredentialSelectionSchema = z
  .object({
    serverName: z.string().min(1),
    credentialId: z.string().min(1),
  })
  .strict();
export type CredentialSelection = z.infer<typeof CredentialSelectionSchema>;
const sandboxHostSchema = z.string().refine(isSandboxHostPattern, {
  message: "network.allow entries must be host names such as api.github.com or *.example.com",
});
const sandboxDurationSchema = (name: string) =>
  z.string().refine((value) => parseSandboxDuration(value) !== undefined, {
    message: `${name} must be a duration such as 30s, 15m or 1h`,
  });
const sandboxResourcesSchema = z
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
/**
 * A sandbox defined when a session is opened. No `network.allow` means no egress. The Runtime
 * checks it against the Tenant's limits and pins the result on the session.
 */
export const SandboxInlineRequestSchema = z
  .object({
    image: z.string().min(1).optional(),
    network: z.object({ allow: z.array(sandboxHostSchema).optional() }).strict().optional(),
    resources: sandboxResourcesSchema.optional(),
  })
  .strict();
export type SandboxInlineRequest = z.infer<typeof SandboxInlineRequestSchema>;

// --- sandboxes as a resource (Host feature `sandboxes`, blueprint D39) ----------------------

/**
 * A sandbox id: 1–200 characters, one or more `/`-separated segments of letters, digits, `.`,
 * `_` and `-`, each starting with a letter or digit (`user-42`, `team-a/proj-42`). Ids are
 * hierarchical so an `sbx` grant can name a family of them (`team-a/*`).
 */
const SANDBOX_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
export const SANDBOX_ID_MAX_LENGTH = 200;

export function isSandboxId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= SANDBOX_ID_MAX_LENGTH &&
    SANDBOX_ID_PATTERN.test(value)
  );
}

/** An `sbx` entry: an exact sandbox id, or a prefix ending in `/*` (`team-a/*`). */
export function isSandboxGrant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return value.endsWith("/*") ? isSandboxId(value.slice(0, -2)) : isSandboxId(value);
}

/**
 * Whether `grants` (a subject token's `sbx`) reach sandbox `id`: an exact entry, or a prefix
 * entry `p/*` for any id below `p/`. No grants reach no sandbox.
 */
export function sandboxGranted(grants: readonly string[] | undefined, id: string): boolean {
  for (const grant of grants ?? []) {
    if (grant.endsWith("/*")) {
      if (id.startsWith(grant.slice(0, -1))) return true;
    } else if (grant === id) return true;
  }
  return false;
}

export const SandboxIdSchema = z
  .string()
  .refine(isSandboxId, {
    message:
      "A sandbox id is up to 200 characters: /-separated segments of letters, digits, '.', '_' and '-'",
  })
  .meta({ description: "A sandbox id, such as `user-42` or `team-a/proj-42`" });
export const SandboxGrantSchema = z.string().refine(isSandboxGrant, {
  message: "A sandbox grant is a sandbox id, or a prefix ending in /* such as team-a/*",
});

/** `virtual`: a just-bash workspace, no cluster (F7.1). `pod`: an agent-sandbox pod (F7.2). */
export const SANDBOX_KINDS = ["virtual", "pod"] as const;
export type SandboxKind = (typeof SANDBOX_KINDS)[number];

const LABEL_KEY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,61}[A-Za-z0-9])?$/;
const LABEL_VALUE_PATTERN = /^[\x20-\x7e]{0,256}$/;
export const SANDBOX_LABELS_MAX = 32;
/** The developer's own key-value pairs; the Runtime stores and filters them, never reads them. */
export const SandboxLabelsSchema = z
  .record(
    z.string().regex(LABEL_KEY_PATTERN, {
      message: "Label keys are 1-63 letters, digits, '.', '_', '/' and '-'",
    }),
    z.string().regex(LABEL_VALUE_PATTERN, {
      message: "Label values are up to 256 printable ASCII characters",
    }),
  )
  .refine((labels) => Object.keys(labels).length <= SANDBOX_LABELS_MAX, {
    message: `At most ${SANDBOX_LABELS_MAX} labels`,
  });
export type SandboxLabels = z.infer<typeof SandboxLabelsSchema>;

/**
 * `PUT /v1/sandboxes/{sandboxId}`: creates the sandbox, or finds the one with this id. The spec
 * (`kind`, `image`, `network`, `resources`, `storage`) is checked against the Tenant's limits
 * and fixed once the sandbox exists; `labels`, when sent, replace the sandbox's labels.
 *
 * Kind `pod` (Host feature `sandbox-pods`) is created at once on the Tenant's cluster. A `PUT`
 * on an existing pod sandbox also starts it again when it was stopped, and one with a
 * `lifecycle.ttl` other than its own sets a new expiry (counted from its creation), which
 * revives an expired sandbox.
 */
export const PutSandboxRequestSchema = z
  .object({
    requestId: RequestIdSchema.optional(),
    /** Default `virtual`. `pod` needs sandbox pods (`nylorun sandbox enable`). */
    kind: z.enum(SANDBOX_KINDS).optional(),
    labels: SandboxLabelsSchema.optional(),
    /** Pods only: the workload image (default the Tenant's, else `python:3.13-slim`). */
    image: z.string().min(1).optional(),
    /** Hosts the sandbox may reach; pods also take `*.suffix` patterns. */
    network: z.object({ allow: z.array(sandboxHostSchema).optional() }).strict().optional(),
    resources: sandboxResourcesSchema.optional(),
    /** Pods only: the volume's size (default 5GiB), fixed once created. */
    storage: z
      .string()
      .refine((value) => parseSandboxSize(value) !== undefined, {
        message: "storage must be a size such as 5GiB",
      })
      .optional(),
    /** Pods only. */
    lifecycle: z
      .object({
        /** How long after its creation the sandbox expires; within the Tenant's `limits.ttl`. */
        ttl: sandboxDurationSchema("lifecycle.ttl").optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PutSandboxRequest = z.infer<typeof PutSandboxRequestSchema>;

/** A session attached to a sandbox, as the sandbox's view lists it. */
export const SandboxSessionSchema = z
  .object({ id: z.string(), activeTurnId: z.string().nullable() })
  .strict();

/** What the Runtime wants of a pod sandbox (`desired`) and what it last saw (`observed`). */
export const SANDBOX_POD_DESIRED = ["running", "suspended", "deleted"] as const;
export const SANDBOX_POD_OBSERVED = [
  "creating",
  "running",
  "suspended",
  "expired",
  "lost",
  "failed",
  "deleting",
] as const;
export type SandboxPodDesired = (typeof SANDBOX_POD_DESIRED)[number];
export type SandboxPodObserved = (typeof SANDBOX_POD_OBSERVED)[number];
export const SandboxPodViewSchema = z
  .object({
    desired: z.enum(SANDBOX_POD_DESIRED),
    observed: z.enum(SANDBOX_POD_OBSERVED),
    /** Bumped by every reset: each generation has its own volume. */
    volumeGeneration: z.number().int().nonnegative(),
    /** Bumped each time a pod joins; a host token of an older epoch is refused. */
    hostEpoch: z.number().int().nonnegative(),
    /** When it expires (its TTL), if it has one. */
    expiresAt: z.string().optional(),
    /** Why it failed, or was lost. */
    reason: z.string().optional(),
  })
  .strict();
export type SandboxPodView = z.infer<typeof SandboxPodViewSchema>;

/** `PUT` and `GET /v1/sandboxes/{sandboxId}`. */
export const SandboxViewSchema = z
  .object({
    id: z.string(),
    kind: z.enum(SANDBOX_KINDS),
    labels: z.record(z.string(), z.string()),
    /** The spec, resolved against the Tenant's limits when the sandbox was created. */
    spec: z.record(z.string(), z.unknown()),
    /**
     * `ready` until a tool first runs in it, then the workspace's compute state. A virtual
     * sandbox has nothing to stop: `stopped` means only that its turn queue is idle.
     */
    state: z.enum(["ready", "creating", "running", "stopped"]),
    /** Kind `pod`: what the Runtime wants of the pod and what it last saw. */
    pod: SandboxPodViewSchema.optional(),
    /** Sessions attached to it (acting for a subject, only the subject's own). */
    sessions: z.array(SandboxSessionSchema),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type SandboxView = z.infer<typeof SandboxViewSchema>;

export const ListSandboxesResponseSchema = z
  .object({ sandboxes: z.array(SandboxViewSchema) })
  .strict();
export type ListSandboxesResponse = z.infer<typeof ListSandboxesResponseSchema>;

export const DeleteSandboxResponseSchema = z
  .object({ id: z.string(), deleted: z.boolean() })
  .strict();
export type DeleteSandboxResponse = z.infer<typeof DeleteSandboxResponseSchema>;

/** The schema id of a sandbox's lifecycle events (its stream in the record). */
export const SANDBOX_EVENT_SCHEMA = "nylorun.sandbox-event/1";
export const SANDBOX_EVENT_TYPES = [
  "sandbox.created",
  "sandbox.attached",
  "sandbox.detached",
  "sandbox.deleted",
  // Kind `pod` (Host feature `sandbox-pods`).
  "sandbox.running",
  "sandbox.suspended",
  "sandbox.expired",
  "sandbox.relaunched",
  "sandbox.lost",
  "sandbox.reset",
  "sandbox.failed",
] as const;
export type SandboxEventType = (typeof SANDBOX_EVENT_TYPES)[number];
/** The payload of each sandbox lifecycle event. */
export const SANDBOX_EVENT_PAYLOADS = {
  "sandbox.created": z
    .object({ kind: z.enum(SANDBOX_KINDS), labels: z.record(z.string(), z.string()) })
    .passthrough(),
  "sandbox.attached": z.object({ sessionId: z.string() }).passthrough(),
  "sandbox.detached": z
    .object({ sessionId: z.string(), reason: z.enum(["reset"]) })
    .passthrough(),
  "sandbox.deleted": z.object({}).passthrough(),
  /** A pod joined and serves the sandbox. */
  "sandbox.running": z.object({ hostEpoch: z.number().int() }).passthrough(),
  /** Stopped (`POST .../stop`, or idle): the volume is kept; the next turn starts it again. */
  "sandbox.suspended": z.object({ reason: z.enum(["stop", "idle"]) }).passthrough(),
  /** Its TTL passed: turns are refused until a `PUT` sets a longer TTL. */
  "sandbox.expired": z.object({ onExpiry: z.enum(["retain", "delete"]) }).passthrough(),
  /** Its pod was replaced (same volume): the old pod's host token no longer works. */
  "sandbox.relaunched": z.object({ hostEpoch: z.number().int() }).passthrough(),
  /** Its volume or node is gone: turns are refused until a reset. */
  "sandbox.lost": z.object({ reason: z.string() }).passthrough(),
  /** Reset: a new pod on a new, empty volume. */
  "sandbox.reset": z.object({ volumeGeneration: z.number().int() }).passthrough(),
  /** The pod did not become ready. */
  "sandbox.failed": z.object({ reason: z.string() }).passthrough(),
} as const satisfies Record<SandboxEventType, z.ZodType>;
export type SandboxEventPayload<T extends SandboxEventType> = z.infer<
  (typeof SANDBOX_EVENT_PAYLOADS)[T]
>;
/** One lifecycle event on a sandbox's stream, numbered from 0. */
export const SandboxEventSchema = z
  .object({
    schema: z.literal(SANDBOX_EVENT_SCHEMA),
    eventId: z.string(),
    tenantId: z.string(),
    sandboxId: z.string(),
    seq: z.number().int().nonnegative(),
    time: z.string(),
    type: z.enum(SANDBOX_EVENT_TYPES),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type SandboxEvent = z.infer<typeof SandboxEventSchema>;
export const ListSandboxEventsResponseSchema = z
  .object({ events: z.array(SandboxEventSchema) })
  .strict();

/**
 * `PutSessionRequest.sandbox`: `false` for none, `{ id }` to attach a sandbox resource (Host
 * feature `sandboxes`), `{ session }` to share another session's sandbox, or an inline sandbox.
 * Omitted means the Tenant's default.
 */
export const SandboxRequestSchema = z.union([
  z.literal(false),
  z.object({ id: SandboxIdSchema }).strict(),
  z.object({ session: z.string().min(1) }).strict(),
  SandboxInlineRequestSchema,
]);
export type SandboxRequest = z.infer<typeof SandboxRequestSchema>;
export const PutSessionRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    agentId: z.string().min(1),
    ownerUserId: z.string().min(1),
    info: jsonObject.optional(),
    vaultIds: z.array(z.string().min(1)).optional(),
    credentialSelections: z.array(CredentialSelectionSchema).optional(),
    /** The session's sandbox; see `SandboxRequestSchema`. Fixed once the session exists. */
    sandbox: SandboxRequestSchema.optional(),
  })
  .strict();
/** The hosts a harness can run on (blueprint D38). */
export const SANDBOX_PLACEMENT_HOSTS = ["harness-container", "sandbox"] as const;
export type SandboxPlacementHost = (typeof SANDBOX_PLACEMENT_HOSTS)[number];

/**
 * A Tenant's sandbox configuration (Tenant setting `sandbox.config`): what a session gets when
 * it names no sandbox, and the limits every session's sandbox must fit.
 */
export const TenantSandboxConfigSchema = z
  .object({
    /** `none` (the default when unset), `virtual`, or an inline sandbox. */
    default: z
      .union([z.literal("none"), z.literal("virtual"), SandboxInlineRequestSchema])
      .optional(),
    limits: z
      .object({
        /** Hosts a sandbox may allow. Default: package registries and code hosts. */
        network: z.array(sandboxHostSchema).optional(),
        /** The most a session may ask for. */
        resources: sandboxResourcesSchema.optional(),
        /** What a session gets when it asks for nothing. */
        defaultResources: sandboxResourcesSchema.optional(),
        /** Stop compute after this long without use. */
        idle: z
          .string()
          .refine((value) => parseSandboxDuration(value) !== undefined, {
            message: "idle must be a duration such as 30s, 15m or 1h",
          })
          .optional(),
        /** The most sandbox resources (`PUT /v1/sandboxes/{id}`) the Tenant may hold. Default 100. */
        sandboxes: z.number().int().min(0).max(100_000).optional(),
        /** Pods: the longest `lifecycle.ttl` a sandbox may ask for. Default none (no limit). */
        ttl: sandboxDurationSchema("limits.ttl").optional(),
      })
      .strict()
      .optional(),
    /** Pods: what happens at expiry and how long a pod has to stop. Read at every timer. */
    lifecycle: z
      .object({
        /** `retain` (default) keeps the volume after the TTL; `delete` deletes the sandbox. */
        onExpiry: z.enum(["retain", "delete"]).optional(),
        /** The pod's grace period to stop, at most 30s. Default 10s. */
        stopGrace: sandboxDurationSchema("lifecycle.stopGrace")
          .refine((value) => (parseSandboxDuration(value) ?? 0) <= 30_000, {
            message: "lifecycle.stopGrace is at most 30s",
          })
          .optional(),
      })
      .strict()
      .optional(),
    /**
     * Where each harness may run (blueprint D38), by harness id (`nylorun`, or `*` for the rest):
     * `harness-container` (the Runtime's harness) and `sandbox` (the engine in a pod sandbox).
     * Default `{ "*": { hosts: ["harness-container", "sandbox"] } }`. Checked when a session
     * opens; a host left out is refused (`placement_refused`).
     */
    placement: z
      .record(
        z.string().min(1),
        z.object({ hosts: z.array(z.enum(SANDBOX_PLACEMENT_HOSTS)).min(1) }).strict(),
      )
      .optional(),
  })
  .strict();
export type TenantSandboxConfig = z.infer<typeof TenantSandboxConfigSchema>;
/** `PUT /v1/tenant/sandbox`: replaces the Tenant's sandbox configuration. */
export const PutTenantSandboxRequestSchema = TenantSandboxConfigSchema.extend({
  requestId: RequestIdSchema.optional(),
}).strict();
export type PutTenantSandboxRequest = z.infer<typeof PutTenantSandboxRequestSchema>;
export type PutSessionRequest = z.infer<typeof PutSessionRequestSchema>;
const vaultWriteBase = {
  requestId: RequestIdSchema,
  idempotencyKey: IdempotencyKeySchema,
};
const tokenEndpointAuthSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z
    .object({
      type: z.literal("client_secret_basic"),
      clientSecret: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("client_secret_post"),
      clientSecret: z.string().min(1),
    })
    .strict(),
]);
const oauthRefreshSchema = z
  .object({
    tokenEndpoint: z.string().min(1),
    clientId: z.string().min(1),
    refreshToken: z.string().min(1),
    tokenEndpointAuth: tokenEndpointAuthSchema,
  })
  .strict();
/** The owner of every installation vault (`scope: "installation"`); a reserved subject. */
export const INSTALLATION_OWNER = "installation";
export const CreateVaultRequestSchema = z
  .object({
    ...vaultWriteBase,
    name: z.string().min(1),
    /**
     * `user` (the default): one person's vault, owned by `ownerUserId`. `installation`: the
     * installation's own vault, owned by `installation`, which any session may attach;
     * application keys only.
     */
    scope: z.enum(["user", "installation"]).optional(),
    /** Required for a `user` vault; absent (or `installation`) for an installation vault. */
    ownerUserId: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.scope ?? "user") === "user") {
      if (value.ownerUserId === undefined)
        ctx.addIssue({ code: "custom", path: ["ownerUserId"], message: "ownerUserId is required for a user vault" });
      else if (value.ownerUserId === INSTALLATION_OWNER)
        ctx.addIssue({ code: "custom", path: ["ownerUserId"], message: "installation is reserved for installation vaults" });
    } else if (value.ownerUserId !== undefined && value.ownerUserId !== INSTALLATION_OWNER)
      ctx.addIssue({ code: "custom", path: ["ownerUserId"], message: "An installation vault is owned by installation" });
  });
export type CreateVaultRequest = z.infer<typeof CreateVaultRequestSchema>;
export const CreateCredentialRequestSchema = z
  .object({
    ...vaultWriteBase,
    name: z.string().min(1),
    auth: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("bearer"),
          url: z.string().min(1),
          token: z.string().min(1),
        })
        .strict(),
      z
        .object({
          type: z.literal("oauth"),
          url: z.string().min(1),
          accessToken: z.string().min(1),
          expiresAt: z.string().min(1).nullable().optional(),
          refresh: oauthRefreshSchema.optional(),
        })
        .strict(),
    ]),
  })
  .strict();
export type CreateCredentialRequest = z.infer<
  typeof CreateCredentialRequestSchema
>;
export const RotateCredentialRequestSchema = z
  .object({
    ...vaultWriteBase,
    auth: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("bearer"),
          token: z.string().min(1),
        })
        .strict(),
      z
        .object({
          type: z.literal("oauth"),
          accessToken: z.string().min(1),
          expiresAt: z.string().min(1).nullable().optional(),
        })
        .strict(),
    ]),
  })
  .strict();
export type RotateCredentialRequest = z.infer<
  typeof RotateCredentialRequestSchema
>;
/**
 * What the Runtime cannot learn from a custom OpenAI-compatible endpoint (Model Calls §7):
 * its context window and output limit, whether it reasons, and pi-ai `compat` settings
 * (`thinkingFormat`, `thinkingTokenBudgetField`, `chatTemplateKwargs`, …).
 */
export const CustomModelSettingsSchema = z
  .object({
    contextWindow: z.number().int().min(1024).optional(),
    maxTokens: z.number().int().min(1).optional(),
    reasoning: z.boolean().optional(),
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
export const VaultInfoSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    ownerUserId: z.string(),
    metadata: z.record(z.string(), z.string()).optional(),
    createdAt: z.string(),
  })
  .strict();
export type VaultInfo = z.infer<typeof VaultInfoSchema>;
export const CredentialInfoSchema = z
  .object({
    id: z.string(),
    vaultId: z.string(),
    name: z.string(),
    type: z.enum(["bearer", "oauth"]),
    binding: z.object({ url: z.string() }).strict(),
    expiresAt: z.string().optional(),
    createdAt: z.string(),
    rotatedAt: z.string().optional(),
  })
  .strict();
export type CredentialInfo = z.infer<typeof CredentialInfoSchema>;
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
export const ActionOutcomeSchema = z
  .object({
    value: z.unknown(),
    statePatch: jsonObject.optional(),
  })
  .strict();
export type ActionOutcome = z.infer<typeof ActionOutcomeSchema>;
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
/** Who wrote an event. v1 writes `loop` (the engine) and `api` (commands and results). */
export const EventSourceKindSchema = z.enum([
  "model-gate",
  "tool-gate",
  "egress-gate",
  "sandboxd",
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
/** How far an event can be trusted, by who could forge it. v1 writes `observed` only. */
export const EvidenceClassSchema = z.enum([
  "observed",
  "measured",
  "attested",
  "claimed",
  "asserted",
]);
export type EvidenceClass = z.infer<typeof EvidenceClassSchema>;
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
const actionBase = {
  actionId: z.string(),
  sessionId: z.string(),
  turnId: z.string(),
  agentId: z.string(),
  manifestHash: z.string(),
  implementationVersion: z.string(),
  input: z.unknown(),
  context: jsonObject,
  /** `delivering`: sent to the agent's Action endpoint, not answered yet. */
  status: z.enum(["pending", "delivering", "completed", "uncertain", "cancelled"]),
  /** How many times it was delivered; a delivery token names the one it is for. */
  generation: z.number().int().nonnegative(),
  /** When an unanswered delivery counts as lost. Set only while `delivering`. */
  deadlineAt: z.string().nullable().optional(),
  agent: AgentRefSchema.optional(),
};
/** The hook point an action runs, and the capabilities that registered it (manifest order). */
export const ActionHookSchema = z
  .object({
    at: z.enum(["before", "after"]),
    scope: z.enum(["turn", "step"]),
    capabilityIds: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type ActionHook = z.infer<typeof ActionHookSchema>;
const agentToolActionSchema = z
  .object({
    ...actionBase,
    kind: z.literal("tool"),
    capabilityId: z.string(),
    toolName: z.string(),
    inputSchema: jsonObject.optional(),
    outputSchema: jsonObject.optional(),
  })
  .strict();
/** Tool node on a workflow: routed by path + key instead of capabilityId. */
const workflowToolActionSchema = z
  .object({
    ...actionBase,
    kind: z.literal("tool"),
    path: z.string().min(1),
    key: z.string().min(1),
    inputSchema: jsonObject.optional(),
    outputSchema: jsonObject.optional(),
  })
  .strict();
const hookActionSchema = z
  .object({
    ...actionBase,
    kind: z.literal("hook"),
    hook: ActionHookSchema,
  })
  .strict();
const fnActionSchema = z
  .object({
    ...actionBase,
    kind: z.literal("fn"),
    path: z.string().min(1),
    key: z.string().min(1),
  })
  .strict();
const verifyActionSchema = z
  .object({
    ...actionBase,
    kind: z.literal("verify"),
    path: z.string().min(1),
    key: z.string().min(1),
  })
  .strict();
export const ActionSchema = z.union([
  agentToolActionSchema,
  workflowToolActionSchema,
  hookActionSchema,
  fnActionSchema,
  verifyActionSchema,
]);
export type Action = z.infer<typeof ActionSchema>;

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
 * `message.assistant`: one completed model step. `invocationId` is the model call's.
 * `model`, `finishReason` and `usage` are present when the provider reported them.
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
    ...eventAgent,
  })
  .passthrough();
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
    ...eventAgent,
  })
  .passthrough();
/**
 * `context.compacted`: the engine summarized older history to fit the model's window
 * (Model Calls §8). Token counts are estimates.
 */
export const ContextCompactedPayloadSchema = z
  .object({
    invocationId: z.string().min(1).optional(),
    trigger: z.enum(["threshold", "overflow"]),
    tokensBefore: z.number().int().nonnegative(),
    tokensAfter: z.number().int().nonnegative(),
    ...eventAgent,
  })
  .passthrough();
/** `tool.completed`: an MCP or sandbox tool the Runtime ran. `error` for a tool error. */
export const ToolCompletedPayloadSchema = z
  .object({
    ...toolIds,
    capabilityId: z.string().min(1),
    toolName: z.string().min(1),
    output: z.unknown().optional(),
    error: z.object({ code: z.string(), message: z.string() }).passthrough().optional(),
    ...eventAgent,
  })
  .passthrough();
/** `action.pending` and `action.completed`; tool actions carry `callId` and `invocationId`. */
const actionEventBase = {
  actionId: z.string().min(1),
  kind: z.string(),
  toolName: z.string().optional(),
  /** A workflow Action: its node's path and key. */
  path: z.string().optional(),
  key: z.string().optional(),
  callId: z.string().optional(),
  invocationId: z.string().optional(),
  ...eventAgent,
};
export const ActionPendingPayloadSchema = z
  .object({ ...actionEventBase, input: z.unknown() })
  .passthrough();
export const ActionCompletedPayloadSchema = z
  .object({ ...actionEventBase, result: z.unknown() })
  .passthrough();
export const ActionUncertainPayloadSchema = z
  .object({ actionId: z.string().min(1), ...eventAgent })
  .passthrough();
export const EffectUncertainPayloadSchema = z
  .object({ effectId: z.string().min(1), message: z.string().optional() })
  .passthrough();
export const TurnCompletedPayloadSchema = z
  .object({ output: z.unknown() })
  .passthrough();
export const TurnPausedPayloadSchema = z
  .object({
    interactions: z.array(
      z
        .object({
          invocationId: z.string().min(1),
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
  })
  .passthrough();
export const TurnCancelledPayloadSchema = z
  .object({ reason: z.string().optional() })
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
  "action.pending": ActionPendingPayloadSchema,
  "action.completed": ActionCompletedPayloadSchema,
  "action.uncertain": ActionUncertainPayloadSchema,
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
/** `action.delivered`: the Runtime sent an Action to its endpoint. */
export const ActionDeliveredPayloadSchema = z
  .object({
    actionId: z.string().min(1),
    generation: z.number().int().positive(),
    ...eventAgent,
  })
  .passthrough();
/** `action.delivery_failed`: a delivery did not reach its endpoint, or was refused; it is retried. */
export const ActionDeliveryFailedPayloadSchema = z
  .object({
    actionId: z.string().min(1),
    generation: z.number().int().positive(),
    reason: z.string(),
    message: z.string().optional(),
    retryInMs: z.number().int().nonnegative(),
  })
  .passthrough();
/** `sandbox.state`: the session's sandbox changed state. */
export const SandboxStatePayloadSchema = z
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
 * `sandbox.attached`: the session was opened on a sandbox resource (`sandbox: { id }`). The
 * sandbox's own stream records the same attachment.
 */
export const SandboxAttachedPayloadSchema = z
  .object({ sandboxId: z.string() })
  .passthrough();
/** `sandbox.exec`: one sandbox tool call finished. */
export const SandboxExecPayloadSchema = z
  .object({
    tool: z.string(),
    command: z.string().optional(),
    outcome: z.string(),
    code: z.string().optional(),
    durationMs: z.number().nonnegative(),
  })
  .passthrough();
/** `node.started`: a workflow node that runs an Action started. */
export const NodeStartedPayloadSchema = z
  .object({
    path: z.string(),
    kind: z.string(),
    key: z.string(),
    iterations: z.string().optional(),
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
/** `loop.decided`: a Loop's decide step chose to iterate again (`input`) or finish (`output`). */
export const LoopDecidedPayloadSchema = z
  .object({
    path: z.string(),
    n: z.number().int(),
    next: z.enum(["input", "output"]),
    patched: z.boolean(),
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
export const ArtifactSourceSchema = z.enum(["upload", "engine", "export"]);
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
  "action.pending": { payload: ActionPendingPayloadSchema, source: "loop", version: 1 },
  "action.delivered": { payload: ActionDeliveredPayloadSchema, source: "loop", version: 1 },
  "action.delivery_failed": {
    payload: ActionDeliveryFailedPayloadSchema,
    source: "loop",
    version: 1,
  },
  "action.completed": { payload: ActionCompletedPayloadSchema, source: "api", version: 1 },
  "action.uncertain": { payload: ActionUncertainPayloadSchema, source: "loop", version: 1 },
  "effect.uncertain": { payload: EffectUncertainPayloadSchema, source: "loop", version: 1 },
  "delegation.started": { payload: DelegationPayloadSchema, source: "loop", version: 1 },
  "delegation.completed": { payload: DelegationPayloadSchema, source: "loop", version: 1 },
  "sandbox.state": { payload: SandboxStatePayloadSchema, source: "loop", version: 1 },
  "sandbox.exec": { payload: SandboxExecPayloadSchema, source: "loop", version: 1 },
  "sandbox.attached": { payload: SandboxAttachedPayloadSchema, source: "api", version: 1 },
  "node.started": { payload: NodeStartedPayloadSchema, source: "loop", version: 1 },
  "node.agent": { payload: NodeAgentPayloadSchema, source: "loop", version: 1 },
  "loop.iteration": { payload: LoopIterationPayloadSchema, source: "loop", version: 1 },
  "loop.verified": { payload: LoopVerifiedPayloadSchema, source: "api", version: 1 },
  "loop.decided": { payload: LoopDecidedPayloadSchema, source: "api", version: 1 },
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
 * The Host's one Tenant, as `/v1/admin/status` reports it. `unavailable` while it opens, when
 * opening it failed (`cause`), or when it is closing.
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

export const HostAggregateSchema = z
  .object({
    runningSessions: z.number().int().nonnegative(),
    /** Deliveries to Action endpoints in flight on this Host. */
    inFlightDeliveries: z.number().int().nonnegative(),
    pendingActions: z.number().int().nonnegative(),
    uncertainEffects: z.number().int().nonnegative(),
    /** This process's stream relay, when it runs one (a Host with S2). */
    relay: StreamRelayStatusSchema.optional(),
    /** The open Tenant's harnesses. */
    harness: HarnessStatusSchema.optional(),
  })
  .strict();
export type HostAggregate = z.infer<typeof HostAggregateSchema>;

export const AdminHostStatusSchema = z
  .object({
    hostId: z.string().min(1),
    url: z.string().min(1),
    pid: z.number().int(),
    version: z.string().min(1),
    protocol: ProtocolRangeSchema,
    tenant: HostTenantSchema,
    aggregate: HostAggregateSchema,
  })
  .strict();
export type AdminHostStatus = z.infer<typeof AdminHostStatusSchema>;

/** Shared Admin API status (D§4.1). OSS fills `host`; Cloud omits it. */
export const AdminStatusSchema = z
  .object({
    service: z.string().min(1),
    version: z.string().min(1),
    protocol: ProtocolRangeSchema,
    /** The Tenant this installation serves. */
    tenant: HostTenantSchema,
    aggregate: HostAggregateSchema,
    host: z
      .object({
        hostId: z.string().min(1),
        url: z.string().min(1),
        pid: z.number().int(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type AdminStatus = z.infer<typeof AdminStatusSchema>;

/**
 * An operator key (Host feature `operator-keys`): a revocable application key of the Tenant,
 * named by its id (`DERIVED_PRINCIPAL_ID_PATTERN`). The Runtime keeps only its hash.
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
/** `GET /v1/admin/keys`: every key of the Tenant (Studio's and derived ones too), by id. */
export const ListOperatorKeysResponseSchema = z
  .object({ keys: z.array(OperatorKeySchema) })
  .strict();
export type ListOperatorKeysResponse = z.infer<typeof ListOperatorKeysResponseSchema>;
/** `PUT /v1/admin/keys/{id}`: the new key, shown this once; `rotated` when it replaced one. */
export const PutOperatorKeyResponseSchema = OperatorKeySchema.extend({
  key: z.string().regex(/^[0-9a-f]{64}$/),
  rotated: z.boolean(),
}).strict();
export type PutOperatorKeyResponse = z.infer<typeof PutOperatorKeyResponseSchema>;
/** `DELETE /v1/admin/keys/{id}`: the key no longer authenticates. */
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

export const ProjectCredentialsFileSchema = z
  .object({
    format: z.union([z.literal(0), z.literal(1)]).default(0),
    applicationKey: z.string().regex(/^[0-9a-f]{64}$/),
    principalId: z.string().min(1),
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
        endpoints: z.boolean(),
        schema: z.boolean(),
      })
      .strict(),
    model: HostModelViewSchema,
    agents: z.array(
      z
        .object({
          agentId: z.string(),
          registered: z.boolean(),
          /** The agent has a registered Action endpoint. */
          endpoint: z.boolean(),
        })
        .strict(),
    ),
    counts: z
      .object({
        sessions: z.number().int().nonnegative(),
        runningSessions: z.number().int().nonnegative(),
        pendingActions: z.number().int().nonnegative(),
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
        /** Seeds Tenant setting `sandbox.config` when it is absent. */
        config: TenantSandboxConfigSchema.optional(),
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
    scope: z.enum(["sessions", "sandboxes", "all"]),
    activeWork: z.enum(["drain", "cancel"]),
  })
  .strict();
export type ResetTenantRequest = z.infer<typeof ResetTenantRequestSchema>;

/**
 * Acting for a subject (Host feature `subject-headers`): what an application principal may
 * narrow a request to. `sessions:own` and `vaults:own` reach only the subject's own sessions
 * and vaults; the others reach Tenant-wide resources. `sandboxes:write` creates and deletes
 * sandboxes (Host feature `sandboxes`); a subject token's reach only the ids its `sbx` grants.
 */
export const SUBJECT_SCOPES = [
  "agents:read",
  "agents:write",
  "sessions:own",
  "vaults:own",
  "tenant:settings",
  "sandboxes:write",
] as const;
export type SubjectScope = (typeof SUBJECT_SCOPES)[number];

/** 1–200 visible ASCII characters; spaces only inside. */
const SUBJECT_PATTERN = /^[\x21-\x7e](?:[\x20-\x7e]{0,198}[\x21-\x7e])?$/;
/**
 * Owner ids the Runtime uses itself: the host model's vault is owned by `host`, installation
 * vaults by `installation`.
 */
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
  const names = (scopes ?? "").split(" ").filter(Boolean);
  if (names.length === 0)
    return {
      ok: false,
      message: "Nylorun-Scopes is required with Nylorun-Subject",
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

// --- subject tokens and the access policy (Host feature `subject-tokens`) ------------------

/** Scopes a subject token may carry: never `agents:write` or `tenant:settings`. */
export const TOKEN_SCOPES = [
  "agents:read",
  "sessions:own",
  "vaults:own",
  "sandboxes:write",
] as const;
/** The most `sandboxes` grants one subject token carries (it is capped at 4 KiB). */
export const TOKEN_SANDBOX_GRANTS_MAX = 16;
export type TokenScope = (typeof TOKEN_SCOPES)[number];
const TokenScopeSchema = z.enum(TOKEN_SCOPES);

/** The JWT `typ` of a subject token (RFC 8725 explicit typing). */
export const SUBJECT_TOKEN_TYPE = "nylorun-subject+jwt";
/** The `aud` of every subject token. */
export const SUBJECT_TOKEN_AUDIENCE = "nylorun";
/** The `iss` of a Tenant's subject tokens. */
export function subjectTokenIssuer(tenantId: string): string {
  return `urn:nylorun:tenant:${tenantId}`;
}
/** Token lifetimes, in seconds. */
export const TOKEN_TTL_MIN_SECONDS = 60;
export const TOKEN_TTL_MAX_SECONDS = 900;
export const TOKEN_TTL_DEFAULT_SECONDS = 600;

/** A role's name in the access policy; `anon` is reserved for publishable keys. */
export const ROLE_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const AgentAllowlistSchema = z.union([
  z.literal("*"),
  z.array(z.string().min(1)),
]);

export const RoleLimitsSchema = z
  .object({
    turnsPerHour: z.number().int().min(1).max(100_000).optional(),
    concurrentTurns: z.number().int().min(1).max(1000).optional(),
  })
  .strict();
export type RoleLimits = z.infer<typeof RoleLimitsSchema>;

export const AccessRoleSchema = z
  .object({
    scopes: z.array(TokenScopeSchema).min(1),
    agents: AgentAllowlistSchema,
    limits: RoleLimitsSchema.optional(),
  })
  .strict();
export type AccessRole = z.infer<typeof AccessRoleSchema>;

/**
 * The Tenant's access policy: what each role may do with a subject token, what a publishable
 * key grants alone (`anon`), and how long tokens live. Without roles nothing can be minted.
 */
export const AccessPolicySchema = z
  .object({
    version: z.literal(1),
    roles: z
      .record(z.string(), AccessRoleSchema)
      .superRefine((roles, issue) => {
        for (const name of Object.keys(roles))
          if (!ROLE_NAME_PATTERN.test(name) || name === "anon")
            issue.addIssue({
              code: "custom",
              message: `Role name ${name} is invalid or reserved`,
              path: [name],
            });
      }),
    anon: z
      .object({
        scopes: z.array(z.literal("agents:read")),
        agents: AgentAllowlistSchema,
      })
      .strict(),
    tokens: z
      .object({
        maxTtlSeconds: z
          .number()
          .int()
          .min(TOKEN_TTL_MIN_SECONDS)
          .max(TOKEN_TTL_MAX_SECONDS),
      })
      .strict(),
  })
  .strict();
export type AccessPolicy = z.infer<typeof AccessPolicySchema>;

/** The policy of a Tenant that never set one: no roles, nothing for `anon`. */
export const DEFAULT_ACCESS_POLICY: AccessPolicy = Object.freeze({
  version: 1,
  roles: {},
  anon: { scopes: [], agents: [] },
  tokens: { maxTtlSeconds: TOKEN_TTL_DEFAULT_SECONDS },
}) as AccessPolicy;

export const PutAccessPolicyRequestSchema = z
  .object({ requestId: RequestIdSchema, policy: AccessPolicySchema })
  .strict();
export type PutAccessPolicyRequest = z.infer<typeof PutAccessPolicyRequestSchema>;

export const CreateTokenRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    subject: z.string().refine(isSubject, "subject must be 1-200 visible ASCII characters and not reserved"),
    role: z.string().regex(ROLE_NAME_PATTERN),
    scopes: z.array(TokenScopeSchema).min(1).optional(),
    agents: z.array(z.string().min(1)).optional(),
    /**
     * The sandboxes the token reaches (its `sbx` claim): exact ids, or prefixes ending in `/*`.
     * Absent or empty: none (Host feature `sandboxes`).
     */
    sandboxes: z.array(SandboxGrantSchema).max(TOKEN_SANDBOX_GRANTS_MAX).optional(),
    ttlSeconds: z
      .number()
      .int()
      .min(TOKEN_TTL_MIN_SECONDS)
      .max(TOKEN_TTL_MAX_SECONDS)
      .optional(),
  })
  .strict();
export type CreateTokenRequest = z.infer<typeof CreateTokenRequestSchema>;

export const CreateTokenResponseSchema = z
  .object({
    token: z.string().min(1),
    /** ISO time the token stops being accepted. */
    expiresAt: z.string().min(1),
    subject: z.string(),
    role: z.string(),
    scopes: z.array(TokenScopeSchema),
    agents: AgentAllowlistSchema,
    /** The token's `sbx` grants, when it has any. */
    sandboxes: z.array(z.string()).optional(),
    keyId: z.string(),
  })
  .strict();
export type CreateTokenResponse = z.infer<typeof CreateTokenResponseSchema>;

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

export const RevokeSubjectRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    subject: z.string().refine(isSubject, "subject must be 1-200 visible ASCII characters and not reserved"),
  })
  .strict();
export type RevokeSubjectRequest = z.infer<typeof RevokeSubjectRequestSchema>;
export const RevokeSubjectResponseSchema = z
  .object({ subject: z.string(), epoch: z.number().int().nonnegative() })
  .strict();

// --- trusted issuers (Host feature `trusted-issuers`) --------------------------------------

/**
 * Scopes a trusted issuer's tokens may carry (`allowedScopes` in the identity file): the
 * subject token scopes, and `studio`, an operator scope no Runtime route requires (Studio
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
 *   acting as itself), `subject` (an application key acting for `Nylorun-Subject`), `token`
 *   (a subject token) or `issuer:<name>` (a token from the identity file's issuer `name`).
 * - `subject` is the person the request acts for; absent for an application key alone.
 * - `scopes`: what the caller holds. An application key alone holds every subject scope.
 * - `agents`: the agents it may reach, `*` for all.
 * - `sandboxes`: the sandbox grants of a token caller (empty reaches none); absent for an
 *   application key, alone or acting for a subject, which no grant limits.
 */
export const MeResponseSchema = z
  .object({
    subject: z
      .string()
      .optional()
      .meta({ description: "The person the request acts for; absent for an application key alone" }),
    scopes: z.array(z.enum(CALLER_SCOPES)),
    agents: AgentAllowlistSchema,
    sandboxes: z
      .array(z.string())
      .optional()
      .meta({
        description:
          "A token caller's sandbox grants (empty reaches none); absent when no grant limits the caller",
      }),
    via: z.string().meta({
      description:
        "How the caller authenticated: `application:<principalId>`, `subject`, `token` or `issuer:<name>`",
    }),
  })
  .strict();
export type MeResponse = z.infer<typeof MeResponseSchema>;

/** The claims of a subject token, as the Runtime writes them. */
export interface SubjectTokenClaims {
  iss: string;
  aud: string;
  /** Tenant id. */
  tnt: string;
  sub: string;
  role: string;
  /** Space-separated token scopes. */
  scp: string;
  /** The agents the mint narrowed the role to; absent when not narrowed. */
  agt?: string[];
  /** The sandboxes the token reaches: exact ids, or prefixes ending in `/*`. */
  sbx?: string[];
  /** The subject's revocation epoch when minted. */
  epc: number;
  iat: number;
  exp: number;
  jti: string;
}

// --- publishable keys (Host feature `browser-access`) --------------------------------------

/** Loopback origins with any port, for development: `http://localhost:*`, `http://127.0.0.1:*`. */
export const LOOPBACK_ORIGIN_WILDCARDS = ["http://localhost:*", "http://127.0.0.1:*"] as const;

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

/** An origin allowlist entry: an exact origin or a loopback wildcard. */
export const OriginEntrySchema = z
  .string()
  .refine(
    (value) =>
      (LOOPBACK_ORIGIN_WILDCARDS as readonly string[]).includes(value) ||
      isSerializedOrigin(value),
    "must be an origin such as https://app.example.com, or http://localhost:*"
  );

/** True when `origin` (a request's `Origin`) is allowed by `origins`. */
export function originAllowed(origins: readonly string[], origin: string): boolean {
  if (!isSerializedOrigin(origin)) return false;
  for (const entry of origins) {
    if (entry === origin) return true;
    if (entry.endsWith(":*")) {
      const prefix = entry.slice(0, -1);
      if (origin.startsWith(prefix) && /^\d{1,5}$/.test(origin.slice(prefix.length)))
        return true;
    }
  }
  return false;
}

export const PublishableKeySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    key: z.string(),
    origins: z.array(z.string()),
    createdAt: z.string(),
    revokedAt: z.string().nullable(),
  })
  .strict();
export type PublishableKey = z.infer<typeof PublishableKeySchema>;

export const CreatePublishableKeyRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    name: z.string().min(1).max(100),
    /** `[]` allows native apps only (no `Origin`). */
    origins: z.array(OriginEntrySchema).max(100),
  })
  .strict();
export type CreatePublishableKeyRequest = z.infer<typeof CreatePublishableKeyRequestSchema>;

export const UpdatePublishableKeyRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    origins: z.array(OriginEntrySchema).max(100),
  })
  .strict();

// Successful answers of the Tenant and Admin APIs that had no schema of their own. With the
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
/** `GET /v1/agents` with a subject token or publishable key: the allowed agents' names only. */
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
    implementationVersion: z.string(),
    status: z.enum(SESSION_STATUSES),
    activeTurnId: z.string().nullable(),
    vaultIds: z.array(z.string()),
    credentialSelections: z.array(CredentialSelectionSchema),
    /**
     * The session whose sandbox this one shares; `null` when it owns its own. Deprecated: share
     * a sandbox resource with `sandbox: { id }` (the client's `sandboxes.forSession()`).
     */
    sandboxOwnerId: z.string().nullable(),
    /** The sandbox resource the session is attached to (`sandbox: { id }`), if any. */
    sandboxId: z.string().optional(),
    /** The sandbox pinned when the session was opened, or `null`. */
    sandbox: z.record(z.string(), z.unknown()).nullable(),
    sandboxSource: z.enum(["default", "inline", "shared", "sandbox"]).optional(),
    mcpSnapshot: z.record(z.string(), z.unknown()).nullable(),
    mcpDiagnostics: z.array(z.record(z.string(), z.unknown())),
    /** What the session waits on: interactions, approvals, timers. */
    waits: z.unknown().optional(),
    error: z.string().optional(),
    /** Its Actions that are pending, being delivered or uncertain. */
    actions: z.array(ActionSchema),
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
/** `GET /v1/tenant/models`: public provider and model names, no credentials. */
export const HostModelCatalogSchema = z
  .object({
    providers: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          models: z.array(z.object({ id: z.string(), name: z.string() }).strict()),
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
    lastUpdated: z.string(),
    active: z.boolean(),
  })
  .strict();
export const ListProvidersResponseSchema = z
  .object({ providers: z.array(HostModelProviderInfoSchema) })
  .strict();
export type ListProvidersResponse = z.infer<typeof ListProvidersResponseSchema>;
const SandboxResourcesLimitSchema = z
  .object({ cpus: z.number(), memoryMiB: z.number() })
  .strict();
/** A Tenant's sandbox configuration with every default applied (sizes in MiB). */
export const EffectiveSandboxConfigSchema = z
  .object({
    default: z.union([z.literal("none"), z.literal("virtual"), SandboxInlineRequestSchema]),
    limits: z
      .object({
        network: z.array(z.string()),
        resources: SandboxResourcesLimitSchema,
        defaultResources: SandboxResourcesLimitSchema,
        idle: z.string(),
        /** The most sandbox resources the Tenant may hold. */
        sandboxes: z.number().int().nonnegative().optional(),
        /** Pods: the longest `lifecycle.ttl`, when the Tenant sets one. */
        ttl: z.string().optional(),
      })
      .strict(),
    /** Pods (Host feature `sandbox-pods`): what happens at expiry, and the pod's stop grace. */
    lifecycle: z
      .object({ onExpiry: z.enum(["retain", "delete"]), stopGrace: z.string() })
      .strict()
      .optional(),
    /** Where each harness may run (D38). */
    placement: z
      .record(z.string(), z.object({ hosts: z.array(z.enum(SANDBOX_PLACEMENT_HOSTS)) }).strict())
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
     * The Tenant's cluster for pod sandboxes (`nylorun sandbox enable`), as the sandboxes
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

export const ListVaultsResponseSchema = z.object({ vaults: z.array(VaultInfoSchema) }).strict();
export type ListVaultsResponse = z.infer<typeof ListVaultsResponseSchema>;
export const ListCredentialsResponseSchema = z
  .object({ credentials: z.array(CredentialInfoSchema) })
  .strict();
export type ListCredentialsResponse = z.infer<typeof ListCredentialsResponseSchema>;
/** A deleted vault or credential. */
export const DeletedResponseSchema = z.object({ id: z.string() }).strict();
export type DeletedResponse = z.infer<typeof DeletedResponseSchema>;

export const AccessPolicyResponseSchema = z.object({ policy: AccessPolicySchema }).strict();
export type AccessPolicyResponse = z.infer<typeof AccessPolicyResponseSchema>;
export const ListPublishableKeysResponseSchema = z
  .object({ keys: z.array(PublishableKeySchema) })
  .strict();
export type ListPublishableKeysResponse = z.infer<typeof ListPublishableKeysResponseSchema>;

export const HostShutdownResponseSchema = z
  .object({ status: z.literal("shutting_down") })
  .strict();

/** The last frame of a session stream the Runtime ends: `event: nylorun.closed`. */
export const StreamClosedFrameSchema = z
  .object({ reason: z.enum(["token_expired", "revoked"]) })
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

// --- Action endpoints: the Runtime delivers Actions over HTTP ------------------------------

/** The JWT `typ` of a delivery token (RFC 8725 explicit typing). */
export const DELIVERY_TOKEN_TYPE = "nylorun-delivery+jwt";
/**
 * A delivery token lives no longer than a subject token: rotating signing keys revokes the
 * previous key once the longest token it may have signed has expired.
 */
export const DELIVERY_TOKEN_MAX_TTL_SECONDS = TOKEN_TTL_MAX_SECONDS;
/** Inline delivery timeouts, in milliseconds. The maximum keeps a token within its lifetime. */
export const ENDPOINT_TIMEOUT_DEFAULT_MS = 60_000;
export const ENDPOINT_TIMEOUT_MAX_MS = (DELIVERY_TOKEN_MAX_TTL_SECONDS - 60) * 1000;
/** In-flight deliveries per endpoint when the registration does not say. */
export const ENDPOINT_MAX_CONCURRENT_DEFAULT = 16;

const isEndpointUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
};
const EndpointUrlSchema = z
  .string()
  .max(2048)
  .refine(isEndpointUrl, {
    message: "An endpoint URL is an http or https URL without credentials or a fragment",
  });

/** One agent's or workflow's Action endpoint, as the application registers it. */
export const EndpointRegistrationSchema = z
  .object({
    agentId: z.string().min(1),
    url: EndpointUrlSchema,
    implementationVersion: z.string().min(1),
    manifestHash: z.string().min(1).optional(),
    timeoutMs: z.number().int().min(1000).max(ENDPOINT_TIMEOUT_MAX_MS).optional(),
    maxConcurrent: z.number().int().min(1).max(256).optional(),
  })
  .strict();
export type EndpointRegistration = z.infer<typeof EndpointRegistrationSchema>;

export const PutEndpointsRequestSchema = z
  .object({
    endpoints: z
      .array(EndpointRegistrationSchema)
      .min(1)
      .max(64)
      .refine(
        (endpoints) => new Set(endpoints.map((e) => e.agentId)).size === endpoints.length,
        { message: "Endpoint registrations must be unique per agent" },
      ),
  })
  .strict();
export type PutEndpointsRequest = z.infer<typeof PutEndpointsRequestSchema>;

/** What recent deliveries and the last ping say about an endpoint. */
export const EndpointHealthSchema = z
  .object({
  lastDeliveryAt: z.string().optional(),
  lastSuccessAt: z.string().optional(),
  lastError: z.object({ code: z.string(), message: z.string() }).optional(),
  consecutiveFailures: z.number().int().nonnegative(),
  /** What the handler reported serving on the last ping. */
  served: z
    .object({
      implementationVersion: z.string(),
      manifestHash: z.string().optional(),
    })
    .strict()
    .optional(),
  })
  .strict();
export type EndpointHealth = z.infer<typeof EndpointHealthSchema>;

export const EndpointSchema = z
  .object({
    agentId: z.string(),
    url: z.string(),
    implementationVersion: z.string(),
    manifestHash: z.string().optional(),
    timeoutMs: z.number().int(),
    maxConcurrent: z.number().int(),
    health: EndpointHealthSchema,
    updatedAt: z.string(),
  })
  .strict();
export type Endpoint = z.infer<typeof EndpointSchema>;
export const ListEndpointsResponseSchema = z
  .object({
    endpoints: z.array(EndpointSchema),
  })
  .strict();
export type ListEndpointsResponse = z.infer<typeof ListEndpointsResponseSchema>;
export const DeleteEndpointResponseSchema = z
  .object({ agentId: z.string(), deleted: z.literal(true) })
  .strict();
export type DeleteEndpointResponse = z.infer<typeof DeleteEndpointResponseSchema>;

/** The body the Runtime POSTs to an Action endpoint. */
export const ActionDeliverySchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("action"),
      action: ActionSchema,
      /** The Action's session has a sandbox, so `ctx.sandbox` is available. */
      sandbox: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("ping"),
      agentId: z.string().min(1),
      manifestHash: z.string().min(1).optional(),
    })
    .strict(),
]);
export type ActionDelivery = z.infer<typeof ActionDeliverySchema>;

/** An Action endpoint's answer to a ping. */
export const EndpointPingResponseSchema = z.object({
  agentId: z.string(),
  implementationVersion: z.string(),
  manifestHash: z.string().optional(),
});
export type EndpointPingResponse = z.infer<typeof EndpointPingResponseSchema>;

/** The answer to a background delivery's heartbeat: a fresh token and the new deadline. */
export const DeliveryHeartbeatResponseSchema = z.object({
  token: z.string().min(1),
  deadlineAt: z.string(),
});
export type DeliveryHeartbeatResponse = z.infer<typeof DeliveryHeartbeatResponseSchema>;

/**
 * The receipt of a background result (`POST /v1/actions/:id/result`): a session command's
 * receipt without `requestId`, since the result carries none. The same result again returns it.
 */
export const ActionResultReceiptSchema = AcceptedResponseSchema.omit({ requestId: true });
export type ActionResultReceipt = z.infer<typeof ActionResultReceiptSchema>;


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
  embed("open.babai", { sessionId: z.string().min(1) }),
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
 * A capability link lives no longer than a subject token: rotating signing keys revokes the
 * previous key once the longest token it may have signed has expired.
 */
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

/** What an upload answers: the artifact, and the version the upload created. */
export const UploadArtifactResponseSchema = z
  .object({ artifact: ArtifactViewSchema, version: ArtifactVersionViewSchema })
  .strict();
export type UploadArtifactResponse = z.infer<typeof UploadArtifactResponseSchema>;

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
/** The folder artifact a session's turn-end export writes, one per session. */
export const OUTPUTS_ARTIFACT_NAME = "outputs";
/** The most files one turn-end export stores; past it the export is skipped. */
export const EXPORT_MAX_FILES = 10_000;
/** The most bytes one turn-end export stores (before dedupe); past it the export is skipped. */
export const EXPORT_MAX_BYTES = 1024 * 1024 * 1024;

/** One file of a folder: its path in the folder (`/`-separated, relative), size, hash and type. */
export const FolderEntrySchema = z
  .object({
    path: z.string().min(1).max(ARTIFACT_PATH_MAX),
    size: z.number().int().nonnegative(),
    sha256: z.string().meta({ description: "SHA-256 of the file's bytes, lowercase hex" }),
    contentType: z.string(),
  })
  .strict();
export type FolderEntry = z.infer<typeof FolderEntrySchema>;

/**
 * A folder version as stored: the files, sorted by path, each naming its content-addressed
 * bytes by SHA-256. The one manifest format for folders, reused by P5's snapshots.
 */
export const FolderManifestSchema = z
  .object({
    format: z.literal(FOLDER_MANIFEST_FORMAT),
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
