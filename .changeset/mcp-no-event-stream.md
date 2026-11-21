---
"@nylorun/runtime": patch
"nylorun": patch
---

The Runtime no longer asks a remote MCP server for its optional event stream. After `initialize`, the MCP SDK sends a GET for server-initiated messages, which the Runtime never reads: its client declares no capabilities and handles no notification, and a tool call's answer and progress come on the call's own POST. A stateless server that answered that GET 200 and closed the stream at once (the gateways' `apps` edge did) made the SDK reconnect every second for as long as the connection stayed pooled, up to 15 minutes idle, each time reading the vault and writing a `credential.used` Tenant event. The Runtime now answers that GET itself with 405, before any credential is read, and the SDK stops asking. A GET with `Last-Event-ID`, which resumes a POST's stream, and a legacy `sse` server's stream are sent as before.
