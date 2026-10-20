# triage

An agent folder: `AGENT.md` holds the agent's name, description and instructions, and `mcp.json`
GitHub's MCP server. `${GITHUB_TOKEN}` in its `Authorization` header names the secret the server
authenticates with, so the compiled manifest gets a `GITHUB_TOKEN` bearer slot bound to that URL.
This README is kept with the version's source and is not part of the agent.

```sh
npx nylorun check agents/triage
npx nylorun apply agents/triage --dry-run
```
