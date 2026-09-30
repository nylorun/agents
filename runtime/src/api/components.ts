/**
 * Named schemas of the OpenAPI document: each becomes `#/components/schemas/<id>`, referenced
 * wherever a route uses it. Named with Zod's own `.meta({ id })`, which works on the contracts'
 * schemas whenever they were created; made once per process, since ids are unique in Zod's
 * global registry.
 */
import type { z } from "zod";
import {
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
