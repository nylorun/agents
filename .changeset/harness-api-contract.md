---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/harness": patch
---

**The Harness API is a published contract (R4.5).** Everything a harness sends or reads now has a schema in `@nylorun/core/harness-api`, and the Runtime validates with those same schemas:
- the transport and the pod join (`HARNESS_API_PATH`, `HARNESS_API_HEADER`, `HOST_JOIN_PATH`, `HostJoinRequestSchema`, `HostJoinAnswerSchema`);
- the Model and Tool Gate bodies (`ModelCallBodySchema`, `ToolCallBodySchema`, `HttpCallBodySchema`, the MCP bodies, `GATE_ERROR_CODES`);
- the MCP snapshot (`McpSnapshotSchema`);
- transcript entries (`TranscriptEntrySchema`);
- the effect id rule (`effectIdOf`, `isEffectIdOf`).

The build also writes them as one JSON Schema document, `@nylorun/core/harness-api/schema.json`, for harnesses written in other languages.

Other changes:
- `TurnStart` gains an optional `trace` (W3C `traceparent`) for the turn's trace context. Nothing fills it yet.
- Core refuses a `hello` whose `api` is not `2`.
- **The fixture model answers at the Model Gate (R4.3).** With a Tenant's `fixtureModel` seeded, the gate answers model calls itself and meters each one, like any model: a `model_usage` row with provider `fixture` and cost 0, readable at `GET /v1/sessions/{id}/calls/model`. Our harness no longer answers it locally.
- The fixture model also answers conformance markers: `conformance:text`, `conformance:tool <name> <json>`, `conformance:budget` and `conformance:slow <seconds>`.
