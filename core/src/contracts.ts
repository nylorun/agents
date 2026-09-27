/** Public wire contracts only. Never import checkpoint or engine modules here. */
import { z } from "zod";
import type { AgentManifest } from "./types/manifest.js";
import type { JsonValue } from "./types/shared.js";
import type { WorkflowManifest } from "./types/workflow.js";
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
    agent: z.lazy((): z.ZodType<AgentManifest> => AgentManifestSchema).optional(),
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
/** Workflow definition document. `kind: "workflow"`; a missing `kind` is never a workflow. */
export const WorkflowManifestSchema = z
  .object({
    kind: z.literal("workflow"),
    workflowSchemaVersion: z.literal(1),
    id: z.string().min(1),
    root: workflowNodeSchema,
    sandbox: sandboxManifestSchema.optional(),
  })
  .strict() as z.ZodType<WorkflowManifest>;
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
  })
  .strict();
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
     * host model, e.g. for a temporary development Tenant (`nylorun dev --ephemeral`). Stored
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
