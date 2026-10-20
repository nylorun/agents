---
"@nylorun/runtime": patch
---

An MCP gateway's report of an upstream `401` is `credential_rejected` (#495). Through a credential's `via`, a gateway that answers HTTP 200 but reports that the server behind it answered `401` is read like a `401`. LiteLLM does this for a token the provider revoked: a `tools/list` with no tools and `"auth_required"` for the server in `_meta["litellm.ai/server_outcomes"]` makes the server's `mcp.discovered` outcome `failed` ("MCP server returned 401"), and a tool error carrying that outcome, or LiteLLM's `HTTPStatusError: Client error '401 Unauthorized'` text, completes as `credential_rejected` with `retryable: false`, naming the server. A server reached without `via` is read as before.
