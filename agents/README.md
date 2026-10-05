# @nylorun/agents

Runtime API client package: definition authoring, a session client, and the
Action endpoint that runs your tools (`createActionHandler`). The Tenant's
settings, models, vaults, signing keys and application keys are the Management
API's, through [`@nylorun/admin`](../admin/README.md). Depends only on `@nylorun/core` among Nylorun
packages. A developer application's production tree should contain only this
package and `@nylorun/core` from Nylorun. Vocabulary:
[runtime/src/CONTEXT.md](../runtime/src/CONTEXT.md).

## Application entry (preferred): an Action endpoint

```ts
// src/main.ts
import { createServer } from "node:http";
import { createActionHandler } from "@nylorun/agents";
import { agents } from "../agents/index.js";

const url = process.env.NYLORUN_ACTIONS_URL ?? "http://localhost:3001/nylorun/actions";
const actions = createActionHandler({ agents, url });
createServer(actions.node).listen(3001); // or actions.fetch in Hono, Next.js, Workers, Bun
await actions.register({ url });
```

The Runtime delivers each tool call and workflow function of these agents
to `url`, signed with a short-lived **delivery token** that the handler checks
(Tenant, URL, Action, generation and body) before any code runs. `register`
saves the definitions, registers the URL and pings it through the Runtime. A
process that only serves Actions needs no key: pass `runtime: { url }` and it
reads the Tenant's public keys. Mark a long tool
`tool({ …, background: true })`: the handler answers at once, heartbeats and
posts the result. `npx @nylorun/cli endpoints` shows each endpoint and how its
deliveries are doing.

The URL must be one the Runtime can reach: `localhost` on a local Tenant
(its Runtime runs in Docker and maps `localhost` to this machine), a public URL
in production, or a tunnel (ngrok, Cloudflare Tunnel) for a remote Runtime.

`connectAgents` and executors were removed in protocol 3: mount
`createActionHandler` instead (see [MIGRATION.md](../MIGRATION.md)). The handler
finds the Runtime through the two `NYLORUN_*` variables or the Project link
that `npx nylorun start` writes; with neither, `register` fails with
`connection_missing` and names those steps. See [MIGRATION.md](../MIGRATION.md#runtime-clients-and-admin-api-breaking-beta)
for upgrading from `nylorun serve`.

## Connection resolution

`resolveConnection` / `createClient()` / `createActionHandler({ agents })`:

1. Explicit `{ url, key }`
2. Environment — if `NYLORUN_RUNTIME_URL` or `NYLORUN_SERVER_KEY` is set, both
   must be present
3. Project link — `.nylorun/link.json` + `credentials.json` (the application
   key), written by `npx nylorun start`. A link from an older nylorun
   (format 0 to 2) fails with `connection_missing`: run `npx nylorun start` in
   the project again.

Sources never mix. Partial environment fails with `connection_missing`. A
Runtime serves one Tenant, so nothing names it: the `tenant` option is gone
(protocol 5), and `NYLORUN_TENANT`, which picks a local Tenant for `nylorun`,
is ignored.

```ts
import { Agent, createActionHandler, createClient, tool } from "@nylorun/agents";
import { z } from "zod";

const assistant = Agent({ id: "assistant", name: "Assistant" })
  .instructions("Use the available tools.")
  .tools(
    tool({
      name: "lookup",
      input: z.object({ id: z.string() }),
      async run({ id }, ctx) {
        return { id, owner: ctx.info };
      },
    }),
  );

// Explicit Runtime API client (options or env / link via createClient()).
const client = createClient({
  url: process.env.NYLORUN_RUNTIME_URL,
  key: process.env.NYLORUN_SERVER_KEY,
});
await client.saveAgent(assistant, { implementationVersion: "app-1" });
const session = await client.createSession({
  agentId: assistant.id,
  ownerUserId: authenticatedUser.id,
});
await session.input("Look up item 123", { idempotencyKey: requestId });
const history = await session.history();

// A process that only serves Actions holds no key: it reads the Tenant's public keys.
const actions = createActionHandler({
  agents: [assistant],
  implementationVersion: "app-1",
  runtime: { url: process.env.NYLORUN_RUNTIME_URL! },
  url: "https://app.example.com/nylorun/actions",
  onError: console.error,
});
app.post("/nylorun/actions", actions.node);
// A deploy step with the application key registers the URL once:
await createActionHandler({ agents: [assistant], client }).register({
  url: "https://app.example.com/nylorun/actions",
});
```

```sh
eval "$(npx @nylorun/cli env)"
# → NYLORUN_RUNTIME_URL, NYLORUN_SERVER_KEY
```

Every request sets `Nylorun-Protocol` (6) and no `Nylorun-Tenant`: the Runtime
serves one Tenant. Before the first authenticated
request, `Transport` fetches `/health` once, checks protocol compatibility, and
throws `IncompatibleRuntimeError` / `incompatible_host` when the Host range or
required features do not match. Re-exports include `PROTOCOL_FEATURES`,
`ERROR_CODES` and `compareVersions`.

Load Agent Skills from a local catalog folder with `.skills(path)`:

```ts
import { Agent } from "@nylorun/agents";

const assistant = Agent({ id: "assistant", name: "Order assistant" })
  .instructions("Use lookup_order for orders.")
  .tools(lookupOrder)
  .skills("./assistant-skills");
```

Each subdirectory under the catalog must contain a `SKILL.md` with YAML frontmatter (`name`, `description`) per [Agent Skills](https://agentskills.io/home). Supporting files (for example `references/`) are available through `read_skill_resource` after `load_skill`. The helper sets both the manifest skill catalog and the on-disk skill records so you do not duplicate content.

Declare MCP servers with `.mcp(...)` (same map shape as agent-plugins `mcpServers`):

```ts
import { Agent } from "@nylorun/agents";

const assistant = Agent({ id: "assistant", name: "Assistant" })
  .instructions("Use the available tools.")
  .mcp({
    github: { type: "streamable-http", url: "https://mcp.example.com/github" },
  });
```

Each key names a server; its `name` defaults to the key and, when given, must equal it. Repeated `.mcp()` calls add servers to the same capability. Nylorun accepts remote servers only: `streamable-http` and `sse` ([Agent Plugins MCP servers](https://agent-plugins.org/plugin-authors/mcp-servers)); a `stdio` server is refused, so run it behind an HTTP transport and declare its URL. Attach an Agent Plugin package with `.plugin(path)`: its skills and remote MCP servers join the agent, and a stdio server in its `mcp.json` throws.

Give a session a sandbox when you open it. The agent declares nothing, so the same agent runs with or without one, in any Tenant:

```ts
const session = await client.createSession({
  agentId: "analyst",
  ownerUserId,
  sandbox: {
    network: { allow: ["pypi.org", "files.pythonhosted.org"] }, // no egress unless you list hosts
    resources: { cpus: 2, memory: "2GiB" },
  },
});
```

The model gets `bash`, `read`, `write`, `edit`, `grep` and `glob` on a persistent `/workspace`. These tools run in the Runtime, not in your process, so sandbox-only agents need no Action endpoint. The Runtime decides where the sandbox runs: today an emulated shell in the Runtime process, which is not a VM boundary and takes no `image`.

`sandbox` takes `false` for none, `{ id }` to attach a sandbox resource (below), or an inline sandbox as above; omit it for the Tenant's default. `{ session }`, sharing another session's sandbox, still works and is deprecated. The Runtime checks it against the Tenant's limits (`GET`/`PUT /v1/tenant/sandbox`: a network ceiling, a resource maximum, the idle timeout) and answers `400` with every problem it finds. A caller acting for a user (`app.as(...)`) can't define one inline; it gets the Tenant's default or `false`. Private networks, loopback, the host and cloud metadata endpoints are always blocked.

A sandbox can also be a resource with its own id, which outlives the sessions attached to it (Host feature `sandboxes`). Whether it serves one session, one person or a project is your choice:

```ts
// One per session: created with the session, deleted by release().
const { session, release } = await client.sandboxes.forSession({
  session: { agentId: "analyst", ownerUserId },
  spec: { network: { allow: ["pypi.org"] } },
});
// One per person or project: get-or-create by id, then attach sessions to it.
await client.sandboxes.ensure("team-a/proj-42", { labels: { project: "acme" } });
await client.createSession({ agentId: "analyst", ownerUserId, sandbox: { id: "team-a/proj-42" } });
```

Sessions attached to one sandbox share its `/workspace`, and one turn runs in it at a time: a second session's turn is refused with `409 sandbox_busy` until the first ends. Deleting a session only detaches it. A spec is fixed once the sandbox exists; `labels` can change. `client.sandboxes.list({ labels })`, `get(id)` and `delete(id)` manage them, and `npx nylorun sandbox ls | rm` does the same on a local Tenant. A trusted issuer's token reaches only the sandboxes its issuer grants (the identity file's `sandboxes` templates, exact ids or prefixes ending in `/*`), checked at every turn start; creating and deleting through one needs `sandboxes:write`. The Tenant holds at most `limits.sandboxes` of them (`PUT /v1/tenant/sandbox`, default 100).

Add an agent with `.subagents()` to let the model delegate to it:

```ts
import { Agent } from "@nylorun/agents";
import { z } from "zod";

const researcher = Agent({
  id: "researcher",
  description:
    "Investigates an order's history. Returns a short summary with the ids it relied on.",
})
  .instructions("Investigate one question about one order. Be exhaustive, then be brief.")
  .tools(searchOrders, readTicket)
  .output(z.object({ summary: z.string(), evidence: z.array(z.string()) }));

const support = Agent({ id: "support" })
  .instructions(
    "For anything needing more than two lookups, delegate to researcher with a complete, self-contained task.",
  )
  .tools(lookupOrder, refundOrder)
  .subagents(researcher);
```

The tool is named after the agent's `id` and takes `{ task: string }`; the agent's `description` (required) is what the parent's model reads to decide when to delegate. The child starts with a fresh context: it sees its own instructions and the task, nothing of the parent's conversation, and only its final text (or `outputSchema` result) comes back. It keeps its own tools, skills and MCP servers, served by the Action endpoint you already mount for the parent (`createActionHandler({ agents: [support] })` serves both), shares the session's sandbox, and starts with empty `ctx.state`. Tools can read `ctx.agent` (`{ id, path, delegationId }`). Several delegation calls in one model response run in parallel. An empty answer, a failure (with the child's last text marked as evidence) or a cancelled child reaches the parent's model as a failed tool result, never as success. The Runtime emits `delegation.started` and `delegation.completed`; `session.history({ agent })` filters by `delegationId` (one child invocation) or by path such as `support/researcher` (every concurrent child that shares that path).

A flow agent can be a subagent too: `.subagents(researchFlow)` with a `description` like any other. Its manifest is inlined in the parent's, so it is saved with the parent and served by the parent's Action endpoint. When the model calls it, the flow runs on the Runtime in its own linked session (a fresh one per call, linked from the parent's with a `node.agent` event at `support/<flow id>`), its agents in theirs, and the flow's output comes back as the tool result; a failed flow is a failed tool result. Cancelling the parent cancels the flow. Flow agents as subagents run on the Runtime only, not in a local `run()`. An approval asked for inside the flow waits on the flow's own session.

Delegate when the parent should keep the answer. When a specialist should own the rest of the conversation, send the next message with a turn manifest that has the specialist's instructions instead. This version is one level deep and non-interactive: a delegated agent cannot use agents as tools, its tools cannot declare `approval` (keep those on the parent), and `ctx.ask`, `ctx.approve`, `ctx.sleep` or `ctx.waitFor` inside it fail with `delegation.interaction-unsupported`. Delegation is not an approval boundary; approvals live on tools.

## Flow agents

An agent's body is either a ReAct loop (the model decides) or a flow (your code
decides). A flow agent is built from stages, each shaped `.stage(whatRuns, { how })`,
and is registered, saved and opened as a session like any agent: put it in
`export const agents`, `saveAgent(flowAgent)`, then `createSession({ agentId })`
and `session.input(value)`. `input` sends string values as `content` and other JSON
as `data`. On the wire a flow agent is a workflow manifest v2 (`kind: "workflow"`,
`workflowSchemaVersion: 2`) that embeds the agents it runs, so one document and one
manifest hash cover the whole flow; its agents are not listed on their own.

```ts
import { Agent, tool } from "@nylorun/agents";
import { z } from "zod";

const planner = Agent({ id: "planner" })
  .instructions("Return { tasks: string[] }.")
  .output(z.object({ tasks: z.array(z.string()) }));

const coder = Agent({ id: "coder" })
  .instructions("Implement one task. Return { summary }.")
  .output(z.object({ summary: z.string() }));

const openPr = tool({
  name: "open-pr",
  input: z.object({ summaries: z.array(z.string()) }),
  async run({ summaries }, ctx) {
    if (!(await ctx.approve("Open the PR?"))) throw new Error("Rejected");
    return { opened: true, count: summaries.length };
  },
});

export const shipFeature = Agent({ id: "ship-feature" })
  .step(planner)
  .map(
    Agent({ id: "code" }).loop(coder, {
      verify: ({ output }) => (output.summary ? { pass: true } : { pass: false, feedback: "Say what you changed." }),
      max: 2,
    }),
    { id: "implement", input: ({ input }) => input.tasks },
  )
  .step(openPr, { input: ({ input }) => ({ summaries: input.map((item) => item.summary) }) });

export const agents = [shipFeature];
```

| Stage | Role |
| --- | --- |
| **`.step(x, { id?, input? })`** | Run one agent, tool or `flow()`; its output is the next stage's input |
| **`.switch({ ...cases, default? }, { on })`** | `on({ input })` returns a case name; exactly that case runs |
| **`.parallel(branches)`** | Fixed named branches at once, same input; output is an object |
| **`.map(each)`** | Run `each` once per item of the input, which must be an array; output is an array |
| **`.loop(body, { verify, max?, decide? })`** | Run, verify, run again with the feedback until it passes; needs `max` or `decide` |

Every function receives one object: `{ input, results, flowInput }`. `input` is
what the stage received, `results` holds earlier steps' outputs by step id, and
`flowInput` is the agent's own input. The `input` option computes a stage's input;
the `id` option names a step. `flow()` builds a sequence with no id for a case,
branch, map item or loop body that is more than one step. Types flow from each
step's `.output()` schema to the next stage's `input`.

Agents inside a flow keep their own sessions, linked from the flow's session and
named by the agent: a step's id (the agent's id, or `{ id }`), with `[i]` for each
Map item and a nested flow agent's id in front of its own agents'. Control stages
add nothing, so wrapping a step in `.loop()` or moving it between cases keeps its
session. An agent may appear once per flow; use it again under a new id with
`.step(writer, { id: "final-writer" })` or `writer.withId("…")`
(`flow.duplicate-leaf`). Functions are bound under stage keys: a stage's `id`, or
its position such as `@1.default.1`, plus `:input`, `:on`, `:verify` or `:decide`.
Name the stages you may reorder.

`Chain`, `Switch`, `Parallel`, `Map` and `Loop` still build workflow manifest v1
directly and run as before; a flow agent can't be a child of them.

The agents in a flow share one sandbox: open the flow's session with it,
`createSession({ …, sandbox: { … } })`, and every agent, tool step and `verify` in the
flow uses it. Share it with other sessions by opening them all on one sandbox resource
(`sandbox: { id }`, see `client.sandboxes`), and call
built-ins via `session.sandbox` (application) or `ctx.sandbox` (a tool).
Observe with `session.observe({ follow: true })` to merge linked agent streams;
`pending()` lists waits across the tree. Studio renders the manifest tree and
live node status. Source examples:
`examples/agents/{chain,switch,parallel,map,loop,ship-feature}/` (outside the
default release registry). Host contract:
[HOST_CONTRACT.md](../harness/HOST_CONTRACT.md). Vocabulary (turn loop vs
workflow Loop): [harness/src/CONTEXT.md](../harness/src/CONTEXT.md).

Use `session.observe({ cursor, signal })` for resumable canonical events, `session.inspect()` for waiting/uncertain state, and `approve`, `respond`, or `cancel` with an explicit stable idempotency key. Retry the same semantic command with the same key. `ownerUserId` must come from trusted server authentication. Application credentials are not browser credentials; browser applications need an authorized backend. Definition authoring is browser-bundleable.

Connection defaults follow `resolveConnection` (options → environment → Project
link). Implementation version defaults from `NYLORUN_IMPLEMENTATION_VERSION`,
then `dev`. `register` saves the definitions and registers one endpoint per
served agent with the application key; serving deliveries needs no key.
Agents do not hash the manifest, and an in-flight action is still delivered after
the registered digest changes. Model selection and model credentials belong to
the Tenant.

After registration, the Runtime POSTs each Action to the endpoint with a delivery token signed by the Tenant's key; the handler verifies it before any code runs and answers with the outcome. A background tool answers `202`, heartbeats with the newest token and posts its result. A cancel aborts the request, which reaches the tool as `ctx.signal`; JavaScript cannot forcibly terminate a function that ignores its signal. The host makes lost in-flight deliveries uncertain instead of automatically repeating external effects.

Tools receive state, info, identity, resume, signal, approval/response helpers and memoized `step`. Step outcomes survive a persisted wait result; they do not establish exactly-once external effects after an unacknowledged crash. `sleep` and `waitFor` currently return inspectable deferred outcomes; automatic timer/event wakeups remain runtime implementation work. Remote `onModelCall` convenience and progress-event transport are not supplied in this pass. Arbitrary middleware closures are rejected for durable definitions; use `before`/`after` hooks. The Action endpoint runs every capability registered at a hook point in one action. Agent definitions have no `.run()`; explicit local execution is available through `@nylorun/harness/run`.

## AG-UI

The Runtime serves the Tenant's agents to any [AG-UI](https://docs.ag-ui.com)
client (`@ag-ui/client`'s `HttpAgent`, CopilotKit, a desktop renderer) at
`/v1/ag-ui/agents/{agentId}` (optional feature `ag-ui-endpoint`). Each AG-UI
thread is one session per person, agent and thread. There are two ways in:

- **From your own server**, with `@nylorun/agents/ag-ui` (below): your server
  signs people in and the handler forwards each request to the Runtime acting
  for that person. The browser never sees the Runtime.
- **From the page itself**, with `@ag-ui/client`'s `HttpAgent` and a `fetch`
  that sends your identity provider's token
  ([In the browser](#in-the-browser)). No chat traffic passes through your
  server.

Both reach the same threads: one started through the handler continues from
the page.

```ts
import { createServer } from "node:http";
import { createAgUiHandler, toNodeListener } from "@nylorun/agents/ag-ui";
import support from "./agents/support.js";

const agui = createAgUiHandler({
  basePath: "/api/agui",
  agents: [support], // nothing else is reachable
  subject: async (request) => (await getSignedInUser(request))?.id, // undefined → 401
});

createServer(toNodeListener(agui)).listen(3000);
// Next.js, Hono, Bun, Deno, Workers: export or mount `agui.fetch` directly.
```

| Method and path under `basePath` | Operation |
| --- | --- |
| `POST /{agentId}` | Run: an AG-UI `RunAgentInput` in, server-sent events out |
| `GET /{agentId}/threads/{threadId}/messages` | History as a plain AG-UI `Message[]`, usable as `HttpAgent`'s `initialMessages` |
| `GET /{agentId}/threads/{threadId}/events` | Reattach: the rest of a run after a dropped connection, from `Last-Event-ID` (or `?cursor=`); `204` when nothing is left |
| `POST /{agentId}/threads/{threadId}/cancel` | Cancel the running turn |

`run`, `history`, `reattach` and `cancel` are also on the handler for your own
routing. The default `client` is `createClient()`; pass `client` to use another
one, and `session(subject, agentId)` to add the person's `vaultIds`,
`credentialSelections` or `info`. They apply when the thread's session is
created, on its first run; later runs keep them. Whatever the browser sends in
`forwardedProps.nylorun` is replaced.

- Each AG-UI message id is the command's idempotency key: a retried run replays
  the same turn instead of starting a second one.
- An approval ends the run with an AG-UI interrupt (`reason: "tool_approval"`,
  `toolCallId` the model's call id). Resume with
  `runAgent({ resume: [{ interruptId, status: "resolved", payload: { approved: true } }] })`.
  Other interactions answer with `payload` as the response.
- Every event that ends a group carries the Runtime cursor as its SSE `id`.
  `HttpAgent` does not reconnect by itself; call the reattach route with the
  last id you received.
- Closing the connection stops reading; it never cancels the turn.
- A busy or paused thread ends the run with `RUN_ERROR` code `session_busy`.
- The handler calls the Runtime as each person (`client.as(subject, { scopes })`,
  below), so the Runtime itself keeps one person out of another's threads.
  `scopes` defaults to `["sessions:own"]`. A `subject` the Runtime cannot name (see below)
  answers `500` (`subject_invalid`).
- The handler needs a Runtime with the optional feature `ag-ui-endpoint` and
  answers `502` (`runtime_feature_missing`) without it. It loads no AG-UI
  package itself: the Runtime does the protocol work.

A complete web backend with a test is in
[examples/src/ag-ui](../examples/README.md#an-agent-in-your-web-app-ag-ui).

Limitations: assistant text arrives once per model step (no token streaming);
no reasoning, state, activity or subagent events, and an agent used as a tool
shows only its result; frontend tools in `RunAgentInput.tools` are rejected
(`400`); one text part per user message; earlier messages cannot be edited or
regenerated. A browser reaches the Runtime only with a trusted issuer's token,
never with a key.

## A2A

`@nylorun/agents/a2a` serves the Tenant's agents to other agents over
[A2A](https://a2a-protocol.org) 1.0 (JSON-RPC) from your own server: the
gateway. Your server authenticates each partner and names the subject its tasks
belong to. The handler forwards each request to the Runtime, which speaks A2A,
so the handler loads no A2A package and parses no message.

```ts
import { createServer } from "node:http";
import { createA2aHandler, toNodeListener } from "@nylorun/agents/a2a";
import support from "./agents/support.js";

const a2a = createA2aHandler({
  basePath: "/a2a",
  agents: [support], // nothing else is reachable
  // undefined → 401; return { subject, agents } to give a partner fewer agents
  subject: (request) => partnerFor(request.headers.get("x-partner-key"))?.subject,
  publicUrl: "https://api.example.com/a2a", // for the card; default: the request's origin
  card: {
    provider: { organization: "Example Inc.", url: "https://example.com" },
    securitySchemes: {
      partnerKey: { apiKeySecurityScheme: { location: "header", name: "X-Partner-Key" } },
    },
    securityRequirements: [{ schemes: { partnerKey: { list: [] } } }],
  },
});

createServer(toNodeListener(a2a)).listen(3000);
```

| Method and path under `basePath` | Operation |
| --- | --- |
| `GET /{agentId}/.well-known/agent-card.json` | The Agent Card: name, description and one skill from the manifest, with this endpoint's URL and your provider and security schemes. Public; `subject` is not called |
| `POST /{agentId}` | One A2A JSON-RPC request, answered by the Runtime |

What the Runtime answers (Host feature `a2a-endpoint`):

- `SendMessage` waits until the task completes, fails, is canceled or asks
  for input, for at most 5 minutes (then it returns `WORKING`); with
  `configuration.returnImmediately` it returns at once and the partner polls
  `GetTask`. `CancelTask` works on a running task.
- A `contextId` is one session per partner, agent and context; a task is one
  turn. A message without `taskId` starts a task (one at a time per context).
  A question from the agent pauses the task as `TASK_STATE_INPUT_REQUIRED`
  with the question as the status message; the partner answers with a message
  on the same `taskId`.
- The `messageId` is the idempotency key: a retried message returns the same
  task.
- Text parts, or a single data part, in; the turn's output as the artifact
  `output` (text, or JSON as a data part). Files are
  `ContentTypeNotSupportedError`.
- Clients must send `A2A-Version: 1.0` (header or `?A2A-Version=`).
- Not yet: `ListTasks`, streaming and `SubscribeToTask`
  (`UnsupportedOperationError`; the card says `streaming: false`), push
  notifications, the extended card, and approvals. An agent that pauses for an
  approval shows `INPUT_REQUIRED`, refuses a reply, and can be canceled, so do
  not publish agents with approval-gated tools yet.
- The handler calls the Runtime as the partner's subject with the scope
  `sessions:own` only, so one partner never reaches another's tasks. It sends
  no header the partner chose except `A2A-Version` and `A2A-Extensions`. Without
  `a2a-endpoint` on the Runtime it answers `502` (`runtime_feature_missing`).

## Files: artifacts and message parts

Files users upload or agents make are **artifacts** (protocol 6): an id, a name and
numbered versions, kept by the Runtime. `client.artifacts` uploads a file in one
streamed request, lists, downloads with Range, mints capability links and deletes;
a message names files in its `parts`, and the model reads an image as an image and
a text file as text:

```ts
const { artifact } = await client.artifacts.upload(file, { name: "room.png", sessionId });
await session.inputParts(
  [{ type: "text", text: "Redesign this room" }, { type: "file", artifactId: artifact.artifactId }],
  { idempotencyKey: crypto.randomUUID() },
);

const files = await client.artifacts.list({ sessionId }); // what the user and the agent saved
const part = await client.artifacts.download(files[0].artifactId, { range: { start: 0, end: 1023 } });
const { url } = await client.artifacts.link(files[0].artifactId); // no credential needed, 5 minutes
```

A session with a sandbox gives the agent `save_artifact`, which saves a file it
made as an artifact of the session; each new artifact or version appears in the
session's events as `artifact.created` or `artifact.version.created`. The Tenant's
limits (`PUT /v1/tenant/artifacts`: 100 MiB per file and 10 GiB in all by default)
refuse a larger upload with `413 limit_exceeded`, and nothing is stored. Acting for
a person (`as()`, or a trusted issuer's token), a client reaches only the artifacts of that
person's sessions, and an upload names one of them.

### Outputs: folder artifacts

At the end of each turn, the Runtime exports the files the agent wrote into
`/workspace/outputs` of its sandbox as a version of the session's **folder**
artifact `outputs` (kind `folder`): the first export creates it, and each later
turn whose outputs changed adds a version, announced by `artifact.created` or
`artifact.version.created` with `source: "export"`. A file that did not change is
stored once. Read a folder as a tree, one file by path, a diff or a zip:

```ts
const outputs = (await client.artifacts.list({ sessionId })).find((a) => a.kind === "folder");
const { entries } = await client.artifacts.tree(outputs.artifactId); // [{ path, size, sha256, contentType }]
const page = await client.artifacts.file(outputs.artifactId, "app/index.html", { range: { start: 0 } });
const { added, removed, changed } = await client.artifacts.diff(outputs.artifactId, { from: 1 });
const zip = await client.artifacts.zip(outputs.artifactId); // a streamed Response
const { url } = await client.artifacts.link(outputs.artifactId, { file: "app/index.html" }); // or the zip without `file`
```

An export past a limit (10,000 files, 1 GiB, the per-file limit or the Tenant
total) stores nothing and records `artifact.export.skipped`; the turn still
completes.

## Acting for a person (app servers)

A server that signs people in and calls the Runtime for them (an "app server")
keeps its application key to itself and names the person on each call:

```ts
import { createClient } from "@nylorun/agents";

const app = createClient(); // the application key, on the server only

// Per request, after your own sign-in:
const person = app.as(`app:${user.id}`, { scopes: ["sessions:own"] });
await person.createSession({ agentId: "support", ownerUserId: `app:${user.id}` });
await person.listSessions(); // only this person's sessions
```

`as()` sends `Nylorun-Subject` and `Nylorun-Scopes` on every call, event
streams included, and the Runtime (optional feature `subject-headers`)
enforces both: another person's sessions answer the same `404` as missing
ones, and a route outside the scopes answers `403` (`scope_required`).
Nothing is minted, cached or refreshed, and the copy shares the client's
compatibility check, so calling `as()` per request is cheap.

| Scope | Allows |
| --- | --- |
| `sessions:own` | The person's own sessions: create, list, read, stream, message, approve, respond, cancel; and their artifacts |
| `agents:read` | Listing the Tenant's agents |
| `agents:write` | Saving agents; listing agents |

No scope reaches Action endpoints, actions or the sandbox tool routes; call
those without `as()`. `tenant:settings` is retired (protocol 8): it grants
nothing, and no subject reaches the Management API (`/v1/tenant/*`). Vaults are
the installation's, created through the Management API with a management key
(`admin.vaults.create({ scope: "installation", … })` in
[`@nylorun/admin`](../admin/README.md)); a session attaches them with
`vaultIds`, and a person's own credentials come from your credential resolver
([DEPLOYMENT.md](../DEPLOYMENT.md#credentials)). A subject is 1–200 visible ASCII
characters (spaces only inside) and `host` is reserved. Your server must drop
any `Nylorun-*` header its own clients send, and only an application key can act
for a subject.

The Tenant's signing keys sign delivery tokens and capability links.
`app.access.jwks()` reads the public keys (`GET /v1/access/jwks`, no key
needed), which `createActionHandler` verifies deliveries with. Listing, rotating
and revoking them is management: `admin.signingKeys.list()`, `.rotate()`
(`{ force: true }` for incidents) and `.revoke(kid)` in `@nylorun/admin`, or
`nylo access signing-keys …` from the terminal.

## In the browser

A web page or an app calls the Runtime directly with the JWT your identity
provider gave the person: list the provider in the Runtime's identity file
([Trusted issuers](../DEPLOYMENT.md#trusted-issuers)), and the Runtime takes the
token's subject, scopes, agents and sandbox grants from it. Nylorun mints no
token and ships no browser client: use your provider's SDK for sign-in and send
the token as `Authorization: Bearer <token>` with `Nylorun-Protocol`, through a
reverse proxy that answers CORS (the Runtime sends no CORS headers). An expired
token answers `401` with `code: "token_expired"`; `GET /v1/me` shows what a token
renders to. For a chat UI, give `@ag-ui/client`'s `HttpAgent` a `fetch` that adds
those headers.

The SDK depends only on core within the Nylorun packages; installing it does not install harness or any AG-UI or A2A package. Use `/define`, `/client`, `/ag-ui` or `/a2a` for focused imports, or the root for convenience. Studio uses `/client`. See [the adopted host contract](../harness/HOST_CONTRACT.md).

## Embedding Studio (desktop apps)

`@nylorun/agents/studio-embed` is the contract between Studio and an app that
shows it in an iframe. It exports the message schema
(`StudioEmbedMessageSchema`, envelope `{ type: "nylorun.studio", protocol, kind }`),
the login-token and session schemas, `STUDIO_EMBED_PROTOCOLS` and
`parseFrameAncestors`.

```ts
import { StudioEmbedMessageSchema } from "@nylorun/agents/studio-embed";

window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow || event.origin !== studioOrigin) return;
  const message = StudioEmbedMessageSchema.safeParse(event.data);
  if (!message.success) return;
  if (message.data.kind === "ready") frame.contentWindow!.postMessage(init, studioOrigin);
});
```

The embedder's backend mints the login token with the admin key
(`mintStudioLoginToken` in `@nylorun/admin`) and the page passes it to Studio in
`init`. No key reaches the page. Studio's origin allowlist is
`NYLORUN_STUDIO_FRAME_ANCESTORS`, empty by default: list your app's origins with
`nylorun start --studio-embed-origin <origin>`. The message `open.session`
(`{ sessionId }`) asks the embedding app to open that session in its own UI.
