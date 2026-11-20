# Observability

The Runtime has two systems for two readers (ADR-159). The **event log** is the durable history
of every session and Agent: what the agent did, and what the Runtime did to it. It is exact,
never sampled, and the Runtime resumes and audits from it. It is for **developers** building and
running agents. **Telemetry** is OpenTelemetry: metrics, spans and log lines about how the Runtime
and its parts ran. It is best effort, the Runtime stores none of it, and it goes to whatever tools
a team runs. It is for **operators** running the Runtime.

| | Event log | Telemetry |
| --- | --- | --- |
| For | Developers | Operators |
| Answers | What happened, and who is accountable for it? | How fast, how often, how healthy? |
| Read through | The Runtime API, the SDK, Studio | `/metrics`, your OpenTelemetry collector; a turn's trace from the Runtime API |
| If writing fails | The change fails with it | Dropped and counted; nothing waits |
| Sampled | Never | Spans may be; metrics never |

Some facts are in both, such as a model call's time and tokens. Each question reads one source:
cost, audit and Studio's Usage read the log; latency and rates read telemetry. When they differ,
the log is right. Vocabulary: [runtime/server/src/CONTEXT.md](../runtime/server/src/CONTEXT.md).

This guide changes in the same pull request as anything a developer or an operator can observe.

## For developers: the event log

### A session's events

Every session has one ordered stream of events. Read its history and follow it live:

```ts
const session = client.session(sessionId);
const page = await session.history();
for (const item of page.items) console.log(item.type, item.time);

for await (const event of session.observe({ cursor: page.cursor ?? undefined })) {
  console.log(event.type, event.payload);
}
```

`GET /v1/sessions/{id}/items` and `GET /v1/sessions/{id}/events` (SSE) are the routes.

### The agent's record and the Runtime's

Each event type has a **layer** in the catalog, so the envelope does not carry it:

- **`agent`**: what the agent saw and did. Inputs (`command.*`), model calls
  (`message.assistant`, `model.failed`), tool calls (`tool.completed`), the harness's own work
  (`context.compacted`, `delegation.*`, `plan.updated`, `memory.updated`), turns (`turn.*`) and
  a workflow's steps (`node.*`, `loop.*`).
- **`runtime`**: what the Runtime did to the session. The queue (`message.queued`, `queue.*`),
  wakes (`wake.*`), settings (`session.model`), the computer (`environment.*`), tools found
  (`mcp.discovered`), artifacts (`artifact.*`), diagnostics (`engine.diagnostic`).

```ts
import { eventLayer } from "@nylorun/agents";

const agentOnly = page.items.filter((item) => eventLayer(item.type) === "agent");
```

`eventLayer` returns `undefined` for a type your package version does not know. Every event on
an Agent's own stream is the Runtime's.

### Who wrote an event

Every event names its writer (`source.kind`: `loop` for the harness, `api` for the Runtime's
core) and how sure the record is (`evidence`): `observed` or `measured` when the Runtime saw it
happen, `claimed` when a harness reported it. A harness you did not write is believed only as
far as its claims.

### Cost and calls

```ts
const totals = await session.usage();                 // tokens and cost, by model
const calls = await session.modelCalls({ limit: 50 }); // each model call, as the gate metered it
const tools = await session.toolCalls({ limit: 50 });  // each tool call
```

These are records: the gate measured them, they are never sampled, and they are what a bill
counts.

### The Agent's stream

What happens to an Agent across its sessions is on its own stream: lifecycle, triggers and their
runs, memory changes, and every network connection its computer opens (`agent.egress`: the host,
`allowed` or `refused` with the reason, bytes each way, and the turns that were running):

```ts
const egress = await client.agents.events(agentId, { types: ["agent.egress"], since: "2026-11-20T00:00:00Z" });
for (const event of egress) console.log(event.type, event.payload);
```

### A turn as a trace

`session.trace(turnId)` (Host feature `traces`) returns a turn's spans as OTLP/HTTP JSON, built
from the log on each read, so it lasts as long as the session:

- `invoke_agent <agent>`: the turn.
- `chat <model>`: each model call, with the gate's own start, end, usage and cost.
- `execute_tool <tool>`: each tool call.
- Markers for each pause and answer.

Each span carries `nylorun.event.cursor`, the log event it came from. Network egress is not in a
turn's trace: read it from the Agent's stream.

Send a W3C `traceparent` with a command, an AG-UI run or an A2A message and the turn joins your
trace: its root span becomes a child of yours. The turn passes its context on to HTTP tools and
MCP servers (`traceparent`) and to sandbox commands (`TRACEPARENT`).

### In Studio

- **Events › Log** opens on the **Agent** view, with **Runtime** and **All** beside it. Each row
  shows its writer.
- **Events › Trace** shows a turn's spans as a waterfall: the turn, each model call with its
  model and tokens, each tool call. Pick a turn; select a span to see its attributes, and
  **Open event** to find the log event it came from. An event's details offer **Open trace**.
- **Usage** shows the session's cost and context from its model calls.
- An Agent's **Activity** shows its stream, egress decisions included.

## For operators: telemetry and health

The Runtime makes its telemetry with the OpenTelemetry SDK, configured by the standard `OTEL_*`
variables, and keeps none of it: metrics live in each process's memory, served on `/metrics` and
pushed over OTLP; spans go over OTLP only. Each process names itself: `nylorun-runtime` for the
runtime (core and loop), `nylorun-gateway` for the gateway (the Model and Tool Gates, keys and
egress-gate).

### Health

| Probe | Answers |
| --- | --- |
| `GET /health` on the Runtime (port 4000) and the gateway (4100) | The process is up, with its version and protocol |
| `GET /ready` | The Runtime can serve: its listener, Tenant, Postgres and Restate |
| `GET /v1/tenant` (Management API) | The Tenant's checks, counts, sandboxes, harness and streams |
| `nylorun status` | The local stack's services, Studio's URL |

### Metrics

Every runtime and gateway process serves its metrics in Prometheus format on `/metrics`, port
`9464`, from the moment it starts. On the local stack that port is on the Compose network only
(`http://runtime:9464/metrics`, `http://gateway:9464/metrics`); the
[Helm chart](../charts/nylorun-runtime/README.md#telemetry) names it `metrics` on the
`<name>-runtime-internal` and `<name>-gateway` Services. Set an OTLP endpoint and the same metrics
are pushed there every minute too.

| Metric | Type, unit | Attributes | Made by |
| --- | --- | --- | --- |
| `http.server.request.duration` | histogram, s | `http.request.method`, `http.route`, `http.response.status_code`, `nylorun.client`, `error.type` (a 5xx) | the runtime, for every API request |
| `gen_ai.client.inference.duration` | histogram, s | `gen_ai.operation.name` (`chat`), `gen_ai.provider.name`, `gen_ai.request.model`, `error.type` | the gateway (or the runtime's in-process gate), for every model call |
| `gen_ai.client.inference.time_to_first_chunk` | histogram, s | as above | the same, when the provider streamed |
| `gen_ai.client.inference.usage.input_tokens`, `.output_tokens` | counter, `{token}` | as above | the same, for an answered call |
| `mcp.client.operation.duration` | histogram, s | `mcp.method.name` (`initialize`, `tools/list`, `tools/call`), `gen_ai.tool.name` (a call), `error.type` | the gateway, for every request to a remote MCP server |
| `http.client.request.duration` | histogram, s | `http.request.method`, `http.response.status_code`, `error.type` | the gateway, for every HTTP tool request |
| `gen_ai.invoke_agent.duration` | histogram, s | `gen_ai.operation.name` (`invoke_agent`), `gen_ai.agent.name` (the manifest's name), `error.type` (`cancelled`, or the failure's code) | the runtime, as each turn ends; waits for a person included |
| `nylorun.queue.wait` | histogram, s | `nylorun.queue.outcome` (`taken`, `failed`, `cancelled`) | the runtime, as each queued message leaves the queue |
| `nylorun.egress.connections` | counter, `{connection}` | `nylorun.egress.outcome` (`allowed`, `refused`), `nylorun.egress.reason` (a refusal's) | egress-gate, once per sandbox connection |
| `nylorun.egress.bytes` | counter, By | `network.io.direction` (`transmit` from the sandbox, `receive` to it) | egress-gate, for an allowed tunnel as it closes |
| `nylorun.telemetry.dropped` | counter, `{item}` | `signal` (`metrics`, `traces`), `exporter` (`otlp`, or `projector` for turn traces) | every process, for spans or points an export failed to deliver |

- **Names on `/metrics`.** Prometheus replaces dots with underscores and adds `_total` to
  counters, with no unit suffix: `http_server_request_duration_bucket`,
  `gen_ai_client_inference_usage_input_tokens_total`, `nylorun_egress_connections_total`. Each
  point carries `otel_scope_name="@nylorun/runtime"`; the process's resource
  (`service_name`, `service_version`) is on `target_info`.
- **Bounded labels.** Every attribute has a small fixed set of values. `http.route` is the
  route's pattern (`/v1/sessions/{sessionId}/commands`), and `other` for a path that names no
  route. Metrics never carry a session, turn, request or Tenant id, a host name, a URL or a person.
- **`nylorun.client`** says who sent a request: `studio`, `sdk` (`@nylorun/agents` and
  `@nylorun/admin`), `cli` (`nylorun`), `a2a` and `ag-ui` (by route), else `other`. Clients send it
  as the `Nylorun-Client` header; Studio sets `studio` on everything it forwards. A browser app
  that calls the Runtime may send it too: allow the header in your proxy's CORS.
- **Durations** use the buckets the semantic conventions advise; the turn and queue histograms
  reach two hours.

### The golden signals

| Part | Rate | Errors | Duration | Saturation |
| --- | --- | --- | --- | --- |
| Runtime API | `http.server.request.duration` count by `http.route`, `nylorun.client` | its points with `error.type` (5xx) | its histogram | `nylorun.queue.wait` |
| Turns | `gen_ai.invoke_agent.duration` count | its points with `error.type` | its histogram | `nylorun.queue.wait` by outcome |
| Model calls | `gen_ai.client.inference.duration` count by model | `error.type` (`rate_limited`, `overloaded`, `timeout`, …) | its histogram, `time_to_first_chunk` | input and output tokens |
| MCP servers and HTTP tools | `mcp.client.operation.duration`, `http.client.request.duration` counts | `error.type` | their histograms | |
| Egress | `nylorun.egress.connections` | `outcome="refused"` by `reason` | | `nylorun.egress.bytes` |
| Telemetry itself | | `nylorun.telemetry.dropped` | | |

### Spans

Set an OTLP endpoint and the Runtime exports spans; without one it makes none, and costs nothing.

- **Live spans** from each process: an HTTP server span `{method} {http.route}` for every API
  request (with `nylorun.client`), and a client span `tools/call {tool}` for each remote MCP tool
  call, under the call's own trace context. A request's span is the parent of the turn it starts:
  send a `traceparent` with a command and your span, the request's and the turn's are one trace.
- **Turn traces** from the log: `invoke_agent`, `chat` and `execute_tool`, one per turn, the same
  as `session.trace(turnId)` reads. The variables, what leaves and how a collector that is down
  is handled are in [DEPLOYMENT.md, Traces](DEPLOYMENT.md#traces).
- **Egress has no span**: a connection belongs to the Environment, not a turn. Count it, or read
  its record from the Agent's stream.
- **Sampling.** `OTEL_TRACES_SAMPLER` decides which live spans are kept: `parentbased_always_on`
  (the default: kept unless the caller's `traceparent` says not sampled), `always_on`,
  `always_off`, `traceidratio` or `parentbased_traceidratio` with `OTEL_TRACES_SAMPLER_ARG` (a ratio
  from `0` to `1`). Metrics are never sampled. Turn traces are made from the log, all of them;
  sample those in your collector (tail sampling).

A harness must not instrument its own model calls: the Runtime already makes their spans, and a
second instrumentation counts every call twice. Spans for work the Runtime cannot see, such as a
retrieval step inside the harness, are welcome.

### Logs

Each Runtime service writes JSON lines to stdout: `level`, `message`, `time`, and fields. The
Runtime logs one `request` line per API request (method, redacted path, status, duration); the
gateway logs `model_call`, `model_retry`, `mcp_request` and `http_tool_call` per operation, and
the egress proxy `egress_refused`. On the local stack, `nylorun local logs <service>` reads them.

With span export on, a line written while a request runs carries `trace_id` and `span_id`: the
same ids as the request's span, so a log line, a span and the turn's events (whose
`command.message` holds the `traceparent`) join on one trace id.

At start each process logs `telemetry_config` (its `service.name`, metric exporters and spans),
`metrics_ready` with its `/metrics` URL, or `metrics_listen_failed` when the port is taken (the
process runs on without it), and `telemetry_export_dropped` at most once a minute while an export
fails.

### Audit

Who changed what the Tenant allows, and which credentials its sessions used, is on the Tenant's
own stream (Host feature `tenant-audit`). It is a record, like a session's events: written in the
same transaction as the change, never sampled, never relayed to S2, and kept by a reset. It is
the Runtime's record (layer `runtime`).

| Event | When | Payload |
| --- | --- | --- |
| `key.created`, `key.revoked` | An application or management key is put (created, or `rotated`) or deleted, over the Management API or with `nylorun-operate` | `keyId`, `role`, `rotated` |
| `signing_key.rotated`, `signing_key.revoked` | The signing keys rotate, or a previous or standby one is revoked | The key ids in each state, `force` |
| `policy.changed` | The tool policy is replaced | `rules` (the count) and `updatedAt`, never the rules |
| `settings.changed` | A setting is replaced: `limits.config`, `environments.config`, `artifacts.config`, `skills.config`, `model.budgets`, `model.inputs`, `model` (with `provider` and `model`), or one a seed set | `key`, never the value |
| `credential.created`, `.rotated`, `.deleted` | An Agent's secret is written, replaced or deleted (also a fork's copies, and an Agent's secrets when it is deleted); setting or choosing the model rotates its credential | `vaultId`, `credentialId`, `target`, `outcome` |
| `credential.used` | A gate asks the vault for a credential for a session's MCP server or HTTP tool, approved or refused | `vaultId`, `credentialId`, `sessionId`, `target` (the URL), `outcome` |
| `studio.signed_in` | A person signs in to Studio: with a login link (`token`), through a sign-in proxy (`forwarded`), or on the loopback address (`loopback`, at most hourly) | `method`, `subject` when there is one |

Every event names who acted (`principal`) from the credential of the request that made the
change, never from its body: a key's name (`bootstrap`, `studio`, an application key's),
`<key>:<subject>` for a key acting for a person, `<issuer>:<subject>` for a trusted issuer's
token, `operate` for `nylorun-operate`, and `host` when the Runtime acted itself (a credential
used, an Agent deleted by its sweep). `source` says what wrote it: `api`, `operate`, `runtime` or
`studio`. No payload holds a secret value: each payload's fields are fixed, and the Runtime
refuses an event with any other. The `vault_audit` table is still written as before.

Read it with a management key, newest first, a page at a time:

<!-- doc-test: typescript -->
```ts
import { createAdmin } from "@nylorun/admin";

const admin = createAdmin();
let cursor: string | undefined;
do {
  const page = await admin.tenant.audit({ types: ["credential.used"], since: "2026-11-20T00:00:00Z", cursor });
  for (const event of page.events) console.log(event.time, event.principal, event.payload.target, event.payload.outcome);
  cursor = page.nextCursor ?? undefined;
} while (cursor);
```

`GET /v1/tenant/audit?since&until&types&cursor&limit` is the route: `types` is comma-separated,
`limit` defaults to 50 and is held to the Runtime limit `pageItems`, and a `cursor` works only
with the filters it was read with. An application key is `403 key_role_mismatch`. Studio shows it
in **Tenant › Audit**, with a type filter and **Load more**; Studio records its sign-ins with
`POST /v1/tenant/audit/studio-sign-in`, which only Studio's own key may call, and a sign-in the
Runtime fails to record is logged by Studio (`studio sign-in not recorded`) and still goes ahead.

### Content

By default spans carry references, never content: what a person sent, the model's output, the
tool calls it asked for, tool results and error messages stay in the log, which a span points at
with `nylorun.event.cursor`. One switch, from the GenAI semantic conventions, copies content onto
the turn traces' spans:

| `OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT` | Spans carry |
| --- | --- |
| `NO_CONTENT` (default) | No content |
| `SPAN_ONLY` | `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, and error messages |
| `EVENT_ONLY` | No content, with a warning: the Runtime emits no GenAI events yet |
| `SPAN_AND_EVENT` | As `SPAN_ONLY`, with a warning |

The value is read without regard to case; an unknown one means `NO_CONTENT`, with a warning, and
never stops a start. Content is recorded as structured values (OTLP `arrayValue` and
`kvlistValue`, as the conventions type them), and each text in it is cut at the Tenant's Runtime
limit `traceContentBytes` (8 KiB by default), keeping the structure. A span never carries a
credential, a prompt (the log holds none), a person's id or an idempotency key, whatever the
switch says.

**Moving from the old variables.** `NYLORUN_TRACE_CONTENT` (its kinds) and
`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` (all of them) still work for this release,
each logged once at start as `trace_content_deprecated`. Replace either with
`OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT=SPAN_ONLY`; when the new switch is set, they are
ignored. The switch has no per-kind setting: one that kept only some kinds, such as `errors`,
chooses between all of them and none. See [MIGRATION.md](MIGRATION.md).

### Variables

Set them on the runtime and the gateway (`nylorun start` passes them from its shell to both; the
chart takes them in `extraEnv.runtime` and `extraEnv.gateway`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `OTEL_METRICS_EXPORTER` | `prometheus`, plus `otlp` with an endpoint | A comma list of `prometheus`, `otlp` and `none` |
| `OTEL_EXPORTER_PROMETHEUS_HOST`, `_PORT` | `0.0.0.0`, `9464` | Where `/metrics` listens (a Host outside a container: `127.0.0.1`) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | none | The collector's OTLP/HTTP base URL: metrics to `/v1/metrics`, spans to `/v1/traces` |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, `_TRACES_ENDPOINT` | none | One signal's full URL instead |
| `OTEL_EXPORTER_OTLP_HEADERS`, `_METRICS_HEADERS`, `_TRACES_HEADERS` | none | `key=value` pairs separated by commas, values percent-encoded |
| `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG` | `parentbased_always_on` | Which live spans are kept (above) |
| `OTEL_SERVICE_NAME` | `nylorun-runtime`, `nylorun-gateway` | `service.name` |
| `OTEL_RESOURCE_ATTRIBUTES` | none | More resource attributes; its `service.name` wins over the default |
| `OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT` | `NO_CONTENT` | Content on spans (above); the runtime only |

An unknown exporter, sampler or ratio is skipped or replaced by its default, with a warning; a
`/metrics` port that is not a number stops the start.

### On a laptop: Studio's Traffic

Studio's **Tenant › Traffic** reads the runtime's and the gateway's `/metrics` live, every 10 s,
and shows API requests by route and client, model calls by model with their tokens, MCP tool
calls, turns, queue waits, egress connections by outcome and reason, and any dropped telemetry:
counts since each process started, the rate since the last read, and p50 and p95 from the
histograms. Studio stores none of it and makes none of its own; it reads the sources in
`NYLORUN_STUDIO_METRICS_URLS` (`name=url` pairs: `nylorun start` and the chart set the runtime's
and the gateway's). With the chart's `metrics.from` set, Studio may still scrape both.

### Your own tools

For history, alerts and dashboards, send the telemetry to your own backend.
[examples/observability](../examples/observability/README.md) has:

- `compose.yaml`: Grafana's all-in-one OpenTelemetry backend (`grafana/otel-lgtm`) on your
  machine. Start it, then `nylorun start` with `OTEL_EXPORTER_OTLP_ENDPOINT=http://host.docker.internal:4318`
  and `OTEL_METRICS_EXPORTER=prometheus,otlp`.
- `grafana-dashboard.json`: the golden signals above, as one dashboard.
- `collector.yaml`: an OpenTelemetry Collector for production. It keeps every trace with an error
  or a slow turn and a quarter of the rest (tail sampling), and every metric, then sends them to
  any OTLP backend: Grafana Cloud, Honeycomb, Datadog, or an LLM-observability tool such as
  Langfuse or Phoenix for the agent spans.
