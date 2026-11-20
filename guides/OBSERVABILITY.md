# Observability

The Runtime has two systems for two readers (ADR-159). The **event log** is the durable history
of every session and Agent: what the agent did, and what the Runtime did to it. It is exact,
never sampled, and the Runtime resumes and audits from it. It is for **developers** building and
running agents. **Telemetry** is OpenTelemetry: traces about how the Runtime and its parts ran.
It is best effort and goes to whatever tools a team runs. It is for **operators** running the
Runtime.

| | Event log | Telemetry |
| --- | --- | --- |
| For | Developers | Operators |
| Answers | What happened, and who is accountable for it? | How fast, how often, how healthy? |
| Read through | The Runtime API, the SDK, Studio | Your OpenTelemetry collector; a turn's trace from the Runtime API |
| If writing fails | The change fails with it | Dropped; nothing waits |
| Sampled | Never | Your collector may |

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

### Health

| Probe | Answers |
| --- | --- |
| `GET /health` on the Runtime (port 4000) and the gateway (4100) | The process is up, with its version and protocol |
| `GET /ready` | The Runtime can serve: its listener, Tenant, Postgres and Restate |
| `GET /v1/tenant` (Management API) | The Tenant's checks, counts, sandboxes, harness and streams |
| `nylorun status` | The local stack's services, Studio's URL |

### Logs

Each Runtime service writes JSON lines to stdout: `level`, `message`, `time`, and fields. The
Runtime logs one `request` line per API request (method, redacted path, status, duration); the
gateway logs `model_call`, `model_retry`, `mcp_request` and `http_tool_call` per operation, and
the egress proxy `egress_refused`. On the local stack, `nylorun local logs <service>` reads them.

### Exporting traces

Set an OTLP endpoint on the `runtime` container and the Runtime exports every turn's trace. The
variables, what leaves and how a collector that is down is handled are in
[DEPLOYMENT.md, Traces](DEPLOYMENT.md#traces). By default a span carries references, never
content; opting in to content is per kind, with `NYLORUN_TRACE_CONTENT`.

A harness must not instrument its own model calls: the Runtime already makes their spans, and a
second instrumentation counts every call twice. Spans for work the Runtime cannot see, such as a
retrieval step inside the harness, are welcome.
