/**
 * Named schemas of the OpenAPI document: each becomes `#/components/schemas/<id>`, referenced
 * wherever a route uses it. Named with Zod's own `.meta({ id })`, which works on the contracts'
 * schemas whenever they were created; made once per process, since ids are unique in Zod's
 * global registry.
 */
import { z } from "zod";
import {
  QueuedResponseSchema,
  AgentManifestV8Schema,
  EnvironmentSecretSlotsSchema,
  DeleteAgentManifestResponseSchema,
  AgentManifestPlanSchema,
  AgentManifestVersionsSchema,
  AgentManifestViewSchema,
  ListAgentManifestsResponseSchema,
  PutAgentManifestRequestSchema,
  PutAgentSecretValueRequestSchema,
  SaveAgentManifestResponseSchema,
  SessionListItemSchema,
  ModelCallSchema,
  SessionPageSchema,
  SessionManifestViewSchema,
  HistoryPageSchema,
  SessionUsageTotalsSchema,
  ModelCallsPageSchema,
  ModelCallExportPageSchema,
  AgentPageSchema,
  ToolCallSchema,
  ToolCallsPageSchema,
  TurnTraceSchema,
  JwksSchema,
  SigningKeyListSchema,
  SigningKeyViewSchema,
  RotateSigningKeysRequestSchema,
  RevokeSigningKeyRequestSchema,
  MeResponseSchema,
  TenantStatusSchema,
  ResetTenantRequestSchema,
  ResetTenantResponseSchema,
  SeedTenantConfigRequestSchema,
  SeedTenantConfigResponseSchema,
  HostModelCatalogSchema,
  TenantSandboxViewSchema,
  ModelUsageTotalsSchema,
  ModelBudgetsSchema,
  PutModelBudgetsRequestSchema,
  ToolPolicySchema,
  PutToolPolicyRequestSchema,
  PutModelInputsRequestSchema,
  ModelInputsViewSchema,
  PutTenantEnvironmentsRequestSchema,
  ListProvidersResponseSchema,
  HostModelViewSchema,
  PutHostModelRequestSchema,
  SelectHostModelRequestSchema,
  PutAgentSecretRequestSchema,
  AgentSecretViewSchema,
  ListAgentSecretsResponseSchema,
  McpPreviewRequestSchema,
  McpPreviewSchema,
  CredentialCoverageRequestSchema,
  CredentialCoverageSchema,
  DeletedResponseSchema,
  ListSessionsResponseSchema,
  LiveEventSchema,
  PutAgentRequestSchema,
  PutSessionRequestSchema,
  SessionItemsResponseSchema,
  SessionViewSchema,
  StreamClosedFrameSchema,
  AcceptedResponseSchema,
  SandboxToolOutcomeSchema,
  AgentViewSchema,
  AgentSnapshotSchema,
  RestoreAgentRequestSchema,
  ForkAgentRequestSchema,
  AgentForkPlanSchema,
  ForkAgentResponseSchema,
  PutAgentDryRunResponseSchema,
  RestartAgentRequestSchema,
  AgentRestoreSchema,
  AgentDiskVersionsSchema,
  ListAgentsResponseSchema,
  DeleteAgentResponseSchema,
  ListAgentEventsResponseSchema,
  ArtifactViewSchema,
  ArtifactListItemSchema,
  ArtifactPageSchema,
  ArtifactVersionViewSchema,
  ListArtifactsResponseSchema,
  UploadArtifactResponseSchema,
  DefinitionFileViewSchema,
  DeleteArtifactResponseSchema,
  CreateArtifactLinkRequestSchema,
  ArtifactLinkSchema,
  PutTenantArtifactsRequestSchema,
  PutTenantSkillsRequestSchema,
  PutTenantLimitsRequestSchema,
  TenantLimitsViewSchema,
  TenantArtifactsViewSchema,
  TenantSkillsViewSchema,
  ArtifactTreeSchema,
  ArtifactDiffSchema,
  SessionCommandSchema,
  ListOperatorKeysResponseSchema,
  PutOperatorKeyResponseSchema,
  DeleteOperatorKeyResponseSchema,
  OperatorKeySchema,
  ProtocolRejectedResponseSchema,
  RejectedResponseSchema,
  EVENT_SCHEMAS,
  EVENT_TYPES,
  type EventType,
} from "@nylorun/core/contracts";

function named<T extends z.ZodType>(id: string, schema: T): T {
  return schema.meta({ id }) as T;
}

export const Rejected = named("Rejected", RejectedResponseSchema);
export const ProtocolRejected = named("ProtocolRejected", ProtocolRejectedResponseSchema);
export const OperatorKey = named("OperatorKey", OperatorKeySchema);
export const ListOperatorKeysResponse = named(
  "ListOperatorKeysResponse",
  ListOperatorKeysResponseSchema,
);
export const PutOperatorKeyResponse = named("PutOperatorKeyResponse", PutOperatorKeyResponseSchema);
export const DeleteOperatorKeyResponse = named(
  "DeleteOperatorKeyResponse",
  DeleteOperatorKeyResponseSchema,
);

export const SandboxToolOutcome = named("SandboxToolOutcome", SandboxToolOutcomeSchema);
export const PutAgentRequest = named("PutAgentRequest", PutAgentRequestSchema);
export const AgentView = named("AgentView", AgentViewSchema);
export const EnvironmentSecretSlots = named("EnvironmentSecretSlots", EnvironmentSecretSlotsSchema);
export const AgentManifest = named("AgentManifest", AgentManifestV8Schema);
export const PutAgentManifestRequest = named("PutAgentManifestRequest", PutAgentManifestRequestSchema);
export const AgentManifestView = named("AgentManifestView", AgentManifestViewSchema);
export const AgentManifestPlan = named("AgentManifestPlan", AgentManifestPlanSchema);
export const SaveAgentManifestResponse = named("SaveAgentManifestResponse", SaveAgentManifestResponseSchema);
export const ListAgentManifestsResponse = named("ListAgentManifestsResponse", ListAgentManifestsResponseSchema);
export const AgentManifestVersions = named("AgentManifestVersions", AgentManifestVersionsSchema);
export const DeleteAgentManifestResponse = named("DeleteAgentManifestResponse", DeleteAgentManifestResponseSchema);
export const PutAgentSecretValueRequest = named("PutAgentSecretValueRequest", PutAgentSecretValueRequestSchema);
export const AgentSnapshot = named("AgentSnapshot", AgentSnapshotSchema);
export const RestoreAgentRequest = named("RestoreAgentRequest", RestoreAgentRequestSchema);
export const AgentRestore = named("AgentRestore", AgentRestoreSchema);
export const ForkAgentRequest = named("ForkAgentRequest", ForkAgentRequestSchema);
export const AgentForkPlan = named("AgentForkPlan", AgentForkPlanSchema);
export const ForkAgentResponse = named("ForkAgentResponse", ForkAgentResponseSchema);
export const PutAgentDryRunResponse = named("PutAgentDryRunResponse", PutAgentDryRunResponseSchema);
export const RestartAgentRequest = named("RestartAgentRequest", RestartAgentRequestSchema);
export const AgentDiskVersions = named("AgentDiskVersions", AgentDiskVersionsSchema);
export const ListAgentsResponse = named("ListAgentsResponse", ListAgentsResponseSchema);
export const DeleteAgentResponse = named("DeleteAgentResponse", DeleteAgentResponseSchema);
export const ListAgentEventsResponse = named("ListAgentEventsResponse", ListAgentEventsResponseSchema);
export const ArtifactVersionView = named("ArtifactVersionView", ArtifactVersionViewSchema);
export const ArtifactView = named("ArtifactView", ArtifactViewSchema);
export const ArtifactListItem = named("ArtifactListItem", ArtifactListItemSchema);
export const ArtifactPage = named(
  "ArtifactPage",
  ArtifactPageSchema.extend({ artifacts: z.array(ArtifactListItem) }),
);
export const ListArtifactsResponse = named("ListArtifactsResponse", ListArtifactsResponseSchema);
export const UploadArtifactResponse = named("UploadArtifactResponse", UploadArtifactResponseSchema);
export const DefinitionFileView = named("DefinitionFileView", DefinitionFileViewSchema);
export const DeleteArtifactResponse = named("DeleteArtifactResponse", DeleteArtifactResponseSchema);
export const CreateArtifactLinkRequest = named(
  "CreateArtifactLinkRequest",
  CreateArtifactLinkRequestSchema,
);
export const ArtifactLink = named("ArtifactLink", ArtifactLinkSchema);
export const PutTenantArtifactsRequest = named(
  "PutTenantArtifactsRequest",
  PutTenantArtifactsRequestSchema,
);
export const TenantArtifactsView = named("TenantArtifactsView", TenantArtifactsViewSchema);
export const PutTenantSkillsRequest = named("PutTenantSkillsRequest", PutTenantSkillsRequestSchema);
export const TenantSkillsView = named("TenantSkillsView", TenantSkillsViewSchema);
export const PutTenantLimitsRequest = named("PutTenantLimitsRequest", PutTenantLimitsRequestSchema);
export const TenantLimitsView = named("TenantLimitsView", TenantLimitsViewSchema);
export const ArtifactTree = named("ArtifactTree", ArtifactTreeSchema);
export const ArtifactDiff = named("ArtifactDiff", ArtifactDiffSchema);
export const SessionCommand = named("SessionCommand", SessionCommandSchema);
export const AcceptedResponse = named("AcceptedResponse", AcceptedResponseSchema);
export const QueuedResponse = named("QueuedResponse", QueuedResponseSchema);

export const ListSessionsResponse = named("ListSessionsResponse", ListSessionsResponseSchema);
export const PutSessionRequest = named("PutSessionRequest", PutSessionRequestSchema);
export const SessionView = named("SessionView", SessionViewSchema);
export const LiveEvent = named("LiveEvent", LiveEventSchema);

/** `environment.state` → `EnvironmentStateEvent`. */
export function eventComponentName(type: EventType): string {
  return `${type
    .split(/[._]/)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("")}Event`;
}
/** The event catalog as components: one per event type, and `SessionEvent`, their union. */
export const SessionEvent = named(
  "SessionEvent",
  z.discriminatedUnion(
    "type",
    EVENT_TYPES.map((type) => named(eventComponentName(type), EVENT_SCHEMAS[type])) as [
      (typeof EVENT_SCHEMAS)[EventType],
      ...(typeof EVENT_SCHEMAS)[EventType][],
    ]
  )
);
export const SessionItemsResponse = named(
  "SessionItemsResponse",
  SessionItemsResponseSchema.extend({ items: z.array(SessionEvent) })
);
export const StreamClosedFrame = named("StreamClosedFrame", StreamClosedFrameSchema);

export const TenantStatus = named("TenantStatus", TenantStatusSchema);
export const ResetTenantRequest = named("ResetTenantRequest", ResetTenantRequestSchema);
export const ResetTenantResponse = named("ResetTenantResponse", ResetTenantResponseSchema);
export const SeedTenantConfigRequest = named("SeedTenantConfigRequest", SeedTenantConfigRequestSchema);
export const SeedTenantConfigResponse = named("SeedTenantConfigResponse", SeedTenantConfigResponseSchema);
export const HostModelCatalog = named("HostModelCatalog", HostModelCatalogSchema);
export const TenantSandboxView = named("TenantSandboxView", TenantSandboxViewSchema);
export const ModelUsageTotals = named("ModelUsageTotals", ModelUsageTotalsSchema);
export const ModelBudgets = named("ModelBudgets", ModelBudgetsSchema);
export const PutModelBudgetsRequest = named("PutModelBudgetsRequest", PutModelBudgetsRequestSchema);
export const ToolPolicy = named("ToolPolicy", ToolPolicySchema);
export const PutToolPolicyRequest = named("PutToolPolicyRequest", PutToolPolicyRequestSchema);
export const PutModelInputsRequest = named("PutModelInputsRequest", PutModelInputsRequestSchema);
export const ModelInputsView = named("ModelInputsView", ModelInputsViewSchema);
export const PutTenantEnvironmentsRequest = named("PutTenantEnvironmentsRequest", PutTenantEnvironmentsRequestSchema);
export const ListProvidersResponse = named("ListProvidersResponse", ListProvidersResponseSchema);
export const HostModelView = named("HostModelView", HostModelViewSchema);
export const PutHostModelRequest = named("PutHostModelRequest", PutHostModelRequestSchema);
export const SelectHostModelRequest = named("SelectHostModelRequest", SelectHostModelRequestSchema);
export const PutAgentSecretRequest = named("PutAgentSecretRequest", PutAgentSecretRequestSchema);
export const AgentSecretView = named("AgentSecretView", AgentSecretViewSchema);
export const ListAgentSecretsResponse = named(
  "ListAgentSecretsResponse",
  ListAgentSecretsResponseSchema,
);
export const DeletedResponse = named("DeletedResponse", DeletedResponseSchema);
export const McpPreviewRequest = named("McpPreviewRequest", McpPreviewRequestSchema);
export const McpPreview = named("McpPreview", McpPreviewSchema);
export const CredentialCoverageRequest = named(
  "CredentialCoverageRequest",
  CredentialCoverageRequestSchema,
);
export const CredentialCoverage = named("CredentialCoverage", CredentialCoverageSchema);

export const Jwks = named("Jwks", JwksSchema);
export const SigningKeyList = named("SigningKeyList", SigningKeyListSchema);
export const SigningKeyView = named("SigningKeyView", SigningKeyViewSchema);
export const RotateSigningKeysRequest = named("RotateSigningKeysRequest", RotateSigningKeysRequestSchema);
export const RevokeSigningKeyRequest = named("RevokeSigningKeyRequest", RevokeSigningKeyRequestSchema);
export const SessionListItem = named("SessionListItem", SessionListItemSchema);
export const ModelCall = named("ModelCall", ModelCallSchema);
export const SessionPage = named("SessionPage", SessionPageSchema.extend({ sessions: z.array(SessionListItem) }));
export const SessionManifestView = named("SessionManifestView", SessionManifestViewSchema);
export const HistoryPage = named("HistoryPage", HistoryPageSchema.extend({ items: z.array(SessionEvent) }));
export const SessionUsageTotals = named("SessionUsageTotals", SessionUsageTotalsSchema);
export const ModelCallsPage = named("ModelCallsPage", ModelCallsPageSchema.extend({ calls: z.array(ModelCall) }));
export const ModelCallExportPage = named("ModelCallExportPage", ModelCallExportPageSchema.extend({ calls: z.array(ModelCall) }));
export const AgentPage = named(
  "AgentPage",
  AgentPageSchema.extend({ environments: z.array(AgentView) }),
);
export const ToolCall = named("ToolCall", ToolCallSchema);
export const ToolCallsPage = named("ToolCallsPage", ToolCallsPageSchema.extend({ calls: z.array(ToolCall) }));
export const TurnTrace = named("TurnTrace", TurnTraceSchema);
export const MeResponse = named("MeResponse", MeResponseSchema);
