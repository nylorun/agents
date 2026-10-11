---
"@nylorun/core": minor
"@nylorun/runtime": minor
---

**Every connection a pod Environment makes to the internet is on the record (R7, egress events).** egress-gate used to keep only log lines, so a session's log could not say which hosts its turn reached or what the gate refused. Now each connection through egress-gate is one event, written by the gate itself.

- **`egress.connection`** in the session log of the turn that held the Environment when the connection opened, with that turn's id even if the turn has ended by the time it closes. Source `egress-gate`, evidence `observed`.
- **`environment.egress`**, the same payload, on the Environment's own stream (`GET /v1/environments/{id}/events`) for traffic while no turn holds the Environment.
- **The payload:** `environmentId`, `host`, `port`, `outcome` (`allowed` or `refused`), `reason` and `status` for a refusal, `mode` (`tunnel` or `credential`), `credentialBound`, `bytesUp` and `bytesDown`, `startedAt` (the gate's clock at CONNECT) and `durationMs`. A host a shell credential is bound to adds `requests` and the `credentialIds` the gate set. It never carries a header value, a URL path or a body.
- **One event per connection:** written when it closes, or at once when the gate refuses it (a host not in `network.allowedHosts`, a port other than 443 or 80, a private address, too many tunnels, a name that does not resolve). A refusal before the Environment is known (no token, an expired or stale one) stays a log line only.
- **Never in the way:** a write happens after the connection closes or is answered, and a failed write is logged as `egress_record_failed` without touching the tunnel. The gateway's `egress_refused` and `egress_terminated` log lines stay.
