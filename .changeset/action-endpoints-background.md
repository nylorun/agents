---
"@nylorun/runtime": minor
---

**Action endpoints: background outcomes.** An endpoint can answer a delivery with `202`, keep it alive, use the session's sandbox, and post the outcome later, all with the delivery token.

- **`POST /v1/actions/:id/heartbeat` with a delivery token** extends the delivery by a lease (`leaseMs`) and returns a fresh token (`{ token, deadlineAt }`). It answers `409` once the delivery was cancelled, lost or sent again, which tells the endpoint to stop. Executors keep their claim heartbeat on the same route.
- **`POST /v1/actions/:id/result` (new, delivery token only)** records the outcome. The same result again returns the first receipt; a different one is `409`.
- **`POST /v1/actions/:id/sandbox/:tool` with a delivery token** runs the session's sandbox tools for that Action while it is being delivered. The body is the tool's input, with no claim fields.
- **Deadline.** A `202` delivery that stops heartbeating is lost at its deadline: a tool becomes `uncertain`; a hook, `fn` or `verify` is delivered again.
- The heartbeat and sandbox routes are no longer marked deprecated in the OpenAPI document. Their executor use is.
