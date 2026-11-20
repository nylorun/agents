---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/admin": minor
"@nylorun/studio": minor
---

A Tenant stream with an audit read (ADR-159, Host feature `tenant-audit`). Keys put and deleted (`key.created`, `key.revoked`), signing keys rotated and revoked (`signing_key.rotated`, `signing_key.revoked`), the tool policy and every other setting changed (`policy.changed` with the rule count, `settings.changed` with the setting's key), vault credentials written, replaced, deleted and used (`credential.created`, `.rotated`, `.deleted`, `.used`, beside the `vault_audit` rows, which are still written) and Studio sign-ins (`studio.signed_in`) are recorded in `nylorun_streams.tenant_events` (migration `0050_tenant_events`), each in the transaction of the change it records, with who acted (`principal`, from the request's credential) and what wrote it (`source`), and never a secret value: every payload is strict. The stream is not relayed to S2 and a reset keeps it. `TENANT_EVENT_TYPES`, `TENANT_EVENT_PAYLOADS`, `TenantEventSchema` and `TenantAuditPageSchema` are in `@nylorun/core/contracts`.

The Management API reads it newest first with `GET /v1/tenant/audit?since&until&types&cursor&limit`, a management key only; `POST /v1/tenant/audit/studio-sign-in` takes only Studio's key. `@nylorun/admin` adds `tenant.audit({ since, until, types, cursor, limit })` and exports the Tenant event types. Studio records each sign-in (`token`, `forwarded`, and `loopback` at most hourly) in the background, so a failure never blocks one, and adds a Tenant › Audit tab: time, type, who and a one-line summary, with a type filter and Load more. Its proxy allows the read and nothing else under the audit. `guides/OBSERVABILITY.md` has an Audit part for operators.
