---
"nylorun": minor
"@nylorun/agents": minor
"@nylorun/runtime": minor
"@nylorun/core": patch
---

Both ends of the agent folder loop (track T7).

- `nylorun init <path>` names the agent after the path's last segment (`init agents/hello`). `--example` adds `tools/get_order.json`, `mcp.json` (a `Bearer ${ORDERS_MCP_TOKEN}` header) and `triggers/new-order.md`, explained in the folder's README.md, and the result passes `nylorun check`. The first run in a project (the nearest directory with `.git`) writes `.gitattributes` (`* text=auto eol=lf`), ignores `.nylorun/credentials.json` in `.gitignore`, and maps the folder files to their JSON Schemas in `.vscode/settings.json`, merged into an existing file. Its hint names `apply --agent` and `chat`.
- `nylorun apply --agent [<id>]` makes the Agent from the manifest after a save (or on an unchanged one), or moves it, as `nylorun agents put` does, and prints what it needs a person for.
- `nylorun apply --watch [--save]` checks and plans again on each change to the folders (and the files their `runtime.json` extends); it saves only with `--save`.
- A plan's change to the instructions prints their text diff, `-` and `+` lines.
- `nylorun chat <agent> [--session <id>] [--message <text>]` opens or reuses a session, sends `--message` or each line of standard input, and prints the reply as it comes.
- `nylorun check --json` prints `{ folders: [{ path, ok, manifest?, diagnostics }] }` for CI, with the same exit codes. `check` says "1 file", and `nylorun --version` prints the version.
- `packFolder` (`@nylorun/agents`) leaves out what the folder's `.nyloignore` names (gitignore rules), and resolves `extends` in `runtime.json`: the packed file is the merge, the folder's own keys winning, with `.nylorun/origin.json` naming the files it came from; a missing file or a cycle is a `FolderError`. `ignoreMatcher` is exported.
- `session.approve(id, approved)` and `session.respond(id, value)` take no options: each makes its own idempotency key.
- The Runtime's Agent view names each required secret of the version it runs that has no value, as an attention item (`secret_unset: required secret ORDERS_TOKEN unset`, state `input_required`), until it is set.
- The compiler's refusal of an unresolved `extends` says to resolve it before uploading.
