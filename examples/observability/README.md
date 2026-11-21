# Observability example: the Runtime's telemetry in Grafana

The Runtime stores no telemetry. Each process keeps its metrics in memory and serves them
on `:9464/metrics`, and sends traces and metrics over OTLP when you give it an endpoint. This
example gives it one on your machine: Grafana's all-in-one OpenTelemetry backend, for development.
For production, put an OpenTelemetry Collector in front of your own backend
([`collector.yaml`](./collector.yaml)). The guide is
[Observability](../../docs/self-hosting/observability.md).

| File | What it is |
| --- | --- |
| [`compose.yaml`](./compose.yaml) | `grafana/otel-lgtm`: a Collector, Prometheus, Tempo, Loki and Grafana in one container. Development only |
| [`grafana-dashboard.json`](./grafana-dashboard.json) | The Runtime's golden signals: API requests by route and client, model calls, tokens, tool calls, egress, turns, queue waits, dropped telemetry |
| [`collector.yaml`](./collector.yaml) | A Collector for production: tail sampling that keeps errors and slow turns, then OTLP to your backend |

## Run it

```sh
docker compose -f examples/observability/compose.yaml up -d
OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4318 \
OTEL_METRICS_EXPORTER=prometheus,otlp \
npx nylorun start
```

`nylorun start` passes the `OTEL_*` variables to the Runtime's containers, which reach your machine
as `host.docker.internal`. Open Grafana at <http://localhost:3001>, then **Dashboards › New ›
Import** and upload `grafana-dashboard.json` (the container also has it at
`/otel-lgtm/nylorun-runtime.json`). Choose the Prometheus data source when asked. Traces are in
**Explore › Tempo**: one per turn, `invoke_agent` at the root, with its `chat` and `execute_tool`
spans, and the API request that started it.

Without any of this, Studio's **Tenant › Traffic** shows the same metrics live, since each process
started, and **Events › Trace** shows a turn's spans.

## What leaves

Spans carry ids, names, counts and status, never content, unless you set
`OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT=SPAN_ONLY`. Do that only where the backend may hold
what people and models wrote.
