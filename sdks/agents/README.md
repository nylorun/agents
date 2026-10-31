# @nylorun/agents

Runtime API client package: definition authoring and a session client. The Tenant's
settings, models, credential coverage, signing keys and application keys are the Management
API's, through [`@nylorun/admin`](../admin/README.md). Depends only on `@nylorun/core` among Nylorun
packages. A developer application's production tree should contain only this
package and `@nylorun/core` from Nylorun. Vocabulary:
[runtime/server/src/CONTEXT.md](../../runtime/server/src/CONTEXT.md).

## Application entry: save your agents' manifests

```ts
// src/main.ts
import { createClient } from "@nylorun/agents";
import { agents } from "../agents/index.js";

const client = await createClient();
for (const agent of agents) await client.agentManifests.save({ agent, runtime: { kind: "virtual" } });
// An Agent per person, made from the manifest's latest version; sessions run on it.
await client.agents.put(`users/${user.id}/support`, { manifest: "support", owner: user.id });
const session = await client.createSession({
  id: `support-${user.id}`, // ids are the app's: no session is special
  agent: `users/${user.id}/support`,
  ownerUserId: user.id,
});
```

The Runtime runs each agent entirely from its saved **agent manifest** and the files saved with
it (skills), so a session needs nothing from your process. Your services are reached as tools:
[HTTP tools](#http-tools) and remote MCP servers. `agentManifests.save({ agent, runtime })` makes
the manifest's harness section from the built agent, names it after the agent's id (or `name`)
and puts the runtime section beside it ([Agent manifests and Agents](#agent-manifests-and-agents)).
It refuses, before sending anything, an agent with a tool that would run your code
(`tool({ run })`) or a flow agent with a tool stage: make it an `http()` tool or serve it from a
remote MCP server. `tool({ run })` still runs in the local engine (`@nylorun/harness/run`).

`createClient()` finds the Runtime through the two `NYLORUN_*` variables or the Project link
that `npx nylorun start` writes; with neither, it fails with `connection_missing` and names
those steps. Action endpoints (`createActionHandler`), and before them `connectAgents` and
executors, were removed; see [MIGRATION.md](../../guides/MIGRATION.md#action-endpoints-are-removed).

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
  method: "POST", // default; or GET, PUT, PATCH, DELETE
  credential: "billing", // optional: a runtime.secrets slot (bearer or headers) bound to this URL
  timeoutMs: 20_000, // default 60000, at most 300000
});

export const support = Agent({ id: "support" }).tools(refundOrder);
```

The method decides where the input goes:

| Method                           | Request                                                        |
| -------------------------------- | -------------------------------------------------------------- |
| `POST` (default), `PUT`, `PATCH` | The input as the JSON body (`content-type: application/json`) |
| `GET`, `DELETE`                  | No body: the input as the query string                         |

The URL's path may name input fields as `{field}`. Each one must be a required string,
number or boolean field of `input`. Its value goes into the path percent-encoded (so `/`,
`?` and `#` cannot change the request), and it is not sent again in the body or query
string. A query string written in the URL is kept, and the input's fields come after it.
In the query string an array repeats its name (`tag=a&tag=b`) and a `null` is left out.

`http()`, and the Runtime when it saves a manifest, refuse a tool whose URL names a field
the input does not require. For `GET` and `DELETE` they also refuse a field that is an object (a query string cannot hold one), and a
field that repeats a query parameter the URL already sets. A call is refused before it is
sent (`tool.invalid-input`) when a URL value is empty, `.` or `..`, or not a string, number
or boolean.

```ts
// GET https://api.open-meteo.com/v1/forecast?current=…&latitude=22.57&longitude=88.36
const forecast = http({
  name: "get_forecast",
  description: "Current weather at a latitude and longitude.",
  input: z.object({
    latitude: z.number(),
    longitude: z.number(),
    temperature_unit: z.enum(["celsius", "fahrenheit"]).optional(),
  }),
  url: "https://api.open-meteo.com/v1/forecast?current=temperature_2m,relative_humidity_2m,wind_speed_10m&timezone=auto",
  method: "GET",
});

// DELETE https://billing.example.com/orders/A-17?reason=duplicate
const cancelOrder = http({
  name: "cancel_order",
  input: z.object({ orderId: z.string(), reason: z.string() }),
  url: "https://billing.example.com/orders/{orderId}",
  method: "DELETE",
  credential: "billing",
});
```

The tool goes into the manifest as `http`, and the Runtime's Tool Gate sends
the request under the Host's address policy (`NYLORUN_ENDPOINT_*`), with
`Nylorun-Session-Id`, `Nylorun-Turn-Id`, `Nylorun-Agent-Id` and an
`Idempotency-Key` that is the same when the Runtime re-sends the call after a
restart, so your service can drop duplicates. A `2xx` JSON answer is the output
(text when it is not JSON and the tool has no `output`), checked against
`output`. Any other status (with the start of its body), a timeout, a refused
address or a mismatched output is a tool error the model sees.

**How tool calls are delivered.** Each MCP or HTTP tool call the model decides
is sent at least once, and every send carries the same key: `Idempotency-Key`
for an HTTP tool, `_meta["nylorun/idempotency-key"]` on an MCP `tools/call`. A
crash, a restart or a lost connection to the gateway sends the call again with
that key, up to 3 sends; after that the model gets `tool.interrupted` ("may
have run") and decides. A tool that honors the key runs once; one that ignores
it may act twice, and `attempts` above 1 in `tool.completed` and in
`session.toolCalls()` marks where. Both also say where each call ran (`kind`:
`mcp`, `http`, `sandbox`, `platform` for the Runtime's own tools, or `harness`),
its `server`, the `skill` it ran and the `plugin` that brought its server or
skill. A sandbox command (`bash`, `write` and the
rest) is never run twice by the Runtime: a crash fails it to the model as
`tool.interrupted`. When the model decides the same call again, in a later
turn say, that is a new call with a new key: put a business key (an order or
charge id) in the tool's input schema to refuse it too.

`credential` works as for a remote MCP server: it names a `bearer` or `headers`
slot of the manifest's runtime section bound to the tool's exact URL (as written,
`{field}` parameters included; the Runtime checks it when the manifest is saved),
and the vault of the session's Agent must hold a value for it, else the call fails
before it is sent (`http.credential`). A credential with `via` sends the call there instead, such
as a gateway, with the session owner in its identity header (a gateway has one
URL, so a tool with `{field}` parameters fails with `http.credential`), and a `401` is `credential_rejected` to the model, not retried.
Whether a call waits for a person is not the tool's to say: it is the Tenant's
[tool policy](#tool-policy). An HTTP tool is also a flow stage (see [Flow agents](#flow-agents)), and runs
only on the Runtime (a local `run()` reports `http.runtime-only`).

## Tool policy

Which MCP and HTTP tool calls run, wait for a person, or are refused is the
Tenant's tool policy, set by the operator on the Management API with a
management key (`PUT /v1/tenant/tool-policy`, `admin.toolPolicy.put()` in
`@nylorun/admin`). The Runtime applies it to every call of every harness as it
journals the call, before anything is sent, and its Tool Gate runs only a call
the journal holds running, so a harness cannot skip it.

<!-- doc-test: tool-policy -->
<!-- doc-test: typescript -->
```ts
import { createAdmin } from "@nylorun/admin";

await createAdmin().toolPolicy.put({
  rules: [
    { effect: "ask", tool: "refund_order", reason: "Refunds need a person" },
    { effect: "deny", tool: "refund_order", when: { amount: { gt: 10_000 } } },
    { effect: "ask", server: "github", tool: "delete_*" },
  ],
});
```

A rule matches a call when every selector it sets matches: `tool` (the tool's
own name: an MCP tool's name on its server, such as `delete_file`, or an HTTP
tool's declared name; `*` matches any run of characters), `server` (an MCP
server's name), `kind` (`mcp` or `http`), `agent` (the agent that calls it) and
`when` (fields of the call's input by dotted path, each tested with `equals`,
`in`, `gt`, `gte`, `lt`, `lte` or `matches`). The strictest matching rule
decides, and a call no rule matches runs. Name an MCP tool by `server` and
`tool`, never by the name the model calls it by (`github__delete_file`): a
harness chooses that name, and a `tool` with `__` in it is refused (`400`).

- `deny`: the call is never sent; the model gets `tool.denied` with the rule's
  `reason`.
- `ask`: the turn pauses (`turn.paused`, with the tool, its input and the
  reason). `session.approve(interactionId, true)` sends that exact call;
  `false` fails it to the model as `tool.denied`, unsent (pass
  `{ idempotencyKey }` as a third argument to retry an answer safely). Nothing holds a
  process while it waits, so an approval can wait a day, or a Runtime restart.
  Studio shows an approval card; AG-UI ends the run with a `tool_approval`
  interrupt.
- `allow`: it runs.

Sandbox tools never cross the gate: their network side is egress policy. A
manifest no longer sets `approval` (the Runtime and `agentManifests.save` refuse it); a
session pinned to a manifest saved with `approval: "always"` keeps it, as an
ask, until it ends.

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
   `@nylorun/admin` and `nylorun` read them.

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
await client.agentManifests.save({ agent: assistant });
await client.agents.put("assistant", { manifest: "assistant" });
const session = await client.createSession({
  agent: "assistant",
  ownerUserId: authenticatedUser.id,
});
await session.input("Look up item 123", { idempotencyKey: requestId });
const history = await session.history();
```

Every request sets `Nylorun-Protocol` (16) and no `Nylorun-Tenant`: the Runtime
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

Each subdirectory under the catalog must contain a `SKILL.md` with YAML frontmatter (`name`, `description`) per [Agent Skills](https://agentskills.io/home). Its `secrets` (`secrets: [GH_TOKEN]`, environment variable names) are the skill's `secrets` in the harness section: the `runtime.secrets` slots its scripts read, of type `environment_secret` or `environment_variable`; a skill whose `secrets` is not such a list is skipped with a warning. `secrets` is not an Agent Skills key, so it is deprecated in `SKILL.md` (still read, with a `DeprecationWarning`): an agent folder lists a skill's secrets in `AGENT.md`'s skills block (`skills: { <name>: { secrets: [GH_TOKEN] } }`). Every file of a skill's folder, binary included (not `.git/`, `node_modules/`, OS files like `.DS_Store`, or `.env` and `.env.*` files, which hold secrets), is part of the definition: the manifest names each one by path and SHA-256 (`skills.<name>.files`). A skill's files may hold together at most the Tenant's skill limit (`PUT /v1/tenant/skills`, default 2 GiB); no file and no count of files has a limit of its own, and a manifest's runtime section may set a lower limit for its Agents' sessions (`runtime.limits.skills.totalBytes`). Skills need a sandbox: the runtime section's kind is `virtual` or `pod`, which the Runtime checks when the manifest is saved. `agentManifests.save` uploads the files the Runtime does not hold (`client.files`, `PUT /v1/files/sha256:<hex>`) before it saves the manifest, which the Runtime refuses while it names a file it lacks (`400 definition_files_missing`) or a skill past the Tenant's limit (`413 limit_exceeded`). `read_skill_resource` reads files of up to 10 MiB into the model's context; a larger one is used in the sandbox.

The Runtime serves the skills itself, with no call to your process. When our harness runs a turn, it adds the skill catalog to the instructions and two tools: `load_skill` returns a skill's `SKILL.md` body and the paths of its other files, and `read_skill_resource` returns a text file. A session with a sandbox also has each skill's files read-only under `/skills/<name>@<hash>/`, so the model can run a skill's scripts with `bash`.

Declare MCP servers with `.mcp(...)` (same map shape as agent-plugins `mcpServers`):

```ts
import { Agent } from "@nylorun/agents";

const assistant = Agent({ id: "assistant", name: "Assistant" })
  .instructions("Use the available tools.")
  .mcp({
    github: { type: "streamable-http", url: "https://mcp.example.com/github" },
  });
```

Each key names a server; its `name` defaults to the key and, when given, must equal it. Repeated `.mcp()` calls add servers to the manifest's `mcpServers`. Nylorun accepts remote servers only: `streamable-http` and `sse` ([Agent Plugins MCP servers](https://agent-plugins.org/plugin-authors/mcp-servers)); a `stdio` server is refused, so run it behind an HTTP transport and declare its URL. Attach an Agent Plugin package with `.plugin(path)`: its skills and remote MCP servers join the agent's `skills` and `mcpServers`, each labelled `plugin: { name, version }` from its `plugin.json`, and a stdio server in its `mcp.json` throws. Tool names, skill names and server names are each unique within their kind; a tool, a skill and a server may share a name, since a server's tools are called `<server>__<tool>`.

Set a server's tools one by one with `tools`, keyed by the server's own tool names, `"*"` for the rest: `{ "*": { enabled: false }, search_issues: { enabled: true }, create_issue: { enabled: true } }` is an allowlist (whether a call waits for a person is the [tool policy](#tool-policy)). When an agent's MCP tools would fill more than a tenth of the model's context window, the Runtime defers them: the model finds them with `tool_search` and runs them with `tool_call`. `deferred: true` or `false`, on a tool or on the server, decides instead.

A manifest never carries a server's credential, and its `headers` hold no secret. A server may name the runtime section's secret slot it authenticates with (`credential`: a `bearer` or `headers` slot bound to its URL, checked when the manifest is saved), and you write the credential into each Agent's vault (a token or a header map, or a gateway's key with `via`, its tool prefix (`toolPrefix`) and an identity header for servers that need each person's sign-in, with `client.agents.secrets.put`); the sessions on that Agent use it: [DEPLOYMENT.md](../../guides/DEPLOYMENT.md#mcp-servers-and-http-tools), which also shows `nylorun tenant mcp inspect` for listing a server's tools first. `admin.coverage({ agentId })` in `@nylorun/admin` says which credential each server and HTTP tool of an Agent's manifest version would get from its vault ([Checking an agent's credentials](../../guides/DEPLOYMENT.md#checking-an-agents-credentials)). The model knows each tool as `server__tool`, with characters outside `[A-Za-z0-9_-]` replaced by `_`; a failed call reaches it with a code (`credential_rejected` on a `401`, `mcp.unreachable`, …), and a result past 32 KiB, or an image, becomes an artifact of the session that it reads with `read_artifact`.

## Agent manifests and Agents

An **agent manifest** (v8, protocol 16) is one named, versioned document with two sections: `harness`, what runs inside the agent loop (the harness's `id`, `instructions`, `tools`, `skills`, `mcpServers`, `plugins`, `outputSchema`, the harness's own `loop` settings and the Agent's `memory`; or a flow, `kind: "workflow"`), and `runtime`, what the Runtime provides around it (`kind`, `image`, `network`, `setup`, `files`, `limits`, `lifecycle` and its secret slots, `secrets`). The Runtime checks the two against each other when the manifest is saved and refuses every gap at once (`422 manifest_inconsistent`, `details.gaps`): a custom harness off a pod, a `credential` or a skill's `secrets` that is no declared slot of the right type, skills on a runtime without a sandbox. A manifest without `runtime` makes Agents of kind `none`.

An **Agent** is the live instance of one version of a manifest: one environment of its runtime's kind, one vault, and the sessions that run on it, with an id you choose (`users/alice/triage`), which outlives them. It is made only from a saved manifest: `manifest: "triage"` tracks the manifest (its latest version when the Agent is made), `"triage@3"` pins version 3; either way it resolves the version once and keeps it. Every session runs on one Agent (`createSession({ agent })`), and no session is special: creating an Agent opens none, and the app picks session ids. Whether an Agent serves one person or a project is your app's choice:

```ts
// The manifest, from a built agent and the runtime section to run it in.
const manifest = {
  agent: analyst, // named after its id, "analyst"
  runtime: {
    kind: "pod" as const,
    image: "python:3.13-slim",
    network: { allowedHosts: ["pypi.org", "files.pythonhosted.org", "api.github.com"] },
    setup: [{ command: "pip install pandas" }],
    secrets: { GH_TOKEN: { type: "environment_secret" as const, allowedHosts: ["api.github.com"], required: true } },
  },
};
const plan = await client.agentManifests.plan(manifest); // from → to, changes, warnings, errors, Agents behind
await client.agentManifests.save(manifest, { ifMatch: plan.from ?? 0 }); // 412 manifest_changed if it moved

// One per person: get-or-create by id, write its secrets, open sessions on it.
await client.agents.put("users/alice/analyst", { manifest: "analyst", owner: "alice", labels: { team: "data" } });
await client.agents.secrets.put("users/alice/analyst", "GH_TOKEN", { value: process.env.ALICE_GITHUB_TOKEN! });
const session = await client.createSession({ id: "alice-q3", agent: "users/alice/analyst", ownerUserId: "alice" });
```

`agentManifests.save(input, { ifMatch, requestId })` and `plan(input, { ifMatch })` (a dry run that saves nothing) take a v8 document, what `composeManifest` read, or `{ agent, runtime?, harness?, loop?, memory?, name?, description?, metadata? }`: the SDK makes the harness section from the built agent or flow (`harnessSectionOf`, exported for code that builds a manifest itself, with its skills' `secrets`; `harness` is the harness's id; `memory`, `{ access?, instructions? }`, turns on an agent's memory, not a flow's) and names the manifest after the agent's id. First it uploads every file the manifest names by hash that the Runtime does not hold: the agent's skills, a flow's agents' skills, and the runtime's files (`runtimeFiles(path, contents)` hashes a `files` entry; pass its `bytes` as `files`). `If-Match` is the version you read (`0` for a new manifest). A save that changes nothing answers the latest version, `unchanged`. `get(name, version?)`, `list()`, `versions(name)` (with the Agents made from each) and `delete(name)` (refused while an Agent was made from it: `409 manifest_in_use`) read and remove them.

### Agent folders: `packFolder`, `checkFolder`, `saveFolder`

An agent is best written as a folder of Markdown and JSON (tracks T6 and T7): `AGENT.md` with `name`, `description` and the instructions, and beside it `mcp.json`, `runtime.json`, `skills/`, `tools/`, `triggers/` and `files/` as it needs them. `agents/<id>/` holds subagents (each offered to the agent as a tool), `flow.json` makes the folder a flow whose stages name those agents by id, and `plugins/<name>/` vendors an Agent Plugin; [the CLI's README](../../cli/nylorun/README.md#agent-manifests-apply) shows each. `packFolder(dir)` (Node only) lists every file with its size and SHA-256, skipping `.git`, `node_modules` and what the folder's `.nyloignore` names (gitignore rules, `ignoreMatcher`), and resolves `"extends"` in `runtime.json` (the packed file is the merge, the folder's own keys winning); `checkFolder(folder)` compiles it offline with the Runtime's compiler (`@nylorun/core/folder`) and returns `{ manifest?, diagnostics, compiler }`, each diagnostic with its file, line and column (`diagnosticLine` formats one). `agentManifests.saveFolder(folder, { ifMatch })` and `planFolder` compile it first, refuse one that does not compile (`FolderInvalidError`), upload the files the Runtime lacks and send the folder by hash; the Runtime keeps it as the version's source, which `source(name, version)` and `sourceFile(name, version, path)` read back, and `sourceDiff(name, from, to)` compares two versions' sources: the files added, removed and changed, by hash. `folderOfManifest(manifest)` goes the other way: the folder that compiles back to a saved manifest (what `nylorun export --folder` writes).

<!-- doc-test: typescript -->
```ts
import { createClient, packFolder } from "@nylorun/agents";

const client = await createClient();
const plan = await client.agentManifests.planFolder(await packFolder("agents/triage"));
console.log(plan.manifest, plan.diagnostics); // the compiled manifest, and e.g. the derived GITHUB_TOKEN slot
await client.agentManifests.saveFolder(await packFolder("agents/triage"), { ifMatch: plan.from ?? 0 });
```

### Three files: `composeManifest` (deprecated)

The three-file form is deprecated in favour of agent folders: `composeManifest` and `nylorun apply` still read it, and warn, and `npx nylorun migrate folder <dir>` writes the agent folder of a three-file folder, with its skills, offline. A folder's `runtime.json` shares a runtime between agents with `"extends"`.

A manifest can be authored as three files, so a runtime is shared by many agents and skills stay folders. `composeManifest(dir)` (Node only) reads `<dir>/agent.manifest.json` and the files it names, each path relative to the file that names it, and returns `{ manifest, files, gaps, warnings }`; `agentManifests.save` takes it as it is and uploads `files`. `npx nylorun apply <dir>` does the same from the command line.

```jsonc
// agents/triage/agent.manifest.json
{ "manifestSchemaVersion": 8, "name": "triage", "harness": "./harness.manifest.json", "runtime": "../../shared/runtime.manifest.json" }

// agents/triage/harness.manifest.json
{
  "instructions": ["Triage each new issue."],
  "skills": "./skills",                      // each subfolder with a SKILL.md is a skill; its secrets, the frontmatter's
  "mcpServers": "./mcp.json",                // the Agent Plugins format
  "plugins": ["../../plugins/github"],       // folded in as .plugin() folds it
  "credentials": { "linear": "linear" },     // MCP server or HTTP tool → runtime.secrets slot
  "memory": { "access": "read_write" },     // turns on the Agent's memory
  "requires": { "sandbox": "any", "secrets": ["GH_TOKEN"] } // checked here only
}

// shared/runtime.manifest.json
{
  "kind": "pod",
  "files": [{ "path": "/workspace/kit", "from": "./kit" }], // a folder, uploaded by hash
  "secrets": {
    "GH_TOKEN": { "type": "environment_secret", "allowedHosts": ["api.github.com"] },
    "linear": { "type": "bearer", "url": "https://mcp.linear.app/mcp" }
  }
}
```

```ts
import { composeManifest, createClient } from "@nylorun/agents";

const composed = await composeManifest("agents/triage");
if (composed.gaps.length > 0) throw new Error(composed.gaps.join("\n"));
await client.agentManifests.save(composed);
```

`gaps` names where the runtime misses the harness file's `requires` (`sandbox: "any"` needs kind `virtual` or `pod`, `"pod"` a pod; each of `secrets` a declared slot) and the gaps the Runtime would refuse it for (`sectionGaps`). `requires`, `credentials` and every `$schema` stay out of the document; a `credentials` name that is no server or HTTP tool, or a file that does not validate, throws `ComposeError`. JSON Schemas for editors: `@nylorun/core/schemas/agent-manifest.json`, `harness-manifest.json` and `runtime-manifest.json`.

### Agents

With a sandbox (kind `virtual` or `pod`), the model gets `bash`, `read`, `write`, `edit`, `grep` and `glob` on a persistent `/workspace`. These tools run in the Runtime, not in your process. A `virtual` Agent's environment is an emulated shell in the Runtime's harness, which is not a VM boundary and takes no `image`; a `pod` runs `image` with its own volume (`storage`) once the Tenant has sandbox pods (`nylorun local sandbox enable`). Kind `none` has a vault and no sandbox, for agents that use only remote MCP servers and HTTP tools.

An Agent runs one version of its manifest at a time and evolves in place, with its id, disk, vault and sessions: a `put` on an existing one may change its `labels` and `owner` guard and moves it to the version its `manifest` names (`"name"` tracks the latest, `"name@n"` pins), `plan(id, input)` answers what that move would do, and a save of a new version moves every Agent that tracks the manifest. A harness change applies at once (each session's next turn runs it); a pod's runtime change waits for its next start on the same volume (`targetVersion`, `waitingFor: "start"`; `restart(id)` applies it now), and a start that fails goes back to the version it ran (`failedVersion`; `restart(id, { retry: true })` tries again). A version that adds a required secret waits for its value (`waitingFor: "secrets"`). `list({ outdated: true })` lists the Agents still moving. Its manifest's name, kind, harness and storage are fixed (`409 agent_fixed_field`): `fork(id, { id: next, manifest? })` makes a new Agent (default the source's manifest, tracking), with the source's disk (`disk`: `latest`, a version, or `empty`) and the secrets the new manifest declares (`secrets: "none"` copies none), and `planFork` answers what a fork would do. The Runtime checks the runtime section against the Tenant's limits (`GET`/`PUT /v1/tenant/sandbox`: a network ceiling, a resource maximum, the idle timeout; `/v1/tenant/artifacts` and `/v1/tenant/skills` for its `limits`). `lifecycle.idle` stops a pod after that long without a turn (at most the Tenant's); `lifecycle.deleteAfter` deletes the Agent, its vault and its files once nothing has used it that long. Private networks, loopback, the host and cloud metadata endpoints are always blocked.

Secrets are write-only: `client.agents.secrets.put(id, name, secret)` creates or replaces one, and `list`, `get` and `delete` never return a value. When the manifest declares the secret's slot (`runtime.secrets`), send only `{ value }` (or `{ headers }`): the type and binding come from the slot, and a name it does not declare is `409 secret_not_in_manifest`. Typed, an `environment_secret` (`{ value, allowedHosts, inject? }`) shows its name to commands as the sentinel `nylorun_managed`, and egress-gate sets its header on HTTPS requests to `allowedHosts` (pods only); an `environment_variable` (`{ value }`) is a plain variable; `bearer` (`{ url, value, via?, toolPrefix?, identity? }`) and `headers` (`{ url, headers, via?, toolPrefix?, identity? }`) are credentials for the MCP servers and HTTP tools at `url`. A second secret for one host, or a second credential for one URL, is `409 credential_conflict` at the write ([DEPLOYMENT.md](../../guides/DEPLOYMENT.md#credentials)).

Sessions on one Agent share its `/workspace` and run their turns at the same time (one turn per session); which sessions work on one disk, and when, is your app's call. Stop, reset, snapshot and restore wait until no turn runs (`409 agent_busy`). Deleting a session only detaches it. With `owner` set, a session of another owner is `403 agent_owner_mismatch` (a caller acting for a person gets the `404` of a missing Agent), checked when it opens and at every turn start. An Agent's view says what it runs (`manifest`, `resolvedVersion`, `tracking`), its `state` (`working`, `sleeping`, `input_required`, `failing` or `paused`, `AGENT_STATES`) with the sessions behind it (`attention`), its compute (`compute.state`) and its slots. `client.agents.list({ labels, state, manifest })`, `page`, `get(id)`, `events(id, { types, since, until })` (its lifecycle, and `agent.egress` for every connection its sandbox opens, naming the turns that were running), `stop(id)`, `reset(id)` and `delete(id)` manage them, and `npx nylorun agents list | put | rm` does the same from the command line. Acting for a person (`app.as(...)`), changing an Agent or its secrets needs `agents:write`, and saving a manifest `agent-manifests:write`. A trusted issuer's token reaches only the Agents its issuer grants (the identity file's `agents` templates, exact ids or prefixes ending in `/*`), checked at every turn start. The Tenant holds at most `limits.environments` of them (`PUT /v1/tenant/sandbox`, default 100).

A pod's disk can start prepared: the runtime's `files` are copied in (artifact versions, or files by hash), then `setup` runs its commands, once per new disk and before its first turn (a failed command fails the pod, and the next turn start runs the setup again). Between turns, `client.agents.snapshot(id)` keeps a version of the disk, `restore(id, version)` puts one back (a pod on a new volume seeded before its next turn), `put(newId, { manifest, from: { agent: id, version: "latest" } })` starts a new Agent from it, and `versions(id)` and `deleteVersion(id, n)` manage them ([DEPLOYMENT.md](../../guides/DEPLOYMENT.md#agents)):

```ts
const { version } = await client.agents.snapshot("projects/acme");
await client.agents.put("projects/acme-try", { manifest: "acme", from: { agent: "projects/acme", version } });
```

## Subagents

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

Delegate when the parent should keep the answer. When a specialist should own the rest of the conversation, send the next message with a turn manifest that has the specialist's instructions instead. This version is one level deep and non-interactive: a delegated agent cannot use agents as tools, and cannot pause for input, an approval or a wait (keep those on the parent). In the local engine (`@nylorun/harness/run`), a delegated agent's `tool({ run })` tools start with empty `ctx.state`, can read `ctx.agent` (`{ id, path, delegationId }`), and fail with `delegation.interaction-unsupported` on `ctx.ask`, `ctx.approve`, `ctx.sleep` or `ctx.waitFor`. Delegation is not an approval boundary.

## Flow agents

An agent's body is either a ReAct loop (the model decides) or a flow (its manifest
decides). A flow agent is built from stages and is saved and run like any agent: put it in
`export const agents`, `agentManifests.save({ agent: flowAgent, runtime })`, make an Agent from
the manifest, then `createSession({ agent })` and `session.input(value)`. `input` sends string values as
`content` and other JSON as `data`. On the wire a flow agent is a workflow manifest v3
(`kind: "workflow"`, `workflowSchemaVersion: 3`) that embeds the agents it runs, so one
document and one manifest hash cover the whole flow; its agents are not listed on their own.
In an agent manifest it is the harness section, `harness.kind: "workflow"`. A flow can also
be an [agent folder](#agent-folders-packfolder-checkfolder-savefolder): `flow.json` holds the
same node tree, naming its agents (each an `agents/<id>/` folder) by id, and the compiler
embeds each agent where the manifest needs it
([`examples/agents/repo-brief-folder/`](../../examples/agents/repo-brief-folder/) is the Repo
brief flow as a folder).

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

The Tenant's [tool policy](#tool-policy) decides a flow's HTTP stages as it decides an
agent's HTTP tool calls: an `ask` rule on `open_pr` pauses the flow's turn until a person
approves the call, and the flow session's `pending()` lists the wait.

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
`Nylorun-Agent-Id` set to the flow agent's id and `credential` taken from the
vault of the flow session's Agent; its answer is the next stage's input. A failure status, a timeout or
an answer that does not match `output` fails the stage with its code (`http.status`,
`http.timeout`, `tool.invalid-output`, …). A Loop body that starts with an HTTP stage
is retried with the Loop's input, not the feedback.

A Loop may be judged by your service instead of an agent: `http({ url, method?,
credential?, timeoutMs? })`, with no name or input, is an HTTP verifier. Its method is
`POST`, `PUT` or `PATCH` and its URL has no `{field}` parameters, because the Runtime
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
engine: the Runtime runs flows from their manifests alone, so `agentManifests.save` refuses a
flow agent with one. Use an HTTP stage instead.

A flow runs on its Agent: every linked session in the flow runs on the Agent the flow's
session runs on, with its sandbox and vault; turns within one flow do not block each other.
Other sessions on the same Agent share its sandbox. Call the sandbox
built-ins via `session.sandbox` (application).
Observe with `session.observe({ follow: true })` to merge linked agent streams;
`pending()` lists waits across the tree. Studio renders the manifest tree and
live node status. Source examples:
`examples/agents/{chain,switch,parallel,map,loop,ship-feature}/` (outside the
default release registry). Host contract:
[HOST_CONTRACT.md](../../runtime/harness/HOST_CONTRACT.md). Vocabulary (turn loop vs
workflow Loop): [runtime/harness/src/CONTEXT.md](../../runtime/harness/src/CONTEXT.md).

Use `session.observe({ cursor, signal })` for resumable canonical events (a connection that sends nothing, not even its 15-second keepalive, for `idleTimeoutMs`, default 45 s, is dropped and reopened from the last event's `Last-Event-ID`; `0` never times out), `session.inspect()` for waiting/uncertain state, and `approve`, `respond` or `cancel` to answer or stop a turn. `cancel` takes an idempotency key; `approve(interactionId, approved)` and `respond(interactionId, value)` make one of their own when given none, so give them a stable one (`{ idempotencyKey }`) when you may retry. Retry the same semantic command with the same key. `ownerUserId` must come from trusted server authentication. Application credentials are not browser credentials; browser applications need an authorized backend. Definition authoring is browser-bundleable.

Connection defaults follow `resolveConnection` (options → environment → Project
link). Agents do not hash the manifest; a session pins the manifest version its Agent runs
when it opens, and the digest of the loop manifest made from it. Model selection and model credentials belong to
the Tenant.

The Runtime sends a lost MCP or HTTP tool call again with the same key, then fails it to the
model as `tool.interrupted` (see **How tool calls are delivered**).
In the local engine (`@nylorun/harness/run`), `tool({ run })` tools receive state, info,
identity, resume, signal, approval/response helpers and memoized `step`. Agent definitions
have no `.run()`; explicit
local execution is available through `@nylorun/harness/run`.

## AG-UI

The Runtime serves the Tenant's agents to any [AG-UI](https://docs.ag-ui.com)
client (`@ag-ui/client`'s `HttpAgent`, CopilotKit, a desktop renderer) at
`/v1/ag-ui/agents/{agentId}` (optional feature `ag-ui-endpoint`), where `agentId` is an
Agent's id (`client.agents`). Each AG-UI thread is one session per person, Agent and thread,
on that Agent. There are two ways in:

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
  agents: ["support"], // Agent ids: nothing else is reachable
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
one, and `session(subject, agentId)` to add the session's `info`. It applies when the thread's
session is created, on its first run; later runs keep it. The session runs on the Agent the path
names, with its sandbox and its vault's credentials: to give each person their own keys, serve
each person's Agent (`users/<id>/support`) and route to it. Whatever the browser sends in
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
[examples/src/ag-ui](../../examples/README.md#an-agent-in-your-web-app-ag-ui).

Limitations: assistant text arrives once per model step (no token streaming);
no reasoning, state, activity or subagent events, and an agent used as a tool
shows only its result; frontend tools in `RunAgentInput.tools` are rejected
(`400`); one text part per user message; earlier messages cannot be edited or
regenerated. A browser reaches the Runtime only with a trusted issuer's token,
never with a key.

## A2A

`@nylorun/agents/a2a` serves the Tenant's Agents to other agents over
[A2A](https://a2a-protocol.org) 1.0 (JSON-RPC) from your own server: the
gateway. Your server authenticates each partner and names the subject its tasks
belong to. The handler forwards each request to the Runtime, which speaks A2A,
so the handler loads no A2A package and parses no message.

```ts
import { createServer } from "node:http";
import { createA2aHandler, toNodeListener } from "@nylorun/agents/a2a";
const a2a = createA2aHandler({
  basePath: "/a2a",
  agents: ["support"], // Agent ids: nothing else is reachable
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
- A `contextId` is one session per partner, Agent and context, on that Agent; a task is one
  turn. A message without `taskId` starts a task (one at a time per context).
  A question from the agent pauses the task as `TASK_STATE_INPUT_REQUIRED`
  with the question as the status message; the partner answers with a message
  on the same `taskId`.
- The `messageId` is the idempotency key: a retried message returns the same
  task.
- Text parts, a single data part, or text and `raw` file parts in (at most
  20 MiB each, stored as artifacts of the context's session); the turn's
  output as the artifact `output` (text, or JSON as a data part). A file by
  `url` is `ContentTypeNotSupportedError`; a file of any type is accepted, and
  the agent's harness decides how its model sees it.
- Clients must send `A2A-Version: 1.0` (header or `?A2A-Version=`).
- Before Host feature `a2a-profile-v2`: no `ListTasks`, push notifications or
  approvals. An agent that pauses for an approval shows `INPUT_REQUIRED`,
  refuses a reply, and can be canceled, so on such a Runtime do not publish
  agents whose tools the Tenant's tool policy asks about. Never: streaming and
  `SubscribeToTask` (`UnsupportedOperationError`; the card says
  `streaming: false`) and the extended card.
- The handler calls the Runtime as the partner's subject with the scope
  `sessions:own` only, so one partner never reaches another's tasks. It sends
  no header the partner chose except `A2A-Version` and `A2A-Extensions`. Without
  `a2a-endpoint` on the Runtime it answers `502` (`runtime_feature_missing`).

### Calling an agent: the A2A client

`createA2aClient` calls one A2A agent's JSON-RPC endpoint: a Runtime's
`/v1/a2a/agents/{agentId}`, a gateway's, or any A2A 1.0 agent. It sends
`A2A-Version: 1.0` and activates the
[Nylorun profile v2](https://docs.nylorun.com/a2a/profile/v2) extensions with
`A2A-Extensions` (all five by default). It is plain `fetch` and loads no A2A
package; it is also exported from the package root.

<!-- doc-test: typescript -->
```ts
import { createA2aClient, readInteraction, readProgress } from "@nylorun/agents/a2a";

const a2a = createA2aClient({
  url: "https://agents.example.com/v1/a2a/agents/coding",
  key: process.env.NYLORUN_SERVER_KEY, // Authorization: Bearer
  subject: "u:org_1:user_1", // Nylorun-Subject, with Nylorun-Scopes: sessions:own
});

const task = await a2a.send({
  messageId: crypto.randomUUID(), // the idempotency key: a retry answers the same task
  parts: [{ text: "Build the portal from the wikis" }],
  returnImmediately: true,
  push: { url: "https://bot.example.com/a2a/push", token: "per-task-token" },
});

const latest = await a2a.get(task.id, { historyLength: 0 });
console.log(readProgress(latest)?.steps);
const open = readInteraction(latest); // an approval pauses the task as AUTH_REQUIRED
if (open?.kind === "approval")
  await a2a.answer({
    taskId: latest.id,
    contextId: latest.contextId,
    interactionId: open.interactionId,
    approved: true,
    messageId: crypto.randomUUID(),
  });
```

| Method | A2A operation |
| --- | --- |
| `send({ messageId, contextId?, taskId?, parts, metadata?, extensions?, delivery?, push?, returnImmediately?, historyLength?, traceparent? })` | `SendMessage`, answered with the task. A message to a busy context is queued; `delivery: "reject"` asks for `CONTEXT_BUSY` instead. `traceparent` joins the task to your trace |
| `get(taskId, { historyLength? })` | `GetTask` |
| `list({ contextId?, status?, statusTimestampAfter?, pageSize?, pageToken? })`, `listAll(...)` | `ListTasks`: one page, or every task page after page |
| `cancel(taskId)` | `CancelTask` |
| `answer({ taskId, contextId, interactionId, approved? \| value?, messageId })` | Answers an open interaction under `interactions/v1`: `approved` for an approval or a connection, `value` for a question |
| `card()` | The Agent Card: `{url}/card` on a Runtime, else `{url}/.well-known/agent-card.json` (`cardUrl` overrides) |
| `call(method, params)` | Any other JSON-RPC method |

An error the agent answers in JSON-RPC is thrown as `A2aError` with its
`code` (e.g. `-32001`), `message` and `reason` from `google.rpc.ErrorInfo`
(e.g. `TASK_NOT_FOUND`, `CONTEXT_BUSY`). An HTTP refusal (`401`, an unknown
agent's `404`, `429`) is a `RuntimeError` with its `status`.

**Pushes.** Each delivery is a `POST` of one A2A `StreamResponse`, signed with
[Standard Webhooks](https://www.standardwebhooks.com) and the installation's
`whsec_` webhook secret. Verify the raw body before you parse it:

<!-- doc-test: typescript -->
```ts
import { createServer } from "node:http";
import { A2aPushVerificationError, readFiles, readTelemetry, verifyA2aPush } from "@nylorun/agents/a2a";

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    const update = await verifyA2aPush({
      secret: process.env.A2A_PUSH_SECRET!, // whsec_…
      headers: req.headers,
      body: Buffer.concat(chunks).toString("utf8"),
      token: "per-task-token", // optional: X-A2A-Notification-Token must match
    });
    // Order status updates by status.timestamp: a delivery may come twice or late.
    if ("statusUpdate" in update) console.log(update.statusUpdate.status.state, readTelemetry(update));
    if ("artifactUpdate" in update) console.log(readFiles(update));
    res.writeHead(204).end();
  } catch (error) {
    res.writeHead(error instanceof A2aPushVerificationError ? 401 : 500).end();
  }
}).listen(3000);
```

`verifyA2aPush` checks `webhook-id`, `webhook-timestamp` (at most
`toleranceSeconds`, default 300, from now, either way) and every `v1,`
signature in `webhook-signature` (several are allowed, as during a rotation),
in constant time with Web Crypto, and returns the parsed `StreamResponse`. A
failure is `A2aPushVerificationError` with its `reason`.

**Profile v2 readers.** Each takes a task, a `StreamResponse`, a status
update, a status, a message or an artifact, and returns `undefined` (`[]` for
files) when the data is missing, as from an agent outside Nylorun:

| Reader | Extension (`A2A_EXTENSIONS`) | Returns |
| --- | --- | --- |
| `readInteraction` | `interactions` | `{ interactionId, kind, prompt?, detail? }`: `approval`, `question` or `connection` |
| `readProgress` | `progress` | `{ steps: [{ label, state, note? }] }`, the whole plan |
| `readTelemetry` | `telemetry` | `{ totals?: { steps, tokens, costUsd }, traceId? }`, on the terminal update |
| `readEffects` | `effects` | `{ uncertain? }`: the effect whose outcome was lost |
| `readFiles` | `files` | `[{ artifact, file: { kind, path?, version?, size?, sha256? } }]` |
| `readExtension(source, uri)` | any | The raw data under `uri` |

**The change feed.** `listTurnChanges` reads a Runtime's `GET /v1/turns`
(Host feature `turns`): the turns that changed after a cursor, in the order
they changed. Poll it with the last `cursor` to find what a lost push would
have said:

<!-- doc-test: typescript -->
```ts
import { listTurnChanges } from "@nylorun/agents";

let cursor: string | undefined;
const page = await listTurnChanges({
  baseUrl: "https://agents.example.com",
  key: process.env.NYLORUN_SERVER_KEY!, // the whole Tenant; add `subject` for one subject's turns
  ...(cursor ? { changedAfter: cursor } : {}),
  limit: 200,
});
for (const turn of page.turns) console.log(turn.status, turn.a2a?.taskId, turn.totals?.costUsd);
cursor = page.cursor; // returned even when nothing changed
```

The A2A 1.0 types (`Task`, `Message`, `Part`, `Artifact`,
`TaskStatusUpdateEvent`, `TaskArtifactUpdateEvent`, `StreamResponse`,
`AgentCard`, `ListTasksResult`, `TaskState`) are exported from
`@nylorun/agents/a2a`, and from the root as the namespace `A2a` (`A2a.Task`).

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
limits (`PUT /v1/tenant/artifacts`: 100 MiB per file and 10 GiB in all by default),
and those a manifest's runtime section sets for its Agents' artifacts (`runtime.limits.artifacts`,
at most the Tenant's), refuse a larger upload with `413 limit_exceeded`, and nothing
is stored. Acting for
a person (`as()`, or a trusted issuer's token), a client reaches only the artifacts of that
person's sessions, and an upload names one of them.

Hosts advertising `artifact-reads` also support bounded metadata pages, newest
first. `artifacts.page()` defaults to 50 rows (1–200), checks feature discovery,
and returns `{ artifacts, nextCursor }`. Pass the same filters on every page:

```ts
const filters = { kind: "file" as const, labels: { team: "design" } };
let cursor: string | undefined;
do {
  const page = await client.artifacts.page({ ...filters, cursor });
  for (const artifact of page.artifacts) console.log(artifact.name, artifact.latestVersion);
  cursor = page.nextCursor ?? undefined;
} while (cursor);
```

Omit `sessionId` for all reachable artifacts, including Tenant-owned artifacts
when using an application key as itself. With `sessionId`, only that session's
artifacts are included; acting for a person also applies ownership and agent
grants on every page. Every label must match exactly. Pages omit version histories
and bytes: use `get()` and the existing version/download methods for those.
Cursors bind to the Tenant and filters. Pages are independent reads; refresh from
the beginning for newer artifacts. The existing unbounded `list()` keeps its
oldest-first behavior and does not require `artifact-reads`.

### Outputs: folder artifacts

At the end of each turn, our harness saves the files the agent wrote into
`/workspace/outputs` of its sandbox as a version of the session's **folder**
artifact `outputs` (kind `folder`): the first save creates it, and each later
turn whose outputs changed adds a version, announced by `artifact.created` or
`artifact.version.created` with `source: "engine"` (`"export"` before protocol 15). A file that did not change is
stored once. Read a folder as a tree, one file by path, a diff or a zip:

```ts
const outputs = (await client.artifacts.list({ sessionId })).find((a) => a.kind === "folder");
const { entries } = await client.artifacts.tree(outputs.artifactId); // [{ path, size, sha256, contentType }]
const page = await client.artifacts.file(outputs.artifactId, "app/index.html", { range: { start: 0 } });
const { added, removed, changed } = await client.artifacts.diff(outputs.artifactId, { from: 1 });
const zip = await client.artifacts.zip(outputs.artifactId); // a streamed Response
const { url } = await client.artifacts.link(outputs.artifactId, { file: "app/index.html" }); // or the zip without `file`
```

A save past a limit (the Runtime limit `folderEntries`, 10,000 files by default;
1 GiB, our harness's own bound; the per-file limit or the Tenant total) stores
nothing, and our harness records `artifact.export.skipped`; the turn still
completes.

## Acting for a person (app servers)

A server that signs people in and calls the Runtime for them (an "app server")
keeps its application key to itself and names the person on each call:

```ts
import { createClient } from "@nylorun/agents";

const app = await createClient(); // the application key, on the server only

// Per request, after your own sign-in:
const person = app.as(`app:${user.id}`, { scopes: ["sessions:own"] });
await person.createSession({ agent: `users/${user.id}/support`, ownerUserId: `app:${user.id}` });
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
| `agents:read` | Reading the Tenant's agent manifests and Agents |
| `agents:write` | Creating, changing, stopping, resetting and deleting Agents, and writing their secrets (reading them takes `sessions:own` or this) |
| `agent-manifests:write` | Saving and deleting agent manifests |

No scope reaches the sandbox tool routes; call them without `as()`. `tenant:settings` is retired (protocol 8): it grants
nothing, and no subject reaches the Management API (`/v1/tenant/*`).
`environments:write` is refused with a message naming `agents:write` (protocol 16).
Credentials live in Agents' vaults: the server writes a person's own keys into
their Agent (made with `owner` set to them) and opens their sessions on it
([DEPLOYMENT.md](../../guides/DEPLOYMENT.md#credentials)). A subject is 1–200 visible ASCII
characters (spaces only inside) and `host` is reserved. Your server must drop
any `Nylorun-*` header its own clients send, and only an application key can act
for a subject.

The Tenant's signing keys sign capability links and run tokens.
`app.access.jwks()` reads the public keys (`GET /v1/access/jwks`, no key
needed). Listing, rotating
and revoking them is management: `admin.signingKeys.list()`, `.rotate()`
(`{ force: true }` for incidents) and `.revoke(kid)` in `@nylorun/admin`, or
`nylorun tenant signing-keys …` from the terminal.

## In the browser

A web page or an app calls the Runtime directly with the JWT your identity
provider gave the person: list the provider in the Runtime's identity file
([Trusted issuers](../../guides/DEPLOYMENT.md#trusted-issuers)), and the Runtime takes the
token's subject, scopes and Agent grants from it. Nylorun mints no
token and ships no browser client: use your provider's SDK for sign-in and send
the token as `Authorization: Bearer <token>` with `Nylorun-Protocol`, through a
reverse proxy that answers CORS (the Runtime sends no CORS headers). An expired
token answers `401` with `code: "token_expired"`; `GET /v1/me` shows what a token
renders to. For a chat UI, give `@ag-ui/client`'s `HttpAgent` a `fetch` that adds
those headers.

The SDK depends only on core within the Nylorun packages; installing it does not install harness or any AG-UI or A2A package. Use `/define`, `/client`, `/ag-ui` or `/a2a` for focused imports, or the root for convenience. Studio uses `/client`. See [the adopted host contract](../../runtime/harness/HOST_CONTRACT.md).

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
