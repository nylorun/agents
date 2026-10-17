---
"@nylorun/runtime": patch
---

`POST /v1/webhooks/{endpointId}` takes no credential and ignores one that is sent: a delivery with an `Authorization` header is no longer checked against the Tenant's keys, since its Standard Webhooks signature is its grant. The OpenAPI document says so: `security: []`, no `Nylorun-*` headers, and `webhook-id`, `webhook-timestamp` and `webhook-signature` required.
