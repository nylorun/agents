---
"@nylorun/runtime": minor
"@nylorun/core": minor
---

A computer's disk is measured (ADR-154 D1): before an idle suspend the Runtime runs `du -sk /workspace /skills` on a running computer (at most 20 s; a failure records nothing and holds nothing up) and records the size as `diskBytes` on `agent.suspended`, with a `computer suspended` host log line. A wake logs `computer ready` with `waitedMs`, and the sandboxes service logs each Substrate suspend (`substrate suspended`, with `ms` or the error).
