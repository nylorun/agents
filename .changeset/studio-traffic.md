---
"@nylorun/studio": minor
"nylorun": minor
---

Studio's Tenant › Traffic (ADR-159): the runtime's and the gateway's own metrics, read live from their `/metrics` every 10 s, with no store: API requests by route and client, model calls with tokens, MCP tool calls, turns, queue waits, egress outcomes and dropped telemetry, as counts since each process started, the rate since the last read, and p50 and p95. Studio reads the sources in `NYLORUN_STUDIO_METRICS_URLS`, which `nylorun start` and the chart set; the chart lets Studio scrape both even with `metrics.from` set. `examples/observability` has Grafana's all-in-one OpenTelemetry backend, a dashboard of the golden signals and a Collector with tail sampling.
