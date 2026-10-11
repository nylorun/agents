---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/harness": minor
"@nylorun/agents": minor
---

**Tool calls are delivered at least once, and every one is on the record (R5 step 1).** A gateway restart used to park the sessions it interrupted as `uncertain` until someone cancelled them, a harness could call tools with no record, and nothing listed a session's tool calls. Now every tool call ends in the log with its outcome, a crash sends it again with the same key, and the gateway runs only calls the effect journal recorded.

- **Every outcome in the log.** Each tool call ends in one `tool.completed` with `status` (`completed`: the tool answered; `failed`: the Runtime ended it, `tool.disabled`, `tool.unavailable` or `tool.interrupted`; `cancelled`), `kind` (`mcp`, `http`, `sandbox`, `platform`), `server`, `attempts` and `durationMs`. Refused and cancelled calls are in the log for the first time.
- **`GET /v1/sessions/{id}/calls/tool`** pages a session's tool calls from the effect journal, in the order they were first sent: tool, input, status, sends, error and timing. Same credentials and paging as `/calls/model`; `@nylorun/agents` adds `session.toolCalls()`. Host feature `tool-calls`.
- **At least once, with the same key.** An MCP or HTTP tool call that a crash, a shutdown or a lost gateway hop interrupted is sent again with its effect id as the key, up to 3 sends; then it fails to the model as `tool.interrupted` ("may have run") and the session continues. A gateway that restarts mid call runs the call again under its key instead of answering `uncertain`. HTTP tools get the key as `Idempotency-Key`, as before; MCP servers now get it in `_meta["nylorun/idempotency-key"]` on `tools/call`. A tool that honors the key acts once; `attempts` above 1 marks where one may have acted twice.
- **Sandbox commands are never run twice.** A sandbox or core-served call a crash interrupted has no key to dedupe on, so it fails to the model as `tool.interrupted` at once, and the model decides whether to run it again.
- **No tool call parks a session.** The `uncertain` state for tool calls, its cancel-only exit and R2b's read-only/idempotent `mcp.lost` exception are gone: a lost MCP answer is `mcp.lost` to the model for every tool. Model calls keep their own rules.
- **The gateway runs only journaled calls.** Under a run token, `/nylorun/v1/tool-calls` and `/nylorun/v1/http-calls` need the call's effect id as `Idempotency-Key` (`400 key_required`), and the effect journal must hold it running, for the run's turn, the same tool and the same input (`409 effect_not_journaled`). A harness that skips the journal gets nothing run.
- `@nylorun/harness`: `HarnessExecutors.resends(effect, error, run)` says a gate hop lost a call's answer; the harness then asks core again with the same intent and sends the call again.
- **Approval** stays in the manifest and our harness still asks for it. Only the Runtime's own harness asks: one built from the Harness API can skip it until tool policy moves to the gateway (R5 step 2).
