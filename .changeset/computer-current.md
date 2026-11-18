---
"@nylorun/core": minor
"@nylorun/runtime": patch
---

A harness reaches a computer's new volume after a restore (ADR-149): a computer restored through `POST /v1/agents/{id}/restore`, reset, or given a new volume by its lifecycle gets a new sandbox name (`…-g0` → `…-g1`), but a harness that had opened it kept sending its sessions' `bash`, `read` and `write` to the last computer until the ticket expired, and a gateway or router that still served it ran them on the old volume. Before each request to a computer the harness now asks core where it is (`computer.current`, Harness API 5.7, `harness-api/v5.7.json`: a store read that never wakes it) and opens it again with `computer.open` when the URL moved. Core's own uses checked this already. A harness on a core older than 5.7 keeps its access until the ticket is renewed, as before.
