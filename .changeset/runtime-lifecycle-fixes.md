---
"@nylorun/runtime": patch
---

**Runtime lifecycle fixes.**

- **Stream relay.** Stopping the relay while its change source was still preparing the replication slot no longer hangs shutdown with the slot held.
- **MCP connections.** A connection a session has not used for 15 minutes is closed by the Tenant sweep, and the next call opens it again, as after a restart. Before, every stdio MCP server a session started kept running until the Tenant closed. Concurrent calls to a server that is not connected now share one connection instead of each opening one and leaking all but the last.
- **Tenant close.** Every close step runs even when an earlier one fails, so a failing MCP or sandbox close no longer leaves the stream readers, the relay and the store open. The first error is still rethrown, and each failed step is logged as `tenant close step failed`.
