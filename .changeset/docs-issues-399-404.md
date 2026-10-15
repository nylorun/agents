---
"@nylorun/core": patch
"@nylorun/agents": patch
"@nylorun/runtime": patch
---

**Docs and schemas match what the CLI and the Runtime do.**

- `@nylorun/core`: the environment manifest's JSON Schema (`@nylorun/core/schemas/environment-manifest.json`) takes the CLI's `{ path, from }` `files` entry, so an editor no longer flags a manifest that `nylorun environments manifests save` accepts. The Runtime's own schema is unchanged: the CLI turns the folder into `{ path, files }` before saving. `manifest_changed` says to save without `If-Match` (`--if-match`, `ifMatch`); no command takes `--force`.
- Tool names, skill names and MCP server names are each unique within their kind, as the builder and the Runtime check; a tool, a skill and a server may share a name. The docs said they were unique across kinds.
- `harness_mismatch` is described as what it is since protocol 14: an Environment's harness is fixed for its life (fork onto a manifest version to run another), and a session's turn is refused when its Environment id was deleted and made again with another harness, or an Environment changed in place before protocol 14 applies that change.
- `@nylorun/agents`: the README names `nylorun environments list | delete`, not `nylorun local sandbox ls | rm`.
- MIGRATION.md no longer offers a tool's `approval`, removed in protocol 11, as a replacement for step middleware.
