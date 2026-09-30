---
"@nylorun/runtime": minor
---

**Every Tenant route is a Hono route, and paths are strict.** The Tenant API's hand-written router is gone. Each route is declared once with who may call it (credentials, subject scopes, browser access), in `api/http/routes/`, `api/ag-ui/` and `api/a2a/`. That one declaration now decides what the router's own tables (`routeAccess`, `isBrowserRoute`) decided: a subject's scopes and which browser preflights are allowed. Routes answer as before.

A path or method that no route serves is now authenticated like any other request (an unknown credential is still the opaque `404`) and then answered `404 request_rejected` "Route not found". Before, the router matched loosely, and some of these requests reached a route or got another answer:

- **Extra path segments:** `POST /v1/sessions/:id/commands/…`, `GET /v1/sessions/:id/items/…` and `/events/…`, `GET /v1/executors/connect/…` and `POST /v1/actions/:id/claim/…` (and `/heartbeat/…`) no longer reach those routes.
- **`GET /v1/actions/:id`** is `404`, not `400 Invalid JSON`.
- **A trailing slash or an empty segment** (`/v1/sessions/`, `/v1//sessions`, `/v1/agents/`) is `404`. Before, it was served as the route without it.
- **An unknown path under a known resource:**
  - An unknown sub-route of a session is `404 Route not found`, even when the session is missing (before: "Session not found").
  - A subject calling an unknown path under `/v1/executors`, `/v1/actions`, `/v1/tokens` or `/v1/access` gets `404` (before: `403 scope_required`).
  - An executor calling any path or method no route serves gets `404` (before: `403 Application credential required`).
- **`HEAD`** is `404` for every caller.
- **Browser preflights** for paths no route serves (for example `/v1/sessions/:id/unknown`, `/v1/ag-ui/anything`), or for a method a route lacks, are refused (`403`) instead of allowed.

**`TenantHandle.handle` is removed**; the Host reaches a Tenant with `TenantHandle.fetch(request, { incoming, outgoing })`.
