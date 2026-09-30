---
"@nylorun/core": minor
"@nylorun/runtime": patch
---

**Schemas for every Runtime answer.** `@nylorun/core/contracts` now has a Zod schema for each successful response of the Tenant and Admin APIs that lacked one, so clients can validate what they receive and the Runtime's OpenAPI document can be generated from them.

- **Agents:** `ListAgentsResponseSchema` (`AgentDefinitionViewSchema`), `ListPublicAgentsResponseSchema` (`PublicAgentSchema`) and `PutAgentResponseSchema`.
- **Sessions:** `ListSessionsResponseSchema` (`SessionSummarySchema`, `SESSION_STATUSES`) and `SessionViewSchema`.
- **Executors and actions:** `ListActionsResponseSchema`, `ActionHeartbeatResponseSchema`, `DeleteExecutorResponseSchema` and `SandboxToolOutcomeSchema`.
- **Tenant settings:** `ResetTenantResponseSchema`, `HostModelCatalogSchema`, `ListProvidersResponseSchema` (`HostModelProviderInfoSchema`), and `TenantSandboxViewSchema` with `EffectiveSandboxConfigSchema` (the configuration with defaults applied, sizes in MiB).
- **Vaults:** `VaultInfoSchema`, `CredentialInfoSchema`, `ListVaultsResponseSchema`, `ListCredentialsResponseSchema` and `DeletedResponseSchema`. `VaultInfo`, `CredentialInfo` and `HostModelProviderInfo` are now inferred from their schemas; their fields are no longer `readonly`.
- **Access:** `AccessPolicyResponseSchema` and `ListPublishableKeysResponseSchema`.
- **Admin:** `AdminTenantListSchema` and `HostShutdownResponseSchema`.
- **Streams:** `StreamClosedFrameSchema` (the `nylorun.closed` frame) and `AgUiRunErrorCodeSchema` (codes of an AG-UI `RUN_ERROR`, which add `session_busy` and `runtime_error`).

`ERROR_CODES` gains `request_rejected`, `invalid_request`, `subject_required` and `internal_error`, codes the Runtime already sends. `RejectedResponseSchema` now accepts every rejection the Runtime makes. An exhaustive `switch` over `ErrorCode` needs the new cases.
