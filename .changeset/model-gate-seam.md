---
"@nylorun/runtime": minor
---

**Model calls go through a Model Gate.** Every vault-backed model call of the loop now goes through one `ModelGate` (`runtime/src/gates/`), the seam the gates service will serve over HTTP. For now the gate runs in the same process, so calls behave exactly as before: the same provider adapter, retries, idle watchdog, failure classification and redaction.

- **Breaking:** the `gateway` model kind is removed from `TenantConfig.model` and `StartEphemeralRuntimeOptions.model`. Nothing set it, and it read the Tenant's model credential inside the loop. The exported `gatewayModel` provider is unchanged.
