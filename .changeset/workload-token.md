---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/studio": patch
---

The workload token (#496). A Runtime given `NYLORUN_WORKLOAD_TOKEN_FILE`, a token a platform rotates through a file, reads it at each use and keeps nothing, so a rotation applies to the next request with no restart; a missing, unreadable or empty file fails the request, naming the variable, and nothing is sent without it. A custom model with `auth: { type: "workload" }` sends it as the endpoint's bearer. A new credential type, `workload` (`{ url, via, identity?, toolPrefix? }`, no value), sends `Authorization: Bearer <token>` to its `via` only, and only when `via`'s origin is in `NYLORUN_WORKLOAD_TOKEN_ORIGINS`, since an Agent's writer chooses `via`. A gateway's `401` is `credential_rejected` with `gateway`, its origin. The token stays in the process that makes the call: never in a sandbox, the model, an event or a log. Studio shows the credential and the model's auth.
