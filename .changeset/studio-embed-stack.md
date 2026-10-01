---
"nylorun": minor
"@nylorun/admin": minor
"@nylorun/studio": minor
---

**Embedding Studio in a desktop app.** Studio can be shown inside a desktop app such as Babai Desktop, in an iframe loaded from its URL and signed in by `postMessage` with a token limited to one Tenant.

- **`nylorun`.** The local stack lets Babai's origins frame Studio: `NYLORUN_STUDIO_FRAME_ANCESTORS` in `stack/.env` defaults to `nylorun://localhost http://nylorun.localhost` and is passed to the Studio container. `nylorun start --studio-embed-origin <origin>` (repeatable) adds an exact origin, such as a desktop app's dev server, and keeps it across starts until `--studio-embed-origin-reset`. Wildcards are refused. `nylorun status` lists the origins under `Embeds`, and `status --json` as `studio.embedOrigins`.
- **`@nylorun/admin`.** `mintStudioLoginToken({ studioUrl, adminKey, tenant?, subject? })` mints a single-use Studio login token from an app's backend. With `tenant`, the session it leads to reaches only that Tenant.
- **Studio.** `POST /_studio/sessions` exchanges such a token for a one-hour bearer session kept in the frame's memory; dashboard pages send `frame-ancestors` from the allowlist instead of `X-Frame-Options: DENY`; `?embed=1` hides Studio's branding, follows the app's theme and routes, and reports its own; `/tenants/:tenant/sessions/:session` opens a session by id. The cookie login of `nylorun studio` is unchanged.

  The dashboard routes `/tenants/:tenant`, `/tenants/:tenant/agents/:agent`, `/tenants/:tenant/agents/:agent/sessions/:session`, `/tenants/:tenant/sessions/:session`, `/tenants/:tenant/vault` and `/tenants/:tenant/settings` are now a public contract for embedders: removing or changing one is a breaking change.
