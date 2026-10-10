/**
 * Named schemas of the OpenAPI document: each becomes `#/components/schemas/<id>`, referenced
 * wherever a route uses it. Named with Zod's own `.meta({ id })`, which works on the contracts'
 * schemas whenever they were created; made once per process, since ids are unique in Zod's
 * global registry.
 */
import { z } from "zod";
import {
  SessionListItemSchema,
  ModelCallSchema,
  SessionPageSchema,
  SessionManifestViewSchema,
  HistoryPageSchema,
  SessionUsageTotalsSchema,
  ModelCallsPageSchema,
  ModelCallExportPageSchema,
  SandboxPageSchema,
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
  PutTenantSandboxRequestSchema,
  ListProvidersResponseSchema,
  HostModelViewSchema,
  PutHostModelRequestSchema,
  SelectHostModelRequestSchema,
  CreateVaultRequestSchema,
  VaultInfoSchema,
  ListVaultsResponseSchema,
  CreateCredentialRequestSchema,
  CredentialInfoSchema,
  ListCredentialsResponseSchema,
  RotateCredentialRequestSchema,
  McpPreviewRequestSchema,
  McpPreviewSchema,
  CredentialCoverageRequestSchema,
  CredentialCoverageSchema,
  DeletedResponseSchema,
  ListAgentsResponseSchema,
  ListPublicAgentsResponseSchema,
  ListSessionsResponseSchema,
  LiveEventSchema,
  PutAgentRequestSchema,
  PutAgentResponseSchema,
  PutSessionRequestSchema,
  SessionItemsResponseSchema,
  SessionViewSchema,
  StreamClosedFrameSchema,
  AcceptedResponseSchema,
  SandboxToolOutcomeSchema,
  PutSandboxRequestSchema,
  SandboxViewSchema,
  ListSandboxesResponseSchema,
  DeleteSandboxResponseSchema,
  ListSandboxEventsResponseSchema,
  ArtifactViewSchema,
  ArtifactVersionViewSchema,
  ListArtifactsResponseSchema,
  UploadArtifactResponseSchema,
  DefinitionFileViewSchema,
  DeleteArtifactResponseSchema,
  CreateArtifactLinkRequestSchema,
  ArtifactLinkSchema,
  PutTenantArtifactsRequestSchema,
  TenantArtifactsViewSchema,
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
export const PutSandboxRequest = named("PutSandboxRequest", PutSandboxRequestSchema);
export const SandboxView = named("SandboxView", SandboxViewSchema);
export const ListSandboxesResponse = named("ListSandboxesResponse", ListSandboxesResponseSchema);
export const DeleteSandboxResponse = named("DeleteSandboxResponse", DeleteSandboxResponseSchema);
export const ListSandboxEventsResponse = named(
  "ListSandboxEventsResponse",
  ListSandboxEventsResponseSchema,
);
export const ArtifactVersionView = named("ArtifactVersionView", ArtifactVersionViewSchema);
export const ArtifactView = named("ArtifactView", ArtifactViewSchema);
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
export const ArtifactTree = named("ArtifactTree", ArtifactTreeSchema);
export const ArtifactDiff = named("ArtifactDiff", ArtifactDiffSchema);
export const SessionCommand = named("SessionCommand", SessionCommandSchema);
export const AcceptedResponse = named("AcceptedResponse", AcceptedResponseSchema);

export const ListAgentsResponse = named("ListAgentsResponse", ListAgentsResponseSchema);
export const ListPublicAgentsResponse = named(
  "ListPublicAgentsResponse",
  ListPublicAgentsResponseSchema,
);
export const PutAgentRequest = named("PutAgentRequest", PutAgentRequestSchema);
export const PutAgentResponse = named("PutAgentResponse", PutAgentResponseSchema);
export const ListSessionsResponse = named("ListSessionsResponse", ListSessionsResponseSchema);
export const PutSessionRequest = named("PutSessionRequest", PutSessionRequestSchema);
export const SessionView = named("SessionView", SessionViewSchema);
export const LiveEvent = named("LiveEvent", LiveEventSchema);

/** `sandbox.state` → `SandboxStateEvent`. */
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
export const PutTenantSandboxRequest = named("PutTenantSandboxRequest", PutTenantSandboxRequestSchema);
export const ListProvidersResponse = named("ListProvidersResponse", ListProvidersResponseSchema);
export const HostModelView = named("HostModelView", HostModelViewSchema);
export const PutHostModelRequest = named("PutHostModelRequest", PutHostModelRequestSchema);
export const SelectHostModelRequest = named("SelectHostModelRequest", SelectHostModelRequestSchema);
export const CreateVaultRequest = named("CreateVaultRequest", CreateVaultRequestSchema);
export const VaultInfo = named("VaultInfo", VaultInfoSchema);
export const ListVaultsResponse = named("ListVaultsResponse", ListVaultsResponseSchema);
export const CreateCredentialRequest = named("CreateCredentialRequest", CreateCredentialRequestSchema);
export const CredentialInfo = named("CredentialInfo", CredentialInfoSchema);
export const ListCredentialsResponse = named("ListCredentialsResponse", ListCredentialsResponseSchema);
export const RotateCredentialRequest = named("RotateCredentialRequest", RotateCredentialRequestSchema);
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
export const SandboxPage = named("SandboxPage", SandboxPageSchema.extend({ sandboxes: z.array(SandboxView) }));
export const MeResponse = named("MeResponse", MeResponseSchema);
