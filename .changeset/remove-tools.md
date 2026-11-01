---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/agents": minor
---

A message's `removeTools` (Host feature `remove-tools`): the tools its turn may not use, by name. A
declared tool or an agent used as a tool by its name (in the agent and the agents it uses as tools),
an MCP server's tool as `<server>__<tool>`, a whole server by its name. The Runtime applies it to the
version the turn runs, after the turn's first segment re-pins the session to its Agent's version, so
a session that always sends it still moves to new versions; names that version lacks are ignored.
A message's turn manifest is validated again against the version a re-pin moves to; one that is no
variant of it keeps the turn on the version it pinned (`turn.version_kept`). A variant may narrow an
agent it uses as a tool (`isVariantOf`; `withoutTools` in `@nylorun/core/define`). An HTTP tool call
is checked against the turn's manifest. `session.input` and `session.inputParts` take
`removeTools`.
