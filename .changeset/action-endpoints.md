---
"@nylorun/core": minor
---

**Action endpoints: contracts (groundwork, not served yet).** `@nylorun/core` adds the wire shapes for Actions the Runtime will deliver over HTTP to a URL the application registers, in place of executors. No Runtime serves them yet, and the Host does not advertise a feature for them.

- **Contracts.** `EndpointRegistrationSchema`, `PutEndpointsRequestSchema`, `EndpointSchema` with `EndpointHealthSchema`, `ListEndpointsResponseSchema`, `ActionDeliverySchema` (an Action or a ping), `EndpointPingResponseSchema`, `DeliveryHeartbeatResponseSchema`, and the `action.delivered` and `action.delivery_failed` payload schemas. `Action.status` gains `delivering`, and Actions gain an optional `deadlineAt`.
- **Constants.** `DELIVERY_TOKEN_TYPE` (`nylorun-delivery+jwt`), `DELIVERY_TOKEN_MAX_TTL_SECONDS` (900, the subject-token maximum), `ENDPOINT_TIMEOUT_DEFAULT_MS` (60 000), `ENDPOINT_TIMEOUT_MAX_MS` (840 000), `ENDPOINT_MAX_CONCURRENT_DEFAULT` (16), and in `@nylorun/core/compatibility` the headers `SIGNATURE_HEADER` (`Nylorun-Signature`) and `OUTCOME_HEADER` (`Nylorun-Outcome`).
