# A minimal harness

A harness of about 400 lines of TypeScript that runs agent turns for the Nylorun Runtime. It is written only against the published contract (Harness API 4), [`@nylorun/core/harness-api`](../../core/src/harness-api/index.ts) with core's media types, and the `ws` package; it does not use our engine (`@nylorun/harness`). Read it as a worked example of the Harness API, or copy it as the start of your own harness.

- [`src/harness.ts`](./src/harness.ts): the connection and the loop.
- [`src/pod.ts`](./src/pod.ts): the join and token renewal of a sandbox pod.
- [`src/main.ts`](./src/main.ts): the entrypoint, which picks the mode.

## What a turn does

The harness says `hello` with its harness id, `minimal` (or `HARNESS_ID`), and no `features` (no workspace, no tools of its own), and takes the runs of the sessions pinned to that id: those opened on an Environment whose `harness` is `minimal`. Our harness keeps the rest. It leases one run at a time:

1. `lease` hands it a run: the run token (`RunGrant.token`) and the turn (`TurnStart`). It renews the lease every `renewEveryMs` from the `hello` answer, and takes a new run token when a renewal brings one.
2. `transcript.read`, once: the session's transcript so far.
3. It builds the prompt from the agent's `instructions`, then a one-line note of its own on the sandbox when the session has one (`turn.start.environment.sandbox`, with its `workspace`), the transcript and the turn's message, and calls the Model Gate (`POST $NYLORUN_GATES_URL/nylorun/v1/model-calls`) with `Authorization: Bearer <run token>` and `Idempotency-Key: <effect id>`. The model is offered one tool, its own `bash`, only then. How a message's files reach the model is the harness's to decide: it sends each file the turn's model reads natively (`turn.start.model.inputs`; text and images without a descriptor) as its media part, which the gate fetches, and a line `[File "name" (type) not shown]` for the rest, text files included, since it reads none in. The gate refuses a part the model cannot take (`unsupported_input`).
4. When the model calls `bash`, the harness runs the command itself with `bash -c`, in `/workspace` when it exists, journaled as a `harness` call (`target: {kind: "harness"}`): it runs in the harness's own process, so the record keeps it as the harness's. (A tool effect's `target` is one of `{kind: "mcp", server, tool}`, `{kind: "http", tool}`, `{kind: "sandbox"}` or `{kind: "harness"}`: what runs it, beside the name the model used.) The outcome it reports is one record entry, which the record refuses past `turn.start.limits.recordEntryBytes` (`limit_exceeded`): a step's results get a quarter of that limit, shared by its calls, and an output that does not fit is stored whole as an artifact of the session (`artifact.write`, keyed `bash:<effect id>` and linked to the call by `effectId`). The outcome then says it was cut and carries `{exitCode, truncated: true, note, artifactId, version, size, preview}`, the preview being the output's head and tail.
5. It repeats until the model answers with text, then settles with `turn.completed`: the text as `output`, the transcript entries it added (`input`, `candidate`, `tool-results`, `final`) as edits, and `state: {steps}`, which core keeps and hands back with the next turn without reading it.

Every model and tool call is an effect, journaled with `effect.intent` before it runs and `effect.outcome` after. Effect ids are built with `effectIdOf` from stable names, never from timing: `<turnId>:<segment>:model:<n>` and `<turnId>:<segment>:tool:<n>:<callId>`. A run that starts over (after a crash or a lost connection) asks for the same ids, so core answers what already happened (`completed`, with the recorded outcome) and nothing runs twice. A call core answers `uncertain` or `pending` ends the turn with `turn.waiting`. Core's `cancel` aborts the run: the model call is cancelled at the gate, a running command is killed, and the turn ends with `turn.failed` and status `cancelled`. A shutdown gives the run back with `lease.release`.

## Two modes

**Harness container.** The harness runs beside the Runtime on its `harness` network and connects with its own token, bound to the id it says in `hello`.

| Variable                | Value                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `NYLORUN_HARNESS_URL`   | Core's Harness API, `ws://runtime:4200/nylorun/harness/v1` in Compose                   |
| `NYLORUN_HARNESS_TOKEN` | Its own token: `nylorun-operate harness token put minimal` prints it once               |
| `NYLORUN_GATES_URL`     | The gateway, `http://gateway:4100` in Compose                                           |
| `HARNESS_ID`            | The harness id it says in `hello`. Default `minimal`; the token must be for the same id |

**Sandbox pod.** The harness is the pod's entrypoint: a pod Environment whose `harness` is not ours runs its `image` as the harness (R4.4). It holds no harness token: it reads the join token mounted in the pod, exchanges it for a host token (`POST /nylorun/harness/v1/host/join`), renews it every 5 minutes, and connects with the host token. Core takes its `hello` only when it names the Environment's harness, so `HARNESS_ID` (default `minimal`) must be the Environment's `harness`. Every command it runs gets the egress proxy (with the egress token as password) and a trust bundle with the egress CA. It starts in this mode when `NYLORUN_SANDBOX_ID` is set or the join file exists. The pod sets these variables:

| Variable                                | Value                                                                 |
| --------------------------------------- | --------------------------------------------------------------------- |
| `NYLORUN_SANDBOX_ID`, `NYLORUN_POD_UID` | The sandbox and the pod, for the join                                 |
| `NYLORUN_SANDBOX_JOIN_FILE`             | The join token's file. Default `/run/nylorun/join/token`              |
| `NYLORUN_HARNESS_URL`                   | The Harness API listener, `http://<host>:<port>`                      |
| `NYLORUN_GATES_URL`                     | The gates, on the Docker host's address                               |
| `NYLORUN_EGRESS_PROXY`                  | egress-gate                                                           |
| `NYLORUN_HARNESS_ROOT`                  | Its own state: the volume id and the trust bundle. Default `/harness` |

## Run it beside the Runtime

Build the image from the repository root (it builds `@nylorun/core` from this checkout):

```sh
docker build -f examples/harness-minimal/Dockerfile -t harness-minimal:dev .
```

Make its token in the runtime container, then run it on the Tenant's `harness` network with that token. For the examples Tenant (Compose project `nylorun-examples`):

```sh
TOKEN="$(docker exec nylorun-examples-runtime nylorun-operate harness token put minimal)"
docker run --rm --name harness-minimal --network nylorun-examples-harness \
  -e NYLORUN_HARNESS_URL=ws://runtime:4200/nylorun/harness/v1 \
  -e NYLORUN_HARNESS_TOKEN="$TOKEN" \
  -e NYLORUN_GATES_URL=http://gateway:4100 \
  harness-minimal:dev
```

Our harness keeps running: the Runtime routes each session by the harness it is pinned to. Send sessions to this one with an Environment whose `harness` is `minimal`, `none` for text only or `virtual` for `bash`:

```sh
curl -X PUT "$NYLORUN_RUNTIME_URL/v1/environments/minimal-box" \
  -H "authorization: Bearer $NYLORUN_API_KEY" -H "nylorun-protocol: 14" -H "content-type: application/json" \
  -d '{"kind": "virtual", "harness": "minimal"}'
```

and open a session with `"environment": "minimal-box"`. `GET /v1/sessions/{id}` says `"harness": "minimal"`, and the session's events say `source: {kind: "harness", id: "minimal"}`. A session without an Environment still runs on ours. `nylorun-operate harness token rm minimal` revokes the token.

To run it as a sandbox pod instead, load the image where the cluster can pull it and create a pod Environment whose image it is:

```json
{ "kind": "pod", "image": "harness-minimal:dev", "harness": "minimal" }
```

To try it without a model provider, turn on the Tenant's fixture model, which the Model Gate answers itself and meters like any model:

```sh
curl -X PUT "$NYLORUN_RUNTIME_URL/v1/tenant/config/seed" \
  -H "authorization: Bearer $NYLORUN_MANAGEMENT_KEY" -H "nylorun-protocol: 14" -H "content-type: application/json" \
  -d '{"requestId": "fixture-1", "fixtureModel": true}'
```

Then send `fixture:text` to a session, or `fixture:tool bash {"command":"uname -a"}` to a session on the `virtual` Environment. Each model call is a row of `GET /v1/sessions/{id}/calls/model`, with provider `fixture`. The fixture model stays on once seeded, so use a Tenant for testing.

## Artifacts

This harness offers no artifact tools, but any harness may read and write its run's session's artifacts over the artifact seam ([HARNESS_API.md §4b](../../guides/HARNESS_API.md#4b-artifacts)). A tool of your own that hands the user a file, journaled like `bash` as a `harness` call, would save it like this, keyed by its effect id so a repeat stores nothing twice:

```ts
import { readArtifact, writeArtifactBytes } from "@nylorun/core/harness-api";

const { chunkBytes } = run.start.limits;
const saved = await writeArtifactBytes(
  channel,
  { runId: run.runId, key: effect.effectId, effectId: effect.effectId, name: "report.md", chunkBytes },
  new TextEncoder().encode("# Report\n"),
);
// saved.artifact: { artifactId, version, name, contentType, size, sha256, ... }

const opened = await readArtifact(channel, { runId: run.runId, artifactId: saved.artifact.artifactId, chunkBytes });
for await (const chunk of opened.chunks()) process.stdout.write(chunk);
```

Keep every outcome you report under `turn.start.limits.recordEntryBytes`, and a step's results too, since they are one transcript entry: store a large result with `artifact.write` as above and report a preview, as this harness does for `bash`.

## MCP tools

This harness offers no MCP tools, but a harness of your own may offer the session's remote MCP servers. `turn.start.mcp` lists them as facts: each server's `name` (and `agentId` for an agent used as a tool), `instructions`, and its `tools`, each with `name`, `description`, `inputSchema`, `enabled` and `deferred`. Name the tools for the model yourself, within 64 characters, and skip a tool that is not `enabled`: the record refuses its calls (`tool.disabled`). `deferred` is a hint: offer the tool later, behind a search of your own, or now.

```ts
import { TOOL_CALLS_PATH, type ModelCallTool, type ToolCallBody } from "@nylorun/core/harness-api";

type McpTool = { agentId?: string; server: string; tool: string };
const mcpTools = new Map<string, McpTool>(); // the model's name -> the tool's identity
const tools: ModelCallTool[] = [];
for (const server of run.start.mcp?.servers ?? [])
  for (const tool of server.tools) {
    if (!tool.enabled) continue;
    const name = `${server.name}__${tool.name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
    if (mcpTools.has(name)) continue; // or make the name unique your own way
    mcpTools.set(name, { ...(server.agentId ? { agentId: server.agentId } : {}), server: server.name, tool: tool.name });
    tools.push({ name, description: tool.description ?? "", inputSchema: tool.inputSchema });
  }
```

When the model calls one, journal it with its identity as the target (the raw tool name from the facts, not the model's), and when core answers `execute`, call the Tool Gate with the run token, keyed by the effect id:

```ts
const mcp = mcpTools.get(toolCall.name)!;
const effect = {
  effectId,
  kind: "tool",
  toolName: toolCall.name,
  target: { kind: "mcp", server: mcp.server, tool: mcp.tool },
  input: toolCall.args,
  context: { callId: toolCall.id, invocationId, stepId },
};
// ... effect.intent answered `execute`:
const body: ToolCallBody = {
  server: { ...(mcp.agentId ? { agentId: mcp.agentId } : {}), serverName: mcp.server },
  effectId,
  name: mcp.tool,
  arguments: toolCall.args,
};
const response = await fetch(new URL(TOOL_CALLS_PATH, gatesUrl), {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "idempotency-key": effectId,
    authorization: `Bearer ${run.grant.token}`,
  },
  body: JSON.stringify(body),
});
const answer = await response.json(); // {ok: true, result} or {ok: false, error}
```

The gate refuses an answer past `limits.toolAnswerBytes` (`mcp.too-large`, and `http.too-large` for an HTTP tool), and the answer it keeps may still be larger than a record entry holds: shape it to fit `limits.recordEntryBytes` before you report it with `effect.outcome`, spilling the rest with `artifact.write`.

## Tests

```sh
npm install
npm test
```

The unit tests run the loop against a fake core and a fake Model Gate: a text turn, a `bash` turn journaled intent first, a replay that runs nothing twice, a `bash` output too large to report stored as an artifact with a preview reported instead, and a cancel. In the Runtime's tests, [`example-harness.test.ts`](../../runtime/server/test/harness-api/example-harness.test.ts) runs it against a real Runtime over the WebSocket with its own token, beside our harness, on the fixture model: routing, metering, journaling, one run per turn, cancels, a restart mid-command, a tool the turn does not offer, a budget refusal and token redaction.

## What it leaves out

This harness stays small. In this first version:

- No workspace: it declares no `features.workspace` and serves no `workspace.*` requests, so the session sandbox routes find no workspace.
- No outputs folder and no skill folders: saving `/workspace/outputs` as a folder artifact (`artifact.write` with `kind: "folder"`) and putting skills' files in the sandbox are our harness's conventions, and the Runtime does neither for a harness.
- No compaction: it never summarizes history. A harness that does marks the edit `kind: "compaction"` and its summary calls `purpose: "summary"` ([HARNESS_API.md §6](../../guides/HARNESS_API.md#6-transcript)).
- No artifact tools: it offers no `read_artifact` or `save_artifact` (they are our harness's own since protocol 15). A harness reads and writes its run's artifacts over the artifact seam; see [Artifacts](#artifacts).
- One tool: its own `bash`, with a sandbox. It offers no `read`, `write`, `edit`, `grep` or `glob`, no skill tools, no remote MCP servers (see [MCP tools](#mcp-tools) for how yours would), no HTTP tools and no agents used as tools. A tool it does not run is answered `tool.unknown` to the model.
- It holds a command's whole output in memory until it has stored or reported it.
- No approvals or pauses, no flows, and no segment rollover: a turn that starts from an approval, a flow or a `continue` fails with `harness.unsupported`. A turn is at most 16 model steps.
- One run at a time. As a container, every session's commands share one working directory.
- No streaming: the Model Gate answers once a call has finished.
- In a pod it does not wait for the pod's NetworkPolicy before its first call, as our engine does.
