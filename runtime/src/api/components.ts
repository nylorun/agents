/**
 * Named schemas of the OpenAPI document: each becomes `#/components/schemas/<id>`, referenced
 * wherever a route uses it. Named with Zod's own `.meta({ id })`, which works on the contracts'
 * schemas whenever they were created; made once per process, since ids are unique in Zod's
 * global registry.
 */
import type { z } from "zod";
import {
  TenantStatusSchema,
  ResetTenantRequestSchema,
  ResetTenantResponseSchema,
  SeedTenantConfigRequestSchema,
  SeedTenantConfigResponseSchema,
  HostModelCatalogSchema,
  TenantSandboxViewSchema,
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
  ActionClaimRequestSchema,
  ActionClaimResponseSchema,
  ActionHeartbeatRequestSchema,
  ActionHeartbeatResponseSchema,
  DeleteExecutorResponseSchema,
  ExecutorNotificationSchema,
  ListActionsResponseSchema,
  ListExecutorsResponseSchema,
  RegisterExecutorsRequestSchema,
  RegisterExecutorsResponseSchema,
  SandboxToolOutcomeSchema,
  SessionCommandSchema,
  AdminStatusSchema,
  AdminTenantListSchema,
  AdminTenantStatusSchema,
  CreateTenantRequestSchema,
  HostShutdownResponseSchema,
  ProtocolRejectedResponseSchema,
  RejectedResponseSchema,
  TenantEnvelopeSchema,
} from "@nylorun/core/contracts";

function named<T extends z.ZodType>(id: string, schema: T): T {
  return schema.meta({ id }) as T;
}

export const Rejected = named("Rejected", RejectedResponseSchema);
export const ProtocolRejected = named("ProtocolRejected", ProtocolRejectedResponseSchema);
export const TenantEnvelope = named("TenantEnvelope", TenantEnvelopeSchema);
export const CreateTenantRequest = named("CreateTenantRequest", CreateTenantRequestSchema);
export const AdminTenantList = named("AdminTenantList", AdminTenantListSchema);
export const AdminTenantStatus = named("AdminTenantStatus", AdminTenantStatusSchema);
export const AdminStatus = named("AdminStatus", AdminStatusSchema);
export const HostShutdownResponse = named("HostShutdownResponse", HostShutdownResponseSchema);

export const ExecutorNotification = named("ExecutorNotification", ExecutorNotificationSchema);
export const ListActionsResponse = named("ListActionsResponse", ListActionsResponseSchema);
export const ActionClaimRequest = named("ActionClaimRequest", ActionClaimRequestSchema);
export const ActionClaimResponse = named("ActionClaimResponse", ActionClaimResponseSchema);
export const ActionHeartbeatRequest = named("ActionHeartbeatRequest", ActionHeartbeatRequestSchema);
export const ActionHeartbeatResponse = named(
  "ActionHeartbeatResponse",
  ActionHeartbeatResponseSchema,
);
export const SandboxToolOutcome = named("SandboxToolOutcome", SandboxToolOutcomeSchema);
export const ListExecutorsResponse = named("ListExecutorsResponse", ListExecutorsResponseSchema);
export const RegisterExecutorsRequest = named(
  "RegisterExecutorsRequest",
  RegisterExecutorsRequestSchema,
);
export const RegisterExecutorsResponse = named(
  "RegisterExecutorsResponse",
  RegisterExecutorsResponseSchema,
);
export const DeleteExecutorResponse = named("DeleteExecutorResponse", DeleteExecutorResponseSchema);
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
export const SessionItemsResponse = named("SessionItemsResponse", SessionItemsResponseSchema);
export const LiveEvent = named("LiveEvent", LiveEventSchema);
export const StreamClosedFrame = named("StreamClosedFrame", StreamClosedFrameSchema);

export const TenantStatus = named("TenantStatus", TenantStatusSchema);
export const ResetTenantRequest = named("ResetTenantRequest", ResetTenantRequestSchema);
export const ResetTenantResponse = named("ResetTenantResponse", ResetTenantResponseSchema);
export const SeedTenantConfigRequest = named("SeedTenantConfigRequest", SeedTenantConfigRequestSchema);
export const SeedTenantConfigResponse = named("SeedTenantConfigResponse", SeedTenantConfigResponseSchema);
export const HostModelCatalog = named("HostModelCatalog", HostModelCatalogSchema);
export const TenantSandboxView = named("TenantSandboxView", TenantSandboxViewSchema);
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
