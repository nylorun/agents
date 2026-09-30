---
"@nylorun/runtime": minor
---

**The Runtime serves HTTP through Hono.** The Host's request pipeline (Origin, Content-Type, `/health`, `/ready`, the Admin API and Tenant resolution) is now a Hono app served by `@hono/node-server`. It answers byte for byte as before. `hono`, `@hono/zod-openapi` and `zod` are now dependencies. Routes move to Hono group by group in later releases.

- **`TenantHandle.fetch(request, { incoming, outgoing })`** is how the Host reaches an open Tenant. `TenantHandle.handle(request, response, url)` is deprecated and optional, and will be removed once every Tenant route is on Hono. Code that implements `TenantHandle` must add `fetch`.
- **The process's globals are left alone.** An app that embeds the Runtime (`startEphemeralRuntime`) keeps its own `Request` and `Response`. The Runtime also answers correctly in a process where `@hono/node-server`'s `serve()` has already replaced them.
- **A request target that is not a path** (such as `OPTIONS *`) is `400 invalid_request` "Invalid request target".
