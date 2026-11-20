---
"@nylorun/core": minor
"@nylorun/agents": minor
"@nylorun/studio": minor
---

The event log is for developers, telemetry for operators (ADR-159). Each event type in the catalog names its layer: `agent`, what the agent saw and did, or `runtime`, what the Runtime did to the session. `eventLayer(type)` and `EVENT_LAYERS` are exported from `@nylorun/core/contracts` and `@nylorun/agents`, with the `TurnTrace` and `OtlpSpan` types; the envelope does not change. Studio's Events tab opens on the agent's events, with Runtime and All beside them and each row's writer, and gains a Trace view: a turn's spans as a waterfall, from the per-turn trace route, with Open trace on an event and Open event on a span. Studio's proxy allows a session's tool calls and a turn's trace. `guides/OBSERVABILITY.md` is the guide for both readers.
