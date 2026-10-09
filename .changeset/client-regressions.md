---
"@nylorun/admin": patch
"nylorun": patch
---

**Fixes for the one client layer.**

- `@nylorun/admin`: `createAdmin` reads the Project link only in its local-Host step. Explicit `url` and `key`, or `NYLORUN_RUNTIME_URL` with `NYLORUN_MANAGEMENT_KEY`, no longer fail on a `.nylorun/link.json` that cannot be read (EACCES for a root-owned file after `sudo npx nylorun start`, EISDIR); the local-Host step refuses such a link, naming it, as it refuses a broken one (when nothing else names the Host root).
- `@nylorun/admin`: a refusal without the Runtime's rejection body takes its code from the status: `invalid_request` (400), `credential_invalid` (401), `not_found` (404), `unsupported_media_type` (415), `internal_error` (5xx), else `request_rejected`; it was always `not_found`. Studio's own answers (`{ message }`, from its server and proxy, such as "This Studio session is invalid or has expired.") keep their message instead of one naming only the request and the status.
- `nylorun`: `start` refuses Project or Host root credentials in a newer format than it reads ("Upgrade nylorun"), as it refuses a newer link, instead of replacing them with new keys in its own format.
