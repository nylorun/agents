---
"@nylorun/studio": patch
---

**Studio: one client for Tenant settings.** Model settings and the session model picker call the Runtime through the Management client (`models.get/catalog/providers/put/select`) instead of raw `fetch` with hand-written response types, and opening `/tenants/<id>/sessions/<session>` reads the session through the SDK. The raw `tenantRuntime` helper and the unused `breadcrumb` and `select` UI components are gone, and the embed-bearer (`v2`) and forwarded sign-in (`v3`) session formats share one sign-and-verify helper; their wire format is unchanged, so existing sessions stay valid.
