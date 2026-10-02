---
"@nylorun/runtime": minor
---

**Remote MCP calls outlive the runtime that sent them, and never run twice (F4.1).** The loop sends each remote MCP call with its effect id as the `Idempotency-Key`. The gateway keeps a keyed call running after its caller goes away, and a restarted or new owner re-sends the journaled call and joins it, so the turn completes with one call to the server and nothing `uncertain`.

- The gateway records each keyed call before it reaches the server and stores the answer after. After a gateway restart, a call that was in flight answers `uncertain` and is never run again. Rows are deleted a day after they settle.
- A user cancel stops the call at the gateway (`POST /nylorun/v1/tool-calls/{key}/cancel`).
