---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/agents": minor
"nylorun": minor
---

Secret routing: the agent folder names, the installation routes (Host feature `secret-routing`, no
protocol change). A `bearer` or `headers` secret slot (`runtime.json`, `runtime.secrets`) takes the
gateway's `toolPrefix`, with or without `via`, and a slot's value write
(`PUT /v1/agents/{id}/secrets/{name}` with `{ value }` or `{ headers }`) takes `via`, with the same
URL rules as a slot's. At each request the secret's `via` wins, else the slot's in the version the
Agent runs, else none (the slot's `url`); the slot's `toolPrefix` wins over the secret's and
applies only with a `via`; the slot's `url` still picks the credential, for MCP servers and HTTP
tools alike, and an HTTP tool whose URL has `{field}` parameters still fails behind a `via`. A
write whose `toolPrefix` differs from its slot's is accepted, with a warning in the log. A `via` a
write copied from its slot follows the slot when the Agent moves, and a fork keeps a secret's own
`via`. Secret views show the `via` and `toolPrefix` in force, never a value.
`client.agents.secrets.put` takes `{ value | headers, via?, toolPrefix? }` (`AgentSecretRouting`),
and `nylorun agents secrets put` takes `--via` and `--tool-prefix`, and a slot's JSON without a
`type`. The JSON Schemas that gained the slot's `toolPrefix` are published as
`agent-manifest/v8.2`, `runtime-manifest/v1.1` and `agent-folder/v1/runtime.1`, which `nylorun init`
maps; the old `$schema` URLs are still read.
