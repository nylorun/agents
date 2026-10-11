# Harness conformance

`@nylorun/harness-conformance` checks a harness of the Nylorun Runtime against the Harness API (track R4, R4.7). It is a black box: it drives a live Runtime only through the public Runtime API (an application key) and Management API (a management key), with `fetch`, and reads back what the Runtime recorded: the session's events, its metered model calls, its journaled tool calls and its sandbox routes. It never imports Runtime code, so a harness written in any language is checked the same way as ours.

It is published on npm (Node 24 or later), with the command `nylorun-harness-conformance`.

## Run it

Start the Runtime, connect the harness under test with its own token (`nylorun-operate harness token put <id>`), keep our harness connected beside it, then:

```sh
npx @nylorun/harness-conformance \
  --runtime http://127.0.0.1:4000 --key "$NYLORUN_API_KEY" --manage-key "$NYLORUN_MANAGEMENT_KEY" \
  --harness acme-mini [--profile container|pod] [--image <ref>] \
  [--restart "docker restart acme-mini"] [--long] [--workspace] \
  [--mcp-url <url> --mcp-tool <name> [--mcp-args <json>]] [--secret <value>]... [--only HC01,HC05] [--json]
```

Until the first release reaches npm, or to check against unreleased changes, run it from a checkout of this repository, from its root:

```sh
npm run build --workspace @nylorun/harness-conformance
node conformance/dist/cli.js --runtime http://127.0.0.1:4000 --key "$NYLORUN_API_KEY" \
  --manage-key "$NYLORUN_MANAGEMENT_KEY" --harness acme-mini
```

`NYLORUN_RUNTIME_URL`, `NYLORUN_API_KEY` and `NYLORUN_MANAGEMENT_KEY` stand in for the first three options.

`--mcp-tool` names the tool as the model sees it: `<server>__<tool>`, where the suite registers
the server as `conformance` (so `conformance__echo` for a tool `echo`).

**Use a Tenant for testing.** The suite turns on the Tenant's fixture model (`PUT /v1/tenant/config/seed {fixtureModel: true}`), which answers every model call at the Model Gate from a script. The setting is insert-if-absent and stays on. It also registers an agent and creates Environments and sessions whose ids start with a random `hc-…` prefix; it deletes the Environments when it is done.

It prints a table, or with `--json` one line per check: `{id, ok, detail, section, status, class, ms}`, where `status` is `pass`, `fail`, `skipped` or `n/a`. It exits 0 when every check that applies passed, 1 when one failed, 2 on a usage error.

From code, `runConformance(options)` (`import { runConformance } from "@nylorun/harness-conformance"`) runs the same checks and returns the report; `runtime/server/test/harness-api/conformance.test.ts` runs it against our harness and the example on every change.

## How a check runs

Every turn is deterministic. The fixture model reads the last user message:

| Message                               | The model answers                                                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `conformance:text`                    | `conformance ok`                                                                               |
| `conformance:tool <name> <json>`      | one call of the offered tool `<name>`; after its result, `conformance tool <status>: <result>` |
| `conformance:unoffered <name> <json>` | the same call of a tool the turn does **not** offer                                            |
| `conformance:budget`                  | a `budget_exhausted` failure                                                                   |
| `conformance:slow <s>`                | `conformance slept <s> s`, after that long, unless the call is cancelled                       |

The suite opens sessions on Environments whose `harness` is the harness under test: `none` for text turns and `virtual` for `bash` in the container profile; in the pod profile every session runs on one pod Environment whose `image` is `--image`. A session without an Environment runs on our harness, `nylorun`.

## The checks

Section numbers are those of the Harness API reference. **Required** checks apply to every harness; HC07 and HC08 need `--restart` (a command, or a function from code, that restarts the harness) and HC10 needs `--long`, and are `skipped` without them. **Profile** and **optional** checks are `n/a` unless you turn them on: the suite cannot see what a harness declared in `hello`.

| Id   | Class                    | Section    | What it verifies                                                                                                                                                                                                                                                           |
| ---- | ------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HC01 | required                 | §1, §2     | The harness connected with its credential, said `hello` with Harness API 2 and its id, and took and settled the run of a session pinned to it.                                                                                                                             |
| HC02 | required                 | §2         | Each turn ran under one run: every event the harness reported carries the same `runId`.                                                                                                                                                                                    |
| HC03 | required                 | §4, §6, §7 | A text turn ends `turn.completed`; its output and its one `message.assistant` are the gate's answer; the next turn's prompt is longer, so the transcript edits were recorded and read back.                                                                                |
| HC04 | required                 | §5         | Each model answer has exactly one metered call (`/calls/model`), each with its own effect id and provider `fixture`: every model call went through the Model Gate.                                                                                                         |
| HC05 | required                 | §4         | A `bash` call has one journaled tool call row (completed, one attempt) and one `tool.completed` with the command's real output, after the model asked for it.                                                                                                              |
| HC06 | required                 | §4         | Every effect id begins `<turnId>:<segment>:`; with `--restart`, the ids are the same when the segment runs again (no `effect_drift`).                                                                                                                                      |
| HC07 | required, `--restart`    | §3, §4     | The harness restarts during a command that follows a model outcome; the outcome replays from `TurnStart.outcomes`: its effect is metered once, no second gate call.                                                                                                        |
| HC08 | required, `--restart`    | §4, §8     | The command the restart interrupted is not settled as completed (`tool.interrupted` or uncertain), and a marker file shows it ran once.                                                                                                                                    |
| HC09 | required                 | §8         | A cancel during a model call (`conformance:slow 5`) and during a command (`sleep 20`) ends each turn `turn.cancelled` within 2 s; the model call is never metered (the gate call was cancelled), the command's call is `cancelled`, and the harness reports nothing after. |
| HC10 | required, `--long`       | §2, §5     | A 16-minute command completes and the model is called after it: the harness renewed its lease and used the re-minted run token.                                                                                                                                            |
| HC11 | required                 | §4         | A call of a tool the turn does not offer runs nothing (no completed tool call, no sandbox exec); the model hears it failed and the turn completes.                                                                                                                         |
| HC12 | required                 | §5, §7     | A budget refusal ends the turn `turn.failed` `model.budget_exhausted` with one `model.failed` and no retry.                                                                                                                                                                |
| HC13 | required                 | §3, §7     | Three turns in a row complete, each prompt longer than the last: each started from the new transcript cursor, and core accepted the harness's state each time.                                                                                                             |
| HC14 | required                 | §5, §9     | No run, host or harness token (a signed token, or a `NYLORUN_*TOKEN=` value, or a `--secret`) appears in the items, model calls or tool calls of any session the suite opened, including a `bash` call that prints its environment.                                        |
| HC15 | profile (pod)            | §9         | As a pod Environment's image, the harness joins, takes the run under the Environment's harness id and runs `bash` in `/workspace`.                                                                                                                                         |
| HC16 | optional (`--workspace`) | §10        | The session's sandbox routes (`read`, `write`, `bash`) serve the files the turn's `bash` wrote, and are refused `409` during a turn.                                                                                                                                       |
| HC17 | optional (`--mcp-url`)   | §5         | With an agent that uses the MCP server, the session's MCP snapshot is recorded and the tool is called once through the Tool Gate: one journaled `mcp` call, one `tool.completed`.                                                                                          |
| HC18 | required                 | §2         | With our harness connected too, a session without an Environment runs on `nylorun` and one pinned to the harness runs on it, at the same time, each served by its own.                                                                                                     |
| HC19 | required                 | §4         | `message.assistant`, `tool.completed`, `turn.completed` and `turn.failed` from the harness say `source: {kind: "harness", id: <harness>}`, evidence `claimed` and the `runId`; commands are the client's, with a `principal`; each model call is metered once (HC04).      |

## What it cannot see

The suite sees only what the Runtime records and serves. That a run is refused to another connection (`run_not_held`), that an unsupported `api` is refused, or that state over 256 KiB fails a turn are the Runtime's own rules, tested in its suite; here they show only as a harness that took its runs and settled them. The transcript edits (`transcript.updated`) are never served, so HC03 and HC13 read them through the next prompt's size.
