---
"@nylorun/runtime": minor
"@nylorun/agents": patch
"@nylorun/admin": patch
"nylorun": minor
"@nylorun/studio": patch
---

Telemetry for operators (ADR-159). Each runtime and gateway process makes OpenTelemetry metrics and spans with the SDK, configured by the standard `OTEL_*` variables, and stores none: Prometheus metrics on `/metrics` (port 9464, on by default; `OTEL_METRICS_EXPORTER`, `OTEL_EXPORTER_PROMETHEUS_HOST` and `_PORT`), and with an OTLP endpoint, metrics and live spans over OTLP, sampled by `OTEL_TRACES_SAMPLER` and `_ARG`. The metrics are `http.server.request.duration` (by declared route and `nylorun.client`), `gen_ai.client.inference.duration`, `.time_to_first_chunk` and `.usage.input_tokens`/`.output_tokens`, `mcp.client.operation.duration`, `http.client.request.duration`, `gen_ai.invoke_agent.duration`, `nylorun.queue.wait`, `nylorun.egress.connections`, `nylorun.egress.bytes` and `nylorun.telemetry.dropped`, which counts what a failed export dropped. An API request makes a server span that becomes the parent of the turn a command starts; a remote MCP tool call makes a client span; log lines written meanwhile carry `trace_id` and `span_id`. `service.name` is `nylorun-runtime` or `nylorun-gateway` (the turn traces' default was `nylorun`).

One content switch: `OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT` (`NO_CONTENT` by default, `SPAN_ONLY`; `EVENT_ONLY` and `SPAN_AND_EVENT` warn and act as `NO_CONTENT` and `SPAN_ONLY`). `NYLORUN_TRACE_CONTENT` and `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` still work for this release, with a deprecation warning. Content is recorded as structured OTLP values, each text cut at `traceContentBytes`, and `execute_tool` spans gain `gen_ai.tool.call.arguments`. The GenAI conventions move to `semantic-conventions-genai@622b2b6`.

`@nylorun/agents` and `@nylorun/admin` send `Nylorun-Client: sdk`, nylorun `cli` and Studio `studio` on what it forwards. nylorun's local stack passes the `OTEL_*` variables, `OTEL_METRICS_EXPORTER`, `OTEL_TRACES_SAMPLER`, `_ARG` and `OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT` included, to the runtime and the gateway. The Helm chart names port 9464 `metrics` on the runtime and gateway containers and their internal Services, with `metrics.from` for who may scrape it.
