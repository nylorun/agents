---
"@nylorun/runtime": minor
---

**Model calls outlive the runtime that sent them.** A call to the gates service with an `Idempotency-Key` (the loop always sends its effect id) now runs under the gate's own control: if its caller disconnects, the call finishes and its outcome is kept for 30 minutes, and a re-send with the same key and request joins it or gets that outcome instead of calling the provider again. A different request under the same key answers `409 gate_conflict`.

- `POST /nylorun/v1/model-calls/{key}/cancel` stops a keyed call. The loop sends it when a user cancels the turn, so cancel still stops the provider request.
- Outcomes live in the gateway's memory: a gateway restart forgets them.
