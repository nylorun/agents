# Harness examples

The default registry exports three agents from `agents/release/`: an order-lookup assistant, a data analyst with a sandbox, and the [Repo brief](#repo-brief-every-piece-in-one-flow), which puts every piece the Runtime runs from a manifest into one flow agent. `src/main.ts` saves each as an agent manifest (`client.agentManifests.save`, with the virtual runtime in [`runtime/scratch.runtime.json`](./runtime/scratch.runtime.json)) and makes an Agent of it (`client.agents.put`, named after the agent), which the Runtime runs; Studio uses the session HTTP/SSE API. [Triage](#triage-an-agent-folder) is an agent written as an agent folder, Markdown and JSON instead of TypeScript, and [`agents/repo-brief-folder/`](./agents/repo-brief-folder/) is the Repo brief as one. A new agent starts as a folder: `npx nylorun init agents/<name> --example`, then `npx nylorun apply agents/<name> --agent` and `npx nylorun chat <name>` ([the CLI's README](../cli/nylorun/README.md#agent-manifests-apply)).

The Runtime runs no code of this project during a session. The assistant's `lookup_order` is an HTTP tool (`http()` in [`agents/shared/orders.ts`](./agents/shared/orders.ts)): the Runtime POSTs the tool's input to the examples' tools service, [`src/tools/server.ts`](./src/tools/server.ts), and gives the model its JSON answer. The service also answers the Repo brief's `publish_brief` and the [tools catalog](./agents/shared/tools/catalog) (`calculate`, `convert`, `now`). It listens on `TOOLS_PORT` (default 3001); the agents call it at `TOOLS_URL` (default `http://localhost:3001`, which a local Tenant's Runtime reaches on this machine).

The nine older demonstrations remain as source references under `agents/`, outside the release registry. Their descriptions below are historical and do not establish support in the new host. Tool Use, Subagents, Instructions, Skills, Remote MCP and the flow agents (`chain`, `switch`, `parallel`, `map`, `loop`, `ship-feature`) declare nothing the Runtime refuses. Interactions, PTC (programmatic tool calling), Coding Agent and Interior Design run code of their own (tools with `execute`) and run only in the local engine (`@nylorun/harness/run`), as their tests do: the Runtime refuses to save them.

## Install and configure

Use the repository toolchain in [CONTRIBUTING.md](../CONTRIBUTING.md). From the repository root:

```sh
npm run setup
npm run dev
```

Root development rebuilds local packages and the Runtime and Studio images, runs them as the examples' own local Tenant (Docker Compose; Runtime on port 8787, Studio on port 4161 by default) with `nylorun start` in this directory, which creates the Tenant, links this directory to it, and on that first link seeds the model provider from `.env` into the Tenant's vault; then it starts the tools service and runs these examples with their own `npm run dev`, which saves the agents again on every edit. Outside root development, run `npx nylorun start` here, then `npx tsx src/tools/server.ts` (the tools service) and `npm run dev`. Use `npm run dev -- --no-studio` without Studio. From this directory, `npx nylorun studio` opens a fresh Studio login on the examples Tenant; `npm run build` and `npm start` exercise production startup. `npm run configure` replaces the vault credential while the Tenant is running.

`MODEL_PROVIDER`, `MODEL`, and `MODEL_PROVIDER_API_KEY` (and `MODEL_PROVIDER_BASE_URL` for a custom endpoint) seed the vault once when they are already set. They are not the call-time store. An existing `.env/` directory must be migrated by hand (back it up, create a `.env` file with those variables, and move OAuth credentials to `.nylorun/auth.json`); local state is never moved automatically.

Optional integration variables are loaded from `.env`. Interior Design uses `OPENAI_API_KEY` and optional `OPENAI_IMAGE_MODEL` independently of the chat provider. Its selected chat model must support images. Codex continues using its own authentication. Never commit credentials.

## Data analyst (sandbox)

[`agents/release/analyst.ts`](./agents/release/analyst.ts) is a plain agent. The sandbox comes from the runtime section its manifest is saved with, not the agent: `src/main.ts` saves it with a virtual one and makes the Agent `analyst` (one sandbox and one vault, with its own id). Sessions run on an Agent; another Agent of the same manifest has a sandbox of its own:

```ts
const client = await createClient();
await client.agentManifests.save({ agent: analyst, runtime: { kind: "virtual" } });
await client.agents.put("users/alice/analyst", { manifest: "analyst", owner: "alice" });
await client.createSession({ id: "alice-sales", agent: "users/alice/analyst", ownerUserId: "alice" });
```

In Studio, pick the Agent when you start the session. The model gets `bash`, `read`, `write`, `edit`, `grep` and `glob` in a sandboxed shell with a persistent `/workspace`, kept with the Agent across its sessions. Kind `virtual` runs those tools in an emulated shell in the Runtime; it is not a VM boundary (kind `pod` runs them in a pod: `npx nylorun local sandbox enable`). `npx nylorun doctor sandbox` reports the backend and the Tenant's limits. Try in Studio:

- `Create sales.csv with three regions and numbers, then total them with awk.`
- `Download https://example.com with curl.` The request is blocked: a sandbox reaches only the hosts its runtime allows (`network.allowedHosts`), within the Tenant's ceiling.

## Repo brief: every piece in one flow

[`agents/repo-brief/agent.ts`](./agents/repo-brief/agent.ts) is one flow agent that uses everything the Runtime runs from a manifest, and calls no code of this project during a session:

```
triage → switch ┬ repo:    map(researcher) → parallel(overview, risks) → loop(writer, editor) → publish_brief
                └ default: decline
```

- The **switch** reads the triager's `route`: a request that names a public GitHub repository as owner/repo goes to the research flow, anything else to `decline`.
- The **map** runs the researcher once per question in the triager's `items`. Each researcher asks DeepWiki's **remote MCP** server, as the [Remote MCP](./agents/mcp/agent.ts) example does.
- The **parallel** stage summarizes the answers and lists risks at the same time.
- The **loop** runs the writer until the editor passes the brief, at most twice. The writer follows the `repo-brief` **skill** ([`skills/repo-brief`](./agents/repo-brief/skills/repo-brief/SKILL.md)): it writes `/workspace/brief.md` and runs the skill's `scripts/check.sh` in the session's sandbox, and it dates the brief with the `now` **HTTP tool**.
- The last stage, `publish_brief`, is an **HTTP tool used as a flow stage**: the Runtime POSTs the brief to the tools service ([`publish.ts`](./agents/repo-brief/publish.ts)), which stands in for your CMS, and its answer is the flow's output.

The writer's shell needs a sandbox, which its runtime section gives it, as for the [data analyst](#data-analyst-sandbox): open the session on the Agent `repo-brief` (in Studio, pick it); the flow's child sessions run on the same Agent. Then try `Brief me on modelcontextprotocol/typescript-sdk.` in Studio. [`test/repo-brief.test.ts`](./test/repo-brief.test.ts) runs the same turn against an in-process Runtime, with a stub model, a fake DeepWiki and the tools service.

[`agents/repo-brief-folder/`](./agents/repo-brief-folder/) is the same flow as an agent folder (track T7): 23 Markdown and JSON files. [`flow.json`](./agents/repo-brief-folder/flow.json) is the top of the tree, and [`agents/research/flow.json`](./agents/repo-brief-folder/agents/research/flow.json) a sub-flow; both name their stages from the one `agents/` at the root, and the compiler nests them as the manifest needs. `npx nylorun check agents/repo-brief-folder` compiles it offline, and [`test/repo-brief-folder.test.ts`](./test/repo-brief-folder.test.ts) checks that it compiles to the manifest the TypeScript flow saves, apart from one instruction string per Markdown file and the agents' display names (a folder's `name` is its id). Its tools call the tools service at `http://localhost:3001`, `TOOLS_URL`'s default.

## Triage: an agent folder

[`agents/triage/`](./agents/triage/) is an agent folder (track T6): Markdown and JSON, no TypeScript.

- [`AGENT.md`](./agents/triage/AGENT.md) holds the agent's name, `triage`, its description, and its instructions below the frontmatter.
- [`mcp.json`](./agents/triage/mcp.json) holds GitHub's remote MCP server. `Bearer ${GITHUB_TOKEN}` in its `Authorization` header names the secret it authenticates with: with no `runtime.json` declaring it, the compiler derives a `GITHUB_TOKEN` bearer slot bound to that server's exact URL, and says so.
- [`README.md`](./agents/triage/README.md) is kept with the version's source and is not part of the agent: changing only it saves no new version.

```sh
npm run triage                              # packFolder + agentManifests.saveFolder, then the Agent triage
npx nylorun check agents/triage             # compile it offline: every problem by file, line and column
npx nylorun apply agents/triage --dry-run   # the plan and the compiled manifest, from the command line
```

`npm run triage` ([`src/triage.ts`](./src/triage.ts), [`apply.ts`](./agents/triage/apply.ts)) saves the folder, which the Runtime compiles and keeps as the version's source, and makes the Agent `triage`; with `GITHUB_TOKEN` in `.env` it writes the token into the Agent's slot (else `npx nylorun agents secrets put triage GITHUB_TOKEN` with the token on standard input). Then try `Triage modelcontextprotocol/typescript-sdk#1` on the Agent `triage` in Studio. A typo is refused before anything is sent, named by file, line and column. [`test/triage.test.ts`](./test/triage.test.ts) checks both.

## An agent in your web app (AG-UI)

[`src/ag-ui/`](./src/ag-ui/) is a web backend that puts the
[support agent](./agents/ag-ui/support.ts) in front of its signed-in users. The
browser speaks [AG-UI](https://docs.ag-ui.com) to the backend; the backend signs
people in, hosts the handler and answers the agent's `lookup_order`, an HTTP tool the
Runtime calls at the backend's URL. `save` also adds a rule to the Tenant's tool policy
(with the management key) so each lookup waits for the person. The whole integration is
[`app.ts`](./src/ag-ui/app.ts):

```ts
const tools = toolsService([lookupOrderCode]); // POST /lookup_order: the tool's code runs here
const agui = createAgUiHandler({
  basePath: "/api/agui",
  agents: ["support"], // nothing else is reachable
  subject: (request) => userFromCookie(request)?.id, // your sign-in; undefined → 401
});
const fetch = (request: Request) =>
  new URL(request.url).pathname === "/lookup_order" ? tools(request) : agui.fetch(request);
createServer(toNodeListener({ fetch })).listen(3000);
await client.agentManifests.save({ agent: supportAgent("http://localhost:3000") }); // the tool's URL is this app's
await client.agents.put("support", { manifest: "support" }); // kind none: no sandbox, one Agent for everyone
```

Run it with the examples Tenant from `npm run dev` running:

```sh
npm run ag-ui
curl -N -H 'cookie: demo_user=ada' -H 'content-type: application/json' \
  -d '{"threadId":"t1","runId":"r1","messages":[{"id":"m1","role":"user","content":"Where is demo-123?"}],"tools":[],"context":[],"state":{},"forwardedProps":{}}' \
  http://localhost:3000/api/agui/support
```

The run ends with an approval interrupt for `lookup_order`; resume it with a
second run that carries `resume: [{ interruptId, status: "resolved", payload: { approved: true } }]`.
For a UI, point CopilotKit or `@ag-ui/client`'s `HttpAgent` at
`/api/agui/support`. [`test/ag-ui.test.ts`](./test/ag-ui.test.ts) drives the same
flow for two people against an in-process Runtime (see [Tests](#tests)).

The handler is a web-standard `fetch` function, so it mounts anywhere:

```ts
// Next.js: app/api/agui/[...path]/route.ts
export const GET = agui.fetch, POST = agui.fetch;

// Hono
app.all("/api/agui/*", (c) => agui.fetch(c.req.raw));
```

Both handlers hold no state between requests, so they run on a serverless
platform too; save the agent with the deployed URL once from a deploy step
(`NYLORUN_APP_URL` for `npm run ag-ui`). The Agent keeps the version it was made
from: a new URL reaches callers through an Agent made from the new version.

## Pages that call the Runtime directly

A page can also call the Runtime itself, with the JWT your identity provider
gave the person, when the Runtime trusts that provider in its identity file
([Trusted issuers](../guides/DEPLOYMENT.md#trusted-issuers)). Nylorun mints no token and
ships no browser client: send the token as `Authorization: Bearer <token>`
through a reverse proxy that answers CORS
([DEPLOYMENT.md](../guides/DEPLOYMENT.md#calling-the-runtime-from-browsers-and-apps)).

Rules for a web backend:

- One installation, and so one Tenant, per environment (`prod`, `staging`).
  Your users are subjects, not Tenants.
- The subject is your user id, namespaced and stable (`app:<id>`), never an
  email address. [`demo-auth.ts`](./src/ag-ui/demo-auth.ts) is a stand-in:
  replace it with your session lookup.
- The application key and the Runtime URL stay on the server. The browser gets
  AG-UI events and nothing else; the handler calls the Runtime as each person
  (`client.as`), so people only reach their own threads, and any `Nylorun-*`
  header a browser sends is ignored.
- Per-user keys (a user's GitHub token) go in that person's Agent
  (`client.agents.secrets.put`), with `owner` set so only their
  sessions may run on it ([Credentials](../guides/DEPLOYMENT.md#credentials)).
  Accounts that need the person's sign-in (their Drive) go through an MCP gateway
  ([Reaching a person's accounts](../guides/DEPLOYMENT.md#reaching-a-persons-accounts)).
  A shared tool key is a secret of each Agent that needs it.
- The Runtime stays off the network: see
  [Serving people through an app server](../guides/DEPLOYMENT.md#serving-people-through-an-app-server).

## A harness of your own

[`harness-minimal/`](./harness-minimal/) is a harness written only against the published Harness API (`@nylorun/core/harness-api`), without our engine: it leases turns from the Runtime, calls the Model Gate, runs `bash`, and journals each call. It is a package of its own, with its own tests and Dockerfile; its README says how to run it beside the Runtime.

## Tests

`npm test` runs the examples' tests (not `harness-minimal/`'s, which run in that package). The AG-UI and Repo brief tests start an
in-process Runtime (`startEphemeralRuntime`) whose Tenant lives in a database of its own
on the runtime test stack's Postgres ([`test/database.ts`](./test/database.ts)). Start that
stack first, from the repository root (it needs Docker; the runtime's `npm test` starts it
too):

```sh
npm run test:stack:up --workspace @nylorun/runtime
```

## Generated shell and authored examples

The creator owns the shell files listed in `.scaffold-manifest.json`, including `src/index.ts`, `tsconfig.json`, and `package.json`. Change their source in `cli/create-agent/starter/` or `cli/create-agent/examples.recipe.json`, then run `npm run examples:sync` from the repository root. Sync never changes the authored `agents/` tree, tests, other scripts, credentials, model selection, or application data. CI rejects shell drift and incompatible integrations.

## Try every agent in Studio

| Select this agent   | Send this message                                                                               | What to verify                                                                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Instructions**    | `What is a harness?`                                                                            | Three short sentences, no tools.                                                                                                                                    |
| **Interior Design** | Attach one room photo and ask: `Make this warm modern Scandinavian.`                            | The agent calls OpenAI Images to preserve the room while changing its furnishings, finishes, lighting, and decor.                                                   |
| **Skills**          | `Load the structured-summary skill, then summarize this: rain delayed the launch.`              | `load_skill` returns the SKILL.md body; the reply uses the skill headings. The Runtime adds the catalog to the instructions (`runtime.instructions`).                    |
| **Tool Use**        | `Calculate 100 / 4, then convert that many celsius to fahrenheit.`                              | `calculate` returns 25, then `convert` returns 77, with no approval prompt.                                                                                         |
| **Interactions**    | `Ask me what to name the note, then save it.`                                                   | Studio asks a question, then asks for approval before `write_note`.                                                                                                 |
| **Remote MCP**      | `What does the README of modelcontextprotocol/typescript-sdk say about transports?`             | The Runtime connects to DeepWiki's public MCP server by URL and calls its tools; no process of yours serves them.                                                  |
| **Repo brief**      | `Brief me on modelcontextprotocol/typescript-sdk.` (on the Agent `repo-brief`)                 | The flow tree shows triage, the repo case, one researcher per question, both reviews, the writer and editor, and `publish_brief`; the writer's `bash` call prints `ok`. |
| **PTC**             | `Calculate 100 / 4, convert that many celsius to fahrenheit, and include the current UTC time.` | One `run_code` call. The program uses `await tools.*` and returns one object (25 °C → 77 °F plus `iso`).                                                            |
| **Subagents**       | `Ask the tool-use specialist to calculate 19 * 7.`                                              | A `tool-use` call runs that agent with a fresh context; the parent reports its answer. Studio shows the delegation and the child's own tool calls. The other agents are `instructions` (format-only) and `skills` (SKILL.md). |
| **Coding Agent**    | `Add a goodbye function next to hello and show the file.`                                       | After Codex preflight and approval, `codex exec` runs in a temporary workspace.                                                                                     |

If a model answers directly rather than selecting a tool, try a more explicit request such as
“you must use the calculator tool.” For the clock: `What is the current UTC time? You must use the now tool.`
The example adapter does not invent tool calls for models that skip them.

For PTC, ask for one `run_code` call using an async function **body**, without a
function or arrow wrapper. Tool results are objects: `calculate` supplies `.value`,
`convert` supplies `.result`, and `now` supplies `.iso`. A complete body is:

```js
const calculation = await tools.calculate({ expression: "100 / 4" });
const conversion = await tools.convert({
  value: calculation.value,
  from: "celsius",
  to: "fahrenheit",
});
const time = await tools.now({});
return {
  celsius: calculation.value,
  fahrenheit: conversion.result,
  iso: time.iso,
};
```

For Coding Agent, `codex_exec.task` is a plain-language task for the Codex CLI. Its
workspace already contains `hello.js`; it does not need your repository or file upload.
For example: `Preserve hello in the seeded hello.js, add an exported goodbye function,
show the resulting file, and verify both functions.` Review that task in Studio's
approval prompt before allowing execution.

## Codex CLI

The Coding Agent shells out to a host-installed Codex CLI. Auth is Codex's own
(`CODEX_API_KEY`, `OPENAI_API_KEY`, or `codex login`) and is independent of `NYLO_*`. Before
trying that agent, install Codex and run:

```sh
npm run codex:preflight
```

Codex runs in a temporary workspace seeded with a tiny `hello.js` file. It never receives this
repository. The agent asks for approval before `codex_exec`.

The preflight checks that the CLI is installed; it does not make a model request.
If execution reports that the configured model requires a newer Codex version,
[upgrade the host CLI](https://learn.chatgpt.com/docs/codex/cli) and restart the examples
process so it uses the updated executable. Codex uses its host configuration and login.

## Learn from the code

Start with [Instructions](./agents/instructions/agent.ts), then [Tool Use](./agents/tool-use/agent.ts).
Each piece is a plain list of tools, and sometimes instructions, that an agent adds with `.tools()` and `.instructions()`:

- [tools](./agents/shared/tools/index.ts) returns the catalog as tools for `.tools(...(await tools()))`: every `*.ts` module in [agents/shared/tools/catalog](./agents/shared/tools/catalog) becomes an `http()` tool, whose code the [tools service](./agents/shared/tools/service.ts) runs.
- [ptc](./agents/ptc/tools.ts) returns instructions and one tool: the same catalog becomes a generated TypeScript SDK, and only `run_code` is offered to the model. It runs the catalog's code in process, so only the local engine runs it.
- [ask-user](./agents/interactions/ask-user.ts) pauses for a human reply.
- [notes](./agents/interactions/notes.ts) uses an ordinary JSONL service; `write_note` has an `approval`, so each write waits for a person.
- [skills](./agents/skills/agent.ts) is one `.skills(folder)` call: a SKILL.md catalog the Runtime serves with `load_skill`.
- [codex](./agents/coding-agent/tools.ts) wraps a host runtime. For an isolated machine, save it with a `pod` runtime and open the session on its Agent, as for [analyst](./agents/release/analyst.ts).
- [subagents](./agents/subagents/agent.ts) puts three example agents in `.subagents()`; each runs with a fresh context and returns only its answer.
- [mcp](./agents/mcp/agent.ts) is one `.mcp({ deepwiki: { type: "streamable-http", url } })` call: a remote MCP server the Runtime reaches by URL.

Add or remove skills on an agent with one call. Author `name/SKILL.md` (frontmatter `name` + `description`) under [agents/skills/catalog](./agents/skills/catalog), then:

```ts
.skills(SKILLS_CATALOG)
```

Delete that line to drop the skills. Drop another `SKILL.md` folder in the same catalog to add a skill without changing agent code. Pass another folder to load a different catalog.

Tools follow the same catalog shape. Export a `tools` array from a module in [agents/shared/tools/catalog](./agents/shared/tools/catalog), then:

```ts
.tools(...(await tools()))
```

Drop another `*.ts` file in that folder to add a tool without changing agent code: the tools
service serves it at `/<tool name>` once restarted. PTC loads the same catalog and hides
those native schemas; the model writes a program against `await tools.name(args)` instead.

For the underlying agent model, read the concise [Harness README](../runtime/harness/README.md).
For the browser-side protocol, read the [Studio README](../studio/README.md).

## Records, secrets, and cleanup

Notes, media assets, and canonical session records are written below `.data/`, grouped by agent and
session. Image bytes are stored only in `.data/media/`; session documents retain metadata, opaque
asset references, and loopback preview paths. They are ignored by Git. Known environment secrets
and credential-shaped fields are redacted before records or HTTP responses are created; request
headers and raw provider payloads are never exposed.

Stop the processes with `Ctrl-C`. To start from a clean local history, remove `.data/`:

```sh
rm -rf .data
```


The generated starter defaults to memory sessions. This examples recipe explicitly chooses `localSessions({ root: ".data/sessions" })`. Its application signal handlers drain Runtime before closing external tools. Harness has no session or resource-disposal lifecycle.

## Current release storage

Sessions of the supported registry live in the examples' local Tenant: its Postgres database, with their history in S2. The Project link and derived application credentials are in `.nylorun/`; `npx nylorun tenant reset --all` empties the Tenant, and `npx nylorun local reset` deletes the Tenant's data (containers and volumes). Historical `.data/` files are not automatically migrated. An Agent keeps the manifest version it was made from: after a definition change, open sessions on an Agent made from the new version (`npx nylorun agents fork <id> <new-id>`). The starter README documents the supported text/tool workflow.
