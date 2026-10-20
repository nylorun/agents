---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/agents": minor
---

A gateway's tool prefix (#494, Host feature `gateway-credentials`). A `bearer` or `headers` credential with `via`, written to an Agent's vault, may add `toolPrefix`: what the gateway at `via` puts before each tool name it lists, such as LiteLLM's `github-`. The Runtime lists the server's tools without it, so tool names (`github__create_issue`), a manifest's `tools` settings and tool policy rules name the server's own tools whether or not a gateway is in between, and calls each tool by the name the gateway listed. A listed tool that lacks the prefix keeps its name, and the server's `mcp.discovered` message names it. `toolPrefix` needs `via`, and secret views carry it. It is the installation's routing, never a manifest's: a manifest's secret slot cannot name it, and a slot's value write (`{ headers, toolPrefix }`) adds it. A fork keeps it while the new slot keeps `via`. No protocol change.
