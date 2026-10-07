---
"@nylorun/core": minor
"@nylorun/runtime": minor
"@nylorun/admin": minor
"nylorun": minor
"@nylorun/studio": minor
---

**Preview an MCP server's tools** (R2b C12). MIGRATION.md (protocol 10, "Previewing a server's tools") has the details.

- `@nylorun/core`: `McpPreviewRequestSchema` and `McpPreviewSchema` (`McpPreviewTool`), and the error code `mcp_preview_failed`.
- `@nylorun/runtime`: `POST /v1/tenant/mcp/preview` (the Management API) connects to a remote MCP server with the installation vault's credential for its URL (headers and `via`, no identity header), under the Host's address policy and within 15 s, and answers its server info, instructions, tools (model names, annotations, schema sizes) and renames; a `401` is `authRequired`, with the server's RFC 9728 protected-resource metadata. It runs in the keys service (`Keys.previewMcp`), which holds the plaintext, and calls no tool. Both OpenAPI documents list it.
- `@nylorun/admin`: `admin.mcp.preview({ url, type?, name?, vaultId? })`.
- `nylorun`: `nylorun mcp inspect <url> [--server <name>] [--vault <id>] [--sse] [--json]` prints the running Tenant's preview: a table of tools, the renames, or that the server needs a person's sign-in. Its `connect` subcommand still says it was removed, and now points to `inspect`.
- `@nylorun/studio`: **Preview tools** on each credential of the Credentials page lists the tools behind its URL.
