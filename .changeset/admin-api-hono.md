---
"@nylorun/runtime": patch
---

**The Admin API is declared as Hono routes.** Each `/v1/admin/**` route is declared once, for serving and for the Runtime's OpenAPI document (`host/admin-api.ts`). Answers are unchanged, apart from strict paths:

- A trailing slash (`/v1/admin/tenants/`) or an empty segment (`/v1//admin/tenants`) no longer reaches a route. With the admin key it is `404 not_found` "Route not found"; before, it was served as the route without the slash.
