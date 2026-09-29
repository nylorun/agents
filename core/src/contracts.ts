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
import { DERIVED_PRINCIPAL_ID_PATTERN } from "./compatibility.js";
export type { ErrorCode } from "./compatibility.js";
import { ERROR_CODES } from "./compatibility.js";
export const RequestIdSchema = z.string().min(1);
export const IdempotencyKeySchema = z.string().min(1).max(256);
const jsonObject = z.record(z.string(), z.unknown());
const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ])
);
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
);
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
);
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
);
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
export const PutSessionRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    agentId: z.string().min(1),
    ownerUserId: z.string().min(1),
    info: jsonObject.optional(),
    vaultIds: z.array(z.string().min(1)).optional(),
    credentialSelections: z.array(CredentialSelectionSchema).optional(),
    /** Share another session's sandbox (same owner, Tenant, and identical specs). */
    sandbox: z.object({ session: z.string().min(1) }).strict().optional(),
  })
  .strict();
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
export const CreateVaultRequestSchema = z
  .object({
    ...vaultWriteBase,
    name: z.string().min(1),
    ownerUserId: z.string().min(1),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();
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
export const PutHostModelRequestSchema = z
  .object({
    ...vaultWriteBase,
    provider: z.string().min(1),
    model: z.string().min(1),
    baseUrl: z.string().min(1).optional(),
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
export type HostModelProviderInfo = {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly authType: "api_key" | "oauth";
  readonly baseUrl?: string;
  readonly lastUpdated: string;
  readonly active: boolean;
};
export interface VaultInfo {
  readonly id: string;
  readonly name: string;
  readonly ownerUserId: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly createdAt: string;
}
export interface CredentialInfo {
  readonly id: string;
  readonly vaultId: string;
  readonly name: string;
  readonly type: "bearer" | "oauth";
  readonly binding: { readonly url: string };
  readonly expiresAt?: string;
  readonly createdAt: string;
  readonly rotatedAt?: string;
}
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
/** Exactly one of `content` or `data`. Optional `manifest` for per-turn agent patches. */
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
]);
export const ActionOutcomeSchema = z
  .object({
    value: z.unknown(),
    statePatch: jsonObject.optional(),
  })
  .strict();
export type ActionOutcome = z.infer<typeof ActionOutcomeSchema>;
export const ActionResultCommandSchema = z
  .object({
    ...commandBase,
    type: z.literal("action_result"),
    actionId: z.string().min(1),
    claimId: z.string().min(1),
    generation: z.number().int().positive(),
    outcome: ActionOutcomeSchema,
  })
  .strict();
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
  ActionResultCommandSchema,
]);
export const SessionEventBodySchema = SessionCommandSchema;
export type SessionCommand = z.infer<typeof SessionCommandSchema>;
export type SessionEventBody = SessionCommand;
export type MessageEventBody = z.infer<typeof MessageEventBodySchema>;
export const LiveEventSchema = z
  .object({
    eventId: z.string(),
    sessionId: z.string(),
    tenantId: z.string().min(1),
    turnId: z.string().nullable(),
    cursor: z.string(),
    createdAt: z.string(),
    type: z.string(),
    payload: z.unknown(),
  })
  .strict();
export type LiveEvent = z.infer<typeof LiveEventSchema>;
export const SessionItemsResponseSchema = z.object({
  items: z.array(LiveEventSchema),
  cursor: z.string().nullable(),
});
export type SessionItemsResponse = z.infer<typeof SessionItemsResponseSchema>;
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
  status: z.enum(["pending", "claimed", "completed", "uncertain", "cancelled"]),
  generation: z.number().int().nonnegative(),
  claimId: z.string().nullable(),
  leaseExpiresAt: z.string().nullable(),
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
 * renders. `LiveEvent.payload` stays `unknown` on the wire; `parseTranscriptEvent`
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
/** `message.assistant`: one completed model step. `invocationId` is the model call's. */
export const AssistantMessagePayloadSchema = z
  .object({
    invocationId: z.string().min(1),
    text: z.string(),
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
export type TranscriptEvent = {
  [K in TranscriptEventType]: Omit<LiveEvent, "type" | "payload"> & {
    type: K;
    payload: z.infer<(typeof TRANSCRIPT_PAYLOADS)[K]>;
  };
}[TranscriptEventType];
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
export const ActionClaimRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    implementationVersion: z.string().min(1),
  })
  .strict();
export const ActionHeartbeatRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    claimId: z.string().min(1),
    generation: z.number().int().positive(),
  })
  .strict();
export const ActionClaimResponseSchema = z.object({
  action: ActionSchema,
  claimId: z.string(),
  generation: z.number().int().positive(),
  leaseExpiresAt: z.string(),
});
export type ActionClaim = z.infer<typeof ActionClaimResponseSchema>;
export interface ExecutorScope {
  readonly agentId: string;
  readonly manifestHash?: string;
  readonly implementationVersion: string;
}
export const ExecutorNotificationSchema = z.object({
  type: z.literal("work_available"),
});
export const ExecutorRegistrationSchema = z
  .object({
    agentId: z.string().min(1),
    implementationVersion: z.string().min(1),
    manifestHash: z.string().min(1).optional(),
    token: z.string().min(16),
  })
  .strict();
export const RegisterExecutorsRequestSchema = z
  .object({
    executors: z.array(ExecutorRegistrationSchema).min(1).max(64),
  })
  .strict();
export const RegisterExecutorsResponseSchema = z.object({
  executors: z.array(
    z.object({
      agentId: z.string(),
      implementationVersion: z.string(),
      rotated: z.boolean(),
      replacedBy: z.literal("different-credential").optional(),
    })
  ),
});
export const ExecutorSummarySchema = z.object({
  agentId: z.string(),
  implementationVersion: z.string(),
  manifestHash: z.string().optional(),
  connected: z.boolean(),
  updatedAt: z.string(),
});
export const ListExecutorsResponseSchema = z.object({
  executors: z.array(ExecutorSummarySchema),
});
export type ExecutorRegistration = z.infer<typeof ExecutorRegistrationSchema>;
export type RegisterExecutorsResponse = z.infer<
  typeof RegisterExecutorsResponseSchema
>;
export type ExecutorSummary = z.infer<typeof ExecutorSummarySchema>;
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

export const CreateTenantRequestSchema = z
  .object({
    tenantId: z.string().min(1),
    name: z.string().min(1),
    /** `studio` is reserved for the derived Studio principal. */
    principalId: z
      .string()
      .min(1)
      .refine((id) => id !== "studio", "principalId `studio` is reserved"),
    credentialHash: z.string().regex(/^[0-9a-f]{64}$/),
    idempotencyKey: IdempotencyKeySchema,
    /** SHA-256 of the derived Studio key; registers principal `studio` (feature `studio-principal`). */
    studioCredentialHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    /**
     * SHA-256 of each derived principal's key (feature `derived-principals`): application
     * principals whose keys the admin key derives, so their clients store no key.
     */
    derivedPrincipals: z
      .array(
        z
          .object({
            id: z
              .string()
              .regex(DERIVED_PRINCIPAL_ID_PATTERN)
              .refine((id) => id !== "studio", "principal id `studio` is reserved"),
            credentialHash: z.string().regex(/^[0-9a-f]{64}$/),
          })
          .strict()
      )
      .max(16)
      .optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    const ids = new Set([body.principalId]);
    const hashes = new Set([body.credentialHash]);
    if (body.studioCredentialHash) hashes.add(body.studioCredentialHash);
    for (const [index, principal] of (body.derivedPrincipals ?? []).entries()) {
      if (ids.has(principal.id))
        ctx.addIssue({
          code: "custom",
          path: ["derivedPrincipals", index, "id"],
          message: `Principal id ${principal.id} is used twice`,
        });
      if (hashes.has(principal.credentialHash))
        ctx.addIssue({
          code: "custom",
          path: ["derivedPrincipals", index, "credentialHash"],
          message: "Every principal needs its own credential",
        });
      ids.add(principal.id);
      hashes.add(principal.credentialHash);
    }
  });
export type CreateTenantRequest = z.infer<typeof CreateTenantRequestSchema>;

export const AdminTenantSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().nullable(),
    state: z.enum(["open", "quarantined"]),
    envelope: TenantEnvelopeSchema.nullable(),
  })
  .strict();
export type AdminTenant = z.infer<typeof AdminTenantSchema>;

export const QuarantineSchema = z
  .object({
    code: z.enum([
      "kek-missing",
      "corrupt",
      "schema-too-new",
      "migration-failed",
      "envelope-invalid",
      "open-timeout",
      "open-failed",
    ]),
    message: z.string(),
    repair: z.string(),
  })
  .strict();
export type QuarantineInfo = z.infer<typeof QuarantineSchema>;

export const AdminTenantStatusSchema = AdminTenantSchema.extend({
  quarantine: QuarantineSchema.optional(),
});
export type AdminTenantStatus = z.infer<typeof AdminTenantStatusSchema>;

export const HostAggregateSchema = z
  .object({
    runningSessions: z.number().int().nonnegative(),
    connectedExecutors: z.number().int().nonnegative(),
    pendingActions: z.number().int().nonnegative(),
    uncertainEffects: z.number().int().nonnegative(),
    /** Events committed but not yet relayed to Durable Streams, over the open Tenants. */
    outboxDepth: z.number().int().nonnegative().optional(),
    /** The largest relay lag of an open Tenant: its oldest unrelayed event's age. */
    relayLagMs: z.number().nonnegative().optional(),
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
    tenants: z.array(AdminTenantSchema),
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
    tenants: z.array(AdminTenantSchema),
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

export const ProjectLinkFileSchema = z
  .object({
    format: z.union([z.literal(0), z.literal(1)]).default(0),
    hostUrl: z.string().min(1),
    hostId: z.string().min(1),
    tenantId: z.string().min(1),
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
        executors: z.boolean(),
        schema: z.boolean(),
      })
      .strict(),
    model: HostModelViewSchema,
    agents: z.array(
      z
        .object({
          agentId: z.string(),
          registered: z.boolean(),
          connected: z.boolean(),
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
        outbox: z
          .object({
            depth: z.number().int().nonnegative(),
            oldestAgeMs: z.number().nonnegative().nullable(),
          })
          .strict(),
        relayLagMs: z.number().nonnegative(),
        collectionPending: z.boolean(),
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
        backend: z.enum(["auto", "virtual"]),
      })
      .strict()
      .optional(),
    model: seedModelSchema.optional(),
    /**
     * The Tenant's model calls use the Runtime's deterministic fixture model instead of its
     * host model, e.g. for a temporary test Tenant (scripts/lib/temporary-tenant.mjs). Stored
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
 * and vaults; the others reach Tenant-wide resources.
 */
export const SUBJECT_SCOPES = [
  "agents:read",
  "agents:write",
  "sessions:own",
  "vaults:own",
  "tenant:settings",
] as const;
export type SubjectScope = (typeof SUBJECT_SCOPES)[number];

/** 1–200 visible ASCII characters; spaces only inside. */
const SUBJECT_PATTERN = /^[\x21-\x7e](?:[\x20-\x7e]{0,198}[\x21-\x7e])?$/;
/** Owner ids the Runtime uses itself: the host model's vault is owned by `host`. */
const RESERVED_SUBJECTS = new Set(["host"]);

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
export const TOKEN_SCOPES = ["agents:read", "sessions:own", "vaults:own"] as const;
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
  /** The subject's revocation epoch when minted. */
  epc: number;
  iat: number;
  exp: number;
  jti: string;
}
