---
"@nylorun/runtime": patch
---

Credential failures name the session's Agent, not its Environment: an HTTP tool's `http.credential` failure says "The session's Agent holds no credential '…' for …", and an MCP server's `credential_rejected` says the credential came from, or is missing in, the session's Agent.
