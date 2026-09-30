---
"@nylorun/runtime": patch
---

**HTTP fixes ahead of the move to Hono.**

- **Shutdown no longer waits for open streams.** Stopping the Runtime used to wait for every session-event, executor and AG-UI stream client to disconnect. It now ends open streams (clients see the stream end and reconnect), lets other requests in progress finish, and closes any connection still open after 10 seconds (`host_shutdown_forced` in the log).
- **Sandbox tool calls stop when their caller leaves.** `POST /v1/sessions/:id/sandbox/:tool` and `POST /v1/actions/:id/sandbox/:tool` now see the client disconnect. Before, the abort signal never fired once the request body had been read.
- **Multibyte request bodies.** A UTF-8 character whose bytes arrive in different chunks is no longer corrupted.
- **Malformed paths.** A path with invalid percent-encoding (such as `%E0%A4%A`) is `400 request_rejected` "Malformed path", not `500`.
- **Failures after a response started.** When a Tenant fails after starting its response, the Host ends that response instead of trying to send a second one.
- **Listener errors** after the Runtime starts listening are logged (`listener_error`) instead of being dropped.
