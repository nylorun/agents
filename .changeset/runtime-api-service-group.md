---
"@nylorun/runtime": patch
---

**The Runtime API's reference lists the Service endpoints last.** The Runtime API's tag groups are now Agents, Sessions, Sandboxes, Artifacts and Service. Service holds what was the Runtime tag under Get started: `/health`, `/ready`, `/v1/me`, the JWKS and `/openapi/runtime.json`. Sandboxes and Artifacts are a group each. The document no longer lists the `/openapi.json` alias; the Runtime still serves it.
