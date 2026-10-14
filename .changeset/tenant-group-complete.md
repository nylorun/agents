---
"nylorun": minor
---

**`nylorun tenant` covers the Management API: models, usage, calls, budgets, tool policy, coverage and settings.** The group set the model only with prompts, and the rest of `@nylorun/admin` needed code. Now each Management API call has a command, for a local Tenant or the installation `NYLORUN_RUNTIME_URL` and `NYLORUN_MANAGEMENT_KEY` name.

- **Models.** `tenant models catalog | providers | get` print a table or a line (`--json` for the answer). `tenant models select <provider> [--model <id>]` switches to a provider that has a credential, keeping its model and endpoint. `tenant models set --provider <id> --model <id> [--base-url <url>]` sets an API key without prompts or pi-ai, for CI: the key is read from stdin, never from the arguments, and a terminal on stdin is refused (exit 2). With no flags, `models set` prompts as before.
- **Usage and calls.** `tenant usage [--scope tenant|agent|turn] [--id <id>] [--period day|month|total]` prints the totals as JSON. `tenant calls [--after <cursor>] [--limit <n>]` prints every recorded model call as one JSON line, page after page, until caught up, then the cursor to resume from on stderr.
- **Files in, files out.** `tenant budgets`, `tenant tool-policy`, `tenant settings sandbox` and `tenant settings artifacts` take `get` (the default), which prints the document as JSON, or `put <file|->`, which replaces it with the JSON body in a file or on stdin. A body is checked against its schema before anything is sent (exit 2 when it does not parse). What `budgets`, `tool-policy` and `settings artifacts` print, `put` takes back.
- **Coverage.** `tenant coverage --agent <id> [--environment <id>]` shows which secret of the Environment each of the agent's MCP servers and HTTP tools would get (`--json` for the answer).
- Usage errors exit 2 before any request.
