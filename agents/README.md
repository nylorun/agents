# @nylorun/agents

Tenant API client package: definition authoring, a session client, and a
connected customer executor. Depends only on `@nylorun/core` among Nylorun
packages. A developer application's production tree should contain only this
package and `@nylorun/core` from Nylorun. Vocabulary:
[runtime/src/CONTEXT.md](../runtime/src/CONTEXT.md).

## Application entry (preferred)

```ts
// src/main.ts
import { connectAgents } from "@nylorun/agents";
import { agents } from "../agents/index.js";

await connectAgents({ agents }).ready;
```

Application mode saves definitions, registers **derived** executor credentials
(HMAC of the application key + Tenant + agent id), and connects. Restarts and
replicas re-register the same hashes; tokens are never stored in the Project.
The same entry runs under `nylorun dev` and as `node dist/src/main.js`
(`npm start`). See [MIGRATION.md](../MIGRATION.md#runtime-clients-and-admin-api-breaking-beta)
for upgrading from `nylorun serve`.

## Connection resolution

`resolveConnection` / `createClient()` / `connectAgents({ agents })`:

1. Explicit `{ url, tenant, key }`
2. Environment — if any of `NYLORUN_RUNTIME_URL`, `NYLORUN_TENANT`,
   `NYLORUN_SERVER_KEY` or `NYLORUN_EXECUTOR_KEY` is set, all required pieces
   must be present (role `executor` when `NYLORUN_EXECUTOR_KEY` is set)
3. Project link — `.nylorun/link.json` + `credentials.json` (application role)

Sources never mix. Partial environment fails with `connection_missing`.

```ts
import { Agent, createClient, connectAgents, tool } from "@nylorun/agents";
import { z } from "zod";

const assistant = Agent({
  id: "assistant",
  name: "Assistant",
  instructions: "Use the available tools.",
  tools: [
    tool({
      name: "lookup",
      input: z.object({ id: z.string() }),
      async run({ id }, ctx) {
        return { id, owner: ctx.info };
      },
    }),
  ],
});

// Explicit Tenant API client (options or env / link via createClient()).
const client = createClient({
  url: process.env.NYLORUN_RUNTIME_URL,
  key: process.env.NYLORUN_SERVER_KEY,
  tenant: process.env.NYLORUN_TENANT,
});
await client.saveAgent(assistant, { implementationVersion: "app-1" });
const session = await client.createSession({
  agentId: assistant.id,
  ownerUserId: authenticatedUser.id,
});
await session.input("Look up item 123", { idempotencyKey: requestId });
const history = await session.history();

// Executor-only mode when you already hold an executor key:
const connection = connectAgents({
  agents: [assistant],
  implementationVersion: "app-1",
  runtime: {
    url: process.env.NYLORUN_RUNTIME_URL,
    key: process.env.NYLORUN_EXECUTOR_KEY,
    tenant: process.env.NYLORUN_TENANT,
  },
  onError: console.error,
});
await connection.ready;
await connection.close();
```

```sh
eval "$(npx nylorun runtime status --env)"
# → NYLORUN_RUNTIME_URL, NYLORUN_SERVER_KEY, NYLORUN_TENANT
```

Every request sets `Nylorun-Tenant` and `Nylorun-Protocol`. A `tenant` field in a
body or query is never read from caller input. Before the first authenticated
request, `Transport` fetches `/health` once, checks protocol compatibility, and
throws `IncompatibleRuntimeError` / `incompatible_host` when the Host range or
required features do not match. Re-exports include `PROTOCOL_FEATURES`,
`ERROR_CODES` and `compareVersions`.

Load Agent Skills from a local catalog folder with `skills(path)`:

```ts
import { Agent, skills } from "@nylorun/agents";

const assistant = Agent({
  id: "assistant",
  name: "Order assistant",
  instructions: "Use lookup_order for orders.",
  tools: [lookupOrder],
}).use(skills("./assistant-skills"));
```

Each subdirectory under the catalog must contain a `SKILL.md` with YAML frontmatter (`name`, `description`) per [Agent Skills](https://agentskills.io/home). Supporting files (for example `references/`) are available through `read_skill_resource` after `load_skill`. The helper sets both the manifest skill catalog and the on-disk skill records so you do not duplicate content.

Declare MCP servers with `mcp(...)` (same map shape as agent-plugins `mcpServers` / manifest v3):

```ts
import { Agent, mcp } from "@nylorun/agents";

const assistant = Agent({
  id: "assistant",
  name: "Assistant",
  instructions: "Use the available tools.",
}).use(
  mcp({
    github: {
      name: "github",
      type: "streamable-http",
      url: "https://mcp.example.com/github",
    },
  }),
);
```

Each key must equal that server's `name`. Transports follow [Agent Plugins MCP servers](https://agent-plugins.org/plugin-authors/mcp-servers): `stdio`, `streamable-http`, and `sse`. Pass `{ id: "…" }` as the second argument to override the default capability id `"mcp"`.

Give an agent an isolated computer with `sandbox()`:

```ts
import { Agent, sandbox } from "@nylorun/agents";

const analyst = Agent({
  id: "analyst",
  instructions: "Analyse the data the user gives you. Use Python.",
}).use(sandbox());
```

The model gets `bash`, `read`, `write`, `edit`, `grep` and `glob` on a Linux machine with a persistent `/workspace`. These tools run in the Runtime, not in your process, so sandbox-only agents need no connected executor. The agent declares what it needs; the Runtime decides where it runs (today an emulated shell in the Runtime process). Every option is optional plain data:

```ts
.use(sandbox({
  image: "python:3.13",                           // any OCI image; default python:3.13-slim
  network: { preset: "dev", allow: ["api.example.com"] }, // "none" | "dev" (default) | "open"
  resources: { cpus: 2, memory: "2GiB" },
  idle: "15m",                                    // stop compute when idle; files persist
}))
```

The `dev` preset allows package registries and code hosts. Private networks, loopback, the host and cloud metadata endpoints are always blocked. Options from the full design that are not in this version (`setup`, `files`, `secrets`, `mount`, `onStart`, …) throw a `SandboxError` that says so.

Put an agent in another agent's `tools` to let the model delegate to it:

```ts
import { Agent } from "@nylorun/agents";
import { z } from "zod";

const researcher = Agent({
  id: "researcher",
  description:
    "Investigates an order's history. Returns a short summary with the ids it relied on.",
  instructions:
    "Investigate one question about one order. Be exhaustive, then be brief.",
  tools: [searchOrders, readTicket],
  outputSchema: z.object({
    summary: z.string(),
    evidence: z.array(z.string()),
  }),
});

const support = Agent({
  id: "support",
  instructions:
    "For anything needing more than two lookups, delegate to researcher with a complete, self-contained task.",
  tools: [lookupOrder, refundOrder, researcher],
});
```

The tool is named after the agent's `id` and takes `{ task: string }`; the agent's `description` (required) is what the parent's model reads to decide when to delegate. The child starts with a fresh context: it sees its own instructions and the task, nothing of the parent's conversation, and only its final text (or `outputSchema` result) comes back. It keeps its own tools, hooks, skills and MCP servers, served by the executor you already run for the parent (`connectAgents({ agents: [support] })` serves both), shares the session's sandbox, and starts with empty `ctx.state`. Tools can read `ctx.agent` (`{ id, path, delegationId }`). Several delegation calls in one model response run in parallel. An empty answer, a failure (with the child's last text marked as evidence) or a cancelled child reaches the parent's model as a failed tool result, never as success. The Runtime emits `delegation.started` and `delegation.completed`; `session.history({ agent })` filters by `delegationId` (one child invocation) or by path such as `support/researcher` (every concurrent child that shares that path).

Delegate when the parent should keep the answer. When a specialist should own the rest of the conversation, switch capabilities with a `before("step")` patch instead. This version is one level deep and non-interactive: a delegated agent cannot use agents as tools, its tools cannot declare `approval` (keep those on the parent), and `ctx.ask`, `ctx.approve`, `ctx.sleep` or `ctx.waitFor` inside it fail with `delegation.interaction-unsupported`. Delegation is not an approval boundary; approvals live on tools.

## Workflows

Nest `Chain`, `Switch`, `Parallel`, `Map`, and `Loop` around agents and `tool()` to
build durable flows. A workflow is a definition with `kind: "workflow"`: register
it in `export const agents` (or `saveAgent(workflow)` — referenced agents are
saved first), then `createSession({ agentId })` and `session.input(value)` like
any agent. `input` sends string values as `content` and other JSON as `data`.
`connectAgents({ agents: [workflow] })` saves the tree and connects executors for
the workflow id and every referenced agent. Tool nodes, pure functions (slot
`input`, Switch `on`, Map `over`, Loop `decide`), and Loop `verify` run as Actions
routed by `(workflowId, key)`.

```ts
import { Agent, Chain, Loop, Map, tool } from "@nylorun/agents";
import { z } from "zod";

const planner = Agent({
  id: "planner",
  instructions: "Return { tasks: string[] }.",
  outputSchema: z.object({ tasks: z.array(z.string()) }),
}).build();

const coder = Agent({
  id: "coder",
  instructions: "Implement one task. Return { summary }.",
  outputSchema: z.object({ summary: z.string() }),
}).build();

const openPr = tool({
  name: "open-pr",
  input: z.object({ summaries: z.array(z.string()) }),
  async run({ summaries }, ctx) {
    if (!(await ctx.approve("Open the PR?"))) throw new Error("Rejected");
    return { opened: true, count: summaries.length };
  },
});

export const shipFeature = Chain({
  id: "ship-feature",
  steps: [
    planner,
    Map({
      id: "implement",
      over: (plan) => plan.tasks,
      each: Loop({
        id: "code",
        run: coder,
        verify: () => ({ pass: true }),
        decide: ({ output }) => ({ output }),
      }),
    }),
    {
      run: openPr,
      input: ({ value }) => ({
        summaries: value.map((item: { summary: string }) => item.summary),
      }),
    },
  ],
});

export const agents = [shipFeature];
```

| Primitive | Role |
| --- | --- |
| **Chain** | Steps in order; slots reshape with `{ run, id?, input? }` |
| **Switch** | Pure `on(input) → key`, then the matching case (or `default`) |
| **Parallel** | Fixed named branches at once; output is an object |
| **Map** | Pure `over(input) → items`, one child per item; output is an array |
| **Loop** | `run` → `verify` → `decide` until `{ output }` |

Agents inside a workflow keep their own sessions (linked from the workflow
session) and share one sandbox: declare identical specs on every agent that
uses one, attach with `createSession({ …, sandbox: { session } })`, call
built-ins via `session.sandbox` (application) or `ctx.sandbox` (executor).
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
then `dev`. Application mode of `connectAgents({ agents })` registers derived
executor principals; executor-only mode still takes an explicit executor key.
Agents do not hash the manifest, and an in-flight action stays claimable after
the registered digest changes. Model selection and model credentials belong to
the Tenant.

After registration, `connectAgents` opens authenticated fetch SSE before discovering actions, rediscovers after reconnection, and claims pending actions for a connected agent id. It renews leases while executing, then retries HTTP result delivery with the same recorded outcome and idempotency key. Reconnect delay is bounded at 30 seconds. Notifications confer no execution authority. There is no periodic action-discovery polling. Close aborts the stream, HTTP requests and lease timers and signals running functions; JavaScript cannot forcibly terminate a function that ignores its signal. The host makes expired in-flight actions uncertain instead of automatically repeating external effects.

Tools receive state, info, identity, resume, signal, approval/response helpers and memoized `step`. Step outcomes survive a persisted wait result; they do not establish exactly-once external effects after an unacknowledged crash. `sleep` and `waitFor` currently return inspectable deferred outcomes; automatic timer/event wakeups remain runtime implementation work. Remote `onModelCall` convenience and progress-event transport are not supplied in this pass. Arbitrary middleware closures are rejected for durable definitions; use `before`/`after` hooks. The executor runs every capability registered at a hook point in one action. Agent definitions have no `.run()`; explicit local execution is available through `@nylorun/harness/run`.

The SDK depends only on core within the Nylorun packages; installing it does not install harness. Use `/define`, `/client`, or `/executor` for focused imports, or the root for convenience. Studio uses `/client`. See [the adopted host contract](../harness/HOST_CONTRACT.md).
