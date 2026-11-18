---
"@nylorun/agents": minor
---

`session.observe()` (and `client.runs.stream()`) no longer reconnects silently forever to a stream that keeps closing with nothing on it. When `maxEmptyConnections` connections in a row (default 5, `SSE_MAX_EMPTY_CONNECTIONS`; `0` never gives up) answer and end with no event and no keepalive, it throws `SSEStreamClosedError`, with `connections` and the `cursor` it kept resuming from. A connection that sends a keepalive or an event resets the count, so a quiet session behind a proxy that closes idle connections is not affected. `SSEIdleTimeoutError` and `SSEStreamClosedError` are now exported.
