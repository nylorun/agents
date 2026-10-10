# @nylorun/agents

Runtime API client package: definition authoring and a session client. The Tenant's
settings, models, vaults, signing keys and application keys are the Management
API's, through [`@nylorun/admin`](../admin/README.md). Depends only on `@nylorun/core` among Nylorun
packages. A developer application's production tree should contain only this
package and `@nylorun/core` from Nylorun. Vocabulary:
[runtime/src/CONTEXT.md](../runtime/src/CONTEXT.md).

## Application entry: save your agents

```ts
// src/main.ts
import { createClient } from "@nylorun/agents";
import { agents } from "../agents/index.js";

const client = createClient();
for (const agent of agents) await client.saveAgent(agent);
```

The Runtime runs each agent entirely from its manifest and the files saved with it
(skills), so a session needs nothing from your process. Your services are reached as tools: [HTTP
tools](#http-tools) and remote MCP servers. `saveAgent` refuses, before sending anything, an
agent with a tool that would run your code (`tool({ run })`) or a flow agent with a tool
stage: make it an `http()` tool or serve it from a remote MCP server. `tool({ run })` still
runs in the local engine (`@nylorun/harness/run`). `implementationVersion` defaults to
`NYLORUN_IMPLEMENTATION_VERSION`, else `dev`.

`createClient()` finds the Runtime through the two `NYLORUN_*` variables or the Project link
that `npx nylorun start` writes; with neither, it fails with `connection_missing` and names
those steps. Action endpoints (`createActionHandler`), and before them `connectAgents` and
executors, were removed; see [MIGRATION.md](../guides/MIGRATION.md#action-endpoints-are-removed).

## HTTP tools

A tool can be one HTTP request to your service, made by the Runtime itself: no code of
yours runs during the session.

```ts
import { Agent, http } from "@nylorun/agents";
import { z } from "zod";

const refundOrder = http({
  name: "refund_order",
  description: "Refund an order.",
  input: z.object({ orderId: z.string(), amount: z.number() }), // or a JSON Schema object
  output: z.object({ refundId: z.string() }), // optional
  url: "https://billing.example.com/refunds",
  method: "POST", // default; or PUT, PATCH
  credential: "billing", // optional: a vault credential bound to this URL
  timeoutMs: 20_000, // default 60000, at most 300000
  approval: "always", // optional: each call waits for session.approve()
});

export const support = Agent({ id: "support" }).tools(refundOrder);
```

The tool goes into the manifest as `http` (and `approval`), and the Runtime's
Tool Gate sends the model's input as the JSON body, under the Host's address
policy (`NYLORUN_ENDPOINT_*`), with `content-type: application/json`,
`Nylorun-Session-Id`, `Nylorun-Turn-Id`, `Nylorun-Agent-Id` and an
`Idempotency-Key` that is the same when the Runtime re-sends the call after a
restart, so your service can drop duplicates. A `2xx` JSON answer is the output
(text when it is not JSON and the tool has no `output`), checked against
`output`. Any other status (with the start of its body), a timeout, a refused
address or a mismatched output is a tool error the model sees. A call whose
answer was lost with the gateway is `uncertain` and never sent again.

`credential` works as for a remote MCP server: the session's attached vaults
must hold a credential bound to the tool's exact URL (a `credentialSelections`
entry whose `serverName` is the `credential` picks one when several are), else
the call fails before it is sent (`http.credential`). A credential with `via`
sends the call there instead, such as a gateway, with the session owner in its
identity header, and a `401` is `credential_rejected` to the model, not retried. `approval: "always"` pauses the turn for `session.approve()`; a
denied call never runs and the model sees the denial. A remote MCP server takes
`approval: "always"` too, for every one of its tools:
`.mcp({ shop: { type: "streamable-http", url, approval: "always" } })`.
An HTTP tool is also a flow stage (see [Flow agents](#flow-agents)), and runs
only on the Runtime (a local `run()` reports `http.runtime-only`).

## Connection resolution

`resolveConnection` / `createClient()`:

1. Explicit `{ url, key }`
2. Environment — if `NYLORUN_RUNTIME_URL` or `NYLORUN_SERVER_KEY` is set, both
   must be present
3. Project link — `.nylorun/link.json` + `credentials.json` (the application
   key), written by `npx nylorun start`, in the nearest directory with
   `.nylorun/` from `cwd` upwards (never the home directory or above it, whose
   `.nylorun/` is the Nylorun home). A link from an older nylorun
   (format 0 to 2), a link without credentials, or a file that does not
   validate fails with `connection_missing`: run `npx nylorun start` in the
   project again. The Project files are read by `@nylorun/core/project`, as
   `@nylorun/admin`, `nylorun` and `nylo` read them.

Sources never mix. Partial environment fails with `connection_missing`. A
Runtime serves one Tenant, so nothing names it: the `tenant` option is gone
(protocol 5), and `NYLORUN_TENANT`, which picks a local Tenant for `nylorun`,
is ignored.

```ts
import { Agent, createClient, http } from "@nylorun/agents";
import { z } from "zod";

const assistant = Agent({ id: "assistant", name: "Assistant" })
  .instructions("Use the available tools.")
  .tools(
    http({
      name: "lookup",
      input: z.object({ id: z.string() }),
      url: "https://items.example.com/lookup",
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
```

```sh
eval "$(npx -p nylorun nylo env)"
# → NYLORUN_RUNTIME_URL, NYLORUN_SERVER_KEY
```

Every request sets `Nylorun-Protocol` (8) and no `Nylorun-Tenant`: the Runtime
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

Each subdirectory under the catalog must contain a `SKILL.md` with YAML frontmatter (`name`, `description`) per [Agent Skills](https://agentskills.io/home). Every file of a skill's folder, binary included (not `.git/`, `node_modules/`, OS files like `.DS_Store`, or `.env` and `.env.*` files, which hold secrets), is part of the definition: the manifest names each one by path and SHA-256 (`skills.<name>.files`), at most 500 files of 10 MiB each. `saveAgent` uploads the files the Runtime does not hold (`client.files`, `PUT /v1/files/sha256:<hex>`) before it puts the definition, which the Runtime refuses while it names a file it lacks (`400 definition_files_missing`).

The Runtime serves the skills itself, with no call to your process: `load_skill` returns a skill's `SKILL.md` body and the paths of its other files, and `read_skill_resource` returns a text file. A session with a sandbox also has each skill's files read-only under `/skills/<name>/`, so the model can run a skill's scripts with `bash`. Run without a Runtime, the skill tools only say so.

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

Set a server's tools one by one with `tools`, keyed by the server's own tool names, `"*"` for the rest: `{ "*": { enabled: false }, search_issues: { enabled: true }, create_issue: { enabled: true, approval: "always" } }` is an allowlist with one approval. When an agent's MCP tools would fill more than a tenth of the model's context window, the Runtime defers them: the model finds them with `tool_search` and runs them with `tool_call`. `deferred: true` or `false`, on a tool or on the server, decides instead. Either setting makes the manifest v6 (see MIGRATION.md).

A manifest never carries a server's credential, and its `headers` hold no secret. The operator gives the server's URL a vault credential (a token or a header map, or a gateway's key with `via` and an identity header for servers that need each person's sign-in), and the session's attached vaults supply it: [DEPLOYMENT.md](../guides/DEPLOYMENT.md#mcp-servers-and-http-tools), which also shows `nylorun mcp inspect` for listing a server's tools first. The model knows each tool as `server__tool`, with characters outside `[A-Za-z0-9_-]` replaced by `_`; a failed call reaches it with a code (`credential_rejected` on a `401`, `mcp.unreachable`, …), and a result past 32 KiB, or an image, becomes an artifact of the session that it reads with `read_artifact`.

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

The model gets `bash`, `read`, `write`, `edit`, `grep` and `glob` on a persistent `/workspace`. These tools run in the Runtime, not in your process. The Runtime decides where the sandbox runs: today an emulated shell in the Runtime process, which is not a VM boundary and takes no `image`.

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

The tool is named after the agent's `id` and takes `{ task: string }`; the agent's `description` (required) is what the parent's model reads to decide when to delegate. The child starts with a fresh context: it sees its own instructions and the task, nothing of the parent's conversation, and only its final text (or `outputSchema` result) comes back. It keeps its own tools, skills and MCP servers, saved with the parent, and shares the session's sandbox. Several delegation calls in one model response run in parallel. An empty answer, a failure (with the child's last text marked as evidence) or a cancelled child reaches the parent's model as a failed tool result, never as success. The Runtime emits `delegation.started` and `delegation.completed`; `session.history({ agent })` filters by `delegationId` (one child invocation) or by path such as `support/researcher` (every concurrent child that shares that path).

A flow agent can be a subagent too: `.subagents(researchFlow)` with a `description` like any other. Its manifest is inlined in the parent's, so it is saved with the parent. When the model calls it, the flow runs on the Runtime in its own linked session (a fresh one per call, linked from the parent's with a `node.agent` event at `support/<flow id>`), its agents in theirs, and the flow's output comes back as the tool result; a failed flow is a failed tool result. Cancelling the parent cancels the flow. Flow agents as subagents run on the Runtime only, not in a local `run()`. An approval asked for inside the flow waits on the flow's own session.

Delegate when the parent should keep the answer. When a specialist should own the rest of the conversation, send the next message with a turn manifest that has the specialist's instructions instead. This version is one level deep and non-interactive: a delegated agent cannot use agents as tools, and its tools cannot declare `approval` (keep those on the parent). In the local engine (`@nylorun/harness/run`), a delegated agent's `tool({ run })` tools start with empty `ctx.state`, can read `ctx.agent` (`{ id, path, delegationId }`), and fail with `delegation.interaction-unsupported` on `ctx.ask`, `ctx.approve`, `ctx.sleep` or `ctx.waitFor`. Delegation is not an approval boundary; approvals live on tools.

## Flow agents

An agent's body is either a ReAct loop (the model decides) or a flow (its manifest
decides). A flow agent is built from stages and is registered, saved and opened as a
session like any agent: put it in `export const agents`, `saveAgent(flowAgent)`, then
`createSession({ agentId })` and `session.input(value)`. `input` sends string values as
`content` and other JSON as `data`. On the wire a flow agent is a workflow manifest v3
(`kind: "workflow"`, `workflowSchemaVersion: 3`) that embeds the agents it runs, so one
document and one manifest hash cover the whole flow; its agents are not listed on their own.

A flow passes data between its stages itself: the first stage gets the flow's input, and
every later stage gets the previous stage's output. So each agent returns, through its
`.output()` schema, what the next stage needs.

```ts
import { Agent, VerdictSchema, http } from "@nylorun/agents";
import { z } from "zod";

const planner = Agent({ id: "planner" })
  .instructions("Return { items: string[] }, one task each.")
  .output(z.object({ items: z.array(z.string()) }));

const coder = Agent({ id: "coder" })
  .instructions("Implement one task. Return { summary }.")
  .output(z.object({ summary: z.string() }));

const reviewer = Agent({ id: "reviewer" })
  .instructions("Pass the response when its summary says what changed.")
  .output(VerdictSchema);

const prWriter = Agent({ id: "pr-writer" })
  .instructions("Return the summaries you are given as { summaries }.")
  .output(z.object({ summaries: z.array(z.string()) }));

// Your service serves POST /pull-requests and answers { url }.
const openPr = http({
  name: "open_pr",
  input: z.object({ summaries: z.array(z.string()) }),
  output: z.object({ url: z.string() }),
  url: "https://ci.example.com/pull-requests",
  credential: "github",
});

export const shipFeature = Agent({ id: "ship-feature" })
  .pipe(planner)
  .map(Agent({ id: "code" }).loop(coder, { verify: reviewer, max: 2 }), { id: "implement" })
  .pipe(prWriter, openPr);

export const agents = [shipFeature];
```

A flow stage cannot take `approval` yet (`flow.approval-unsupported`). To have a person
approve opening the PR, give the HTTP tool to an agent as the last stage instead: that
agent's turn pauses until the call is approved, and the flow session's `pending()` lists
the wait:

```ts
const prOpener = Agent({ id: "pr-opener" })
  .instructions("Open one pull request with open_pr from the summaries you are given.")
  .tools(
    http({
      name: "open_pr",
      description: "Open a pull request with the given summaries.",
      input: z.object({ summaries: z.array(z.string()) }),
      url: "https://ci.example.com/pull-requests",
      credential: "github",
      approval: "always",
    }),
  );

// …
  .pipe(prWriter, prOpener);
```

| Stage | Role |
| --- | --- |
| **`.pipe(a, b, …)`** | Run agents, tools or `flow()`s in order; each one's output is the next one's input |
| **`.switch({ ...cases, default? })`** | Run the case the previous output names: a string, or its `route` field |
| **`.parallel(branches)`** | Fixed named branches at once, same input; output is an object |
| **`.map(each)`** | Run `each` once per item of the previous output: an array, or its `items`; output is an array |
| **`.loop(body, { verify, max })`** | Run `body`, ask `verify` (an agent, or `http({ url })`), run again with its feedback until it passes, at most `max` times |

Every stage takes `{ id }` to name it (`.loop` takes it beside `verify` and `max`).
`flow()` builds a sequence with no id for a case, branch, map item or loop body that
is more than one step. A verifier agent gets `{ task, response, iteration }` and returns
a verdict, `{ pass, feedback? }` (`VerdictSchema`), with feedback when it fails; the
verdict is recorded as a `loop.verified` event. An agent after the first stage also
sees the flow's input, as the original request, before its own input. Types flow from
each stage's `.output()` schema to the flow agent's output. `.step(x, { id })` is a
deprecated alias for `.pipe(x.withId(id))`.

An [HTTP tool](#http-tools) is a stage too: in `.pipe()`, a case, a Map item or a Loop
body. Its input is the previous output, which must match the tool's `input` (an
object); a mismatch the build can see, such as an agent with no `.output()` before it,
is refused (`flow.input-mismatch`), and any other fails the stage when it runs
(`tool.invalid-input`). The Runtime makes the request as for an agent's HTTP tool, with
`Nylorun-Agent-Id` set to the flow agent's id and `credential` taken from the flow
session's vaults; its answer is the next stage's input. A failure status, a timeout or
an answer that does not match `output` fails the stage with its code (`http.status`,
`http.timeout`, `tool.invalid-output`, …). A Loop body that starts with an HTTP stage
is retried with the Loop's input, not the feedback. `approval: "always"` is not
supported on a flow stage yet (`flow.approval-unsupported`).

A Loop may be judged by your service instead of an agent: `http({ url, method?,
credential?, timeoutMs? })`, with no name or input, is an HTTP verifier. The Runtime
sends `{ input, output, iteration }` (the Loop's input, the attempt's output, its
number) and reads a verdict, `{ pass, feedback? }`, from the answer; anything else, or a
failed request, fails the Loop (`loop.verify-failed`). Its verdicts are recorded as
`loop.verified`, as an agent's are.

```ts
import { Agent, http } from "@nylorun/agents";
import { z } from "zod";

const order = Agent({ id: "order" })
  .instructions("Name the order to refund as { orderId }.")
  .output(z.object({ orderId: z.string() }));

const refund = http({
  name: "refund",
  input: z.object({ orderId: z.string() }),
  output: z.object({ refundId: z.string() }),
  url: "https://billing.example.com/refunds",
  credential: "billing",
});

const fixer = Agent({ id: "fixer" }).instructions("Fix the failing test.");

export const refunds = Agent({ id: "refunds" }).pipe(order, refund);
export const fixTests = Agent({ id: "fix-tests" }).loop(fixer, {
  verify: http({ url: "https://ci.example.com/verify", credential: "ci" }),
  max: 3,
});
```

Agents inside a flow keep their own sessions, linked from the flow's session and
named by the agent: its id (or `.withId("…")`), with `[i]` for each Map item and a
nested flow agent's id in front of its own agents'. Control stages add nothing, so
wrapping a step in `.loop()` or moving it between cases keeps its session. An agent
may appear once per flow; use it again under a new id with `writer.withId("final-writer")`
(`flow.duplicate-leaf`). A code tool stage (`.pipe(tool({ run }))`) runs only in the local
engine: the Runtime runs flows from their manifests alone, so `saveAgent` refuses a flow
agent with one. Use an HTTP stage instead.

The agents in a flow share one sandbox: open the flow's session with it,
`createSession({ …, sandbox: { … } })`, and every agent in the flow uses it. Share it
with other sessions by opening them all on one sandbox resource
(`sandbox: { id }`, see `client.sandboxes`), and call
built-ins via `session.sandbox` (application).
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
then `dev`. Agents do not hash the manifest; the Runtime pins the digest of the
definition a session opens with. Model selection and model credentials belong to
the Tenant.

The Runtime makes a lost HTTP tool call `uncertain` instead of repeating its external effect.
In the local engine (`@nylorun/harness/run`), `tool({ run })` tools receive state, info,
identity, resume, signal, approval/response helpers and memoized `step`. Arbitrary middleware
closures are rejected for durable definitions. Agent definitions have no `.run()`; explicit
local execution is available through `@nylorun/harness/run`.

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

No scope reaches the sandbox tool routes; call them without `as()`. `tenant:settings` is retired (protocol 8): it grants
nothing, and no subject reaches the Management API (`/v1/tenant/*`). Vaults are
the installation's, created through the Management API with a management key
(`admin.vaults.create({ scope: "installation", … })` in
[`@nylorun/admin`](../admin/README.md)); a session attaches them with
`vaultIds`, and a person's own keys go in their user vault
([DEPLOYMENT.md](../guides/DEPLOYMENT.md#credentials)). A subject is 1–200 visible ASCII
characters (spaces only inside) and `host` is reserved. Your server must drop
any `Nylorun-*` header its own clients send, and only an application key can act
for a subject.

The Tenant's signing keys sign capability links and run tokens.
`app.access.jwks()` reads the public keys (`GET /v1/access/jwks`, no key
needed). Listing, rotating
and revoking them is management: `admin.signingKeys.list()`, `.rotate()`
(`{ force: true }` for incidents) and `.revoke(kid)` in `@nylorun/admin`, or
`nylo access signing-keys …` from the terminal.

## In the browser

A web page or an app calls the Runtime directly with the JWT your identity
provider gave the person: list the provider in the Runtime's identity file
([Trusted issuers](../guides/DEPLOYMENT.md#trusted-issuers)), and the Runtime takes the
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
